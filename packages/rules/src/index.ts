/**
 * Edit-check expression engine (ADR-0007).
 *
 * Checks are ODM ConditionDefs carrying a FormalExpression with
 * Context "jsonata". A check FIRES (raises a query) when its expression
 * evaluates to true against the form's item values — the expression
 * describes the data problem, mirroring ODM condition semantics.
 * ConditionDefs referenced as CollectionExceptionConditions are collection
 * logic, not edit checks, and are excluded.
 *
 * Item values are keyed by ItemDef OID (quote in expressions: `IT.VS.SYSBP`)
 * and coerced per the ItemDef DataType before evaluation. Evaluation is
 * side-effect-free and identical in the browser and on the server; the
 * server remains the source of truth.
 */
import { displayText, type MetaDataVersion } from "@edc-core/odm";
import jsonata from "jsonata";

/** Item values visible to an edit check, keyed by ItemDef OID. */
export type RuleContext = Readonly<Record<string, string | number | boolean | null>>;

export interface RuleResult {
  /** True when the check found a data problem (query should be raised). */
  fired: boolean;
  message: string;
  /** Set when the expression itself could not be evaluated. */
  error?: string;
}

export interface CompiledCheck {
  oid: string;
  expression: string;
  message: string;
  evaluate(context: RuleContext): Promise<RuleResult>;
}

export const JSONATA_CONTEXT = "jsonata";

export function compileCheck(input: {
  oid: string;
  expression: string;
  message: string;
}): CompiledCheck {
  let compiled: ReturnType<typeof jsonata> | null = null;
  let compileError: string | null = null;
  try {
    compiled = jsonata(input.expression);
  } catch (err) {
    compileError = (err as Error).message;
  }

  return {
    ...input,
    async evaluate(context) {
      if (!compiled) {
        return {
          fired: false,
          message: input.message,
          error: `invalid expression: ${compileError}`,
        };
      }
      try {
        const result: unknown = await compiled.evaluate(context);
        return { fired: result === true, message: input.message };
      } catch (err) {
        return { fired: false, message: input.message, error: (err as Error).message };
      }
    },
  };
}

/** ConditionDefs referenced as collection logic at any level (item, group, or
 *  code list option): never edit checks. */
function collectionExceptionConditionOids(mdv: MetaDataVersion): Set<string> {
  return new Set(
    [
      ...mdv.itemGroupDefs.flatMap((group) => group.itemRefs),
      ...mdv.itemGroupDefs.flatMap((group) => group.itemGroupRefs),
      ...mdv.studyEventDefs.flatMap((se) => se.itemGroupRefs),
      ...mdv.codeLists.flatMap((cl) => cl.items),
    ]
      .map((ref) => ref.collectionExceptionConditionOid)
      .filter((oid): oid is string => oid !== undefined),
  );
}

/** Extract the edit checks defined in a study build. */
export function compileEditChecks(mdv: MetaDataVersion): CompiledCheck[] {
  const collectionExceptionOids = collectionExceptionConditionOids(mdv);

  const checks: CompiledCheck[] = [];
  for (const condition of mdv.conditionDefs) {
    if (collectionExceptionOids.has(condition.oid)) continue;
    const expression = condition.formalExpressions.find((e) => e.context === JSONATA_CONTEXT)?.code;
    if (!expression) continue;
    checks.push(
      compileCheck({
        oid: condition.oid,
        expression,
        message: displayText(condition.description) ?? condition.name,
      }),
    );
  }
  return checks;
}

/** Coerce raw string values (as stored) per ItemDef DataType for evaluation. */
export function buildRuleContext(
  mdv: MetaDataVersion,
  values: Record<string, string | null>,
): RuleContext {
  const dataTypes = new Map(mdv.itemDefs.map((item) => [item.oid, item.dataType]));
  const context: Record<string, string | number | boolean | null> = {};
  for (const [itemOid, raw] of Object.entries(values)) {
    if (raw === null || raw === "") {
      context[itemOid] = null;
      continue;
    }
    switch (dataTypes.get(itemOid)) {
      case "integer":
      case "float":
      case "double":
      case "decimal": {
        const parsed = Number(raw);
        context[itemOid] = Number.isNaN(parsed) ? raw : parsed;
        break;
      }
      case "boolean":
        context[itemOid] = raw === "true" || raw === "1";
        break;
      default:
        context[itemOid] = raw;
    }
  }
  return context;
}

export async function runChecks(
  checks: CompiledCheck[],
  context: RuleContext,
): Promise<Map<string, RuleResult>> {
  const results = new Map<string, RuleResult>();
  for (const check of checks) {
    results.set(check.oid, await check.evaluate(context));
  }
  return results;
}

/** One stored item value, addressed by group + occurrence (repeat key). */
export interface ItemValueRow {
  itemGroupOid: string;
  itemGroupRepeatKey: number;
  itemOid: string;
  value: string | null;
}

export interface OccurrenceFinding {
  checkOid: string;
  message: string;
  /** null = form-level; a number = fired for that repeating-group occurrence. */
  repeatKey: number | null;
}

/** Item groups whose values repeat per occurrence (Repeating != "No"). */
export function repeatingGroupOids(mdv: MetaDataVersion): Set<string> {
  return new Set(
    mdv.itemGroupDefs
      .filter((g) => g.repeating !== undefined && g.repeating !== "No")
      .map((g) => g.oid),
  );
}

/**
 * Repeat-aware check evaluation, identical in the browser and on the server.
 *
 * Values in non-repeating groups form the base context; checks that fire
 * against it alone are form-level findings (repeatKey null). Each occurrence
 * of a repeating group is then evaluated as base + that occurrence's values;
 * checks that fire there but not at form level are per-occurrence findings.
 */
interface RowBuckets {
  /** Values from non-repeating groups, shared by every context. */
  base: Record<string, string | null>;
  /** Values per repeating-group occurrence, keyed by repeat key. */
  byOccurrence: Map<number, Record<string, string | null>>;
  /** Repeat keys present per repeating group. */
  occurrencesByGroup: Map<string, Set<number>>;
}

function bucketRows(mdv: MetaDataVersion, rows: ItemValueRow[]): RowBuckets {
  const repeating = repeatingGroupOids(mdv);
  const base: Record<string, string | null> = {};
  const byOccurrence = new Map<number, Record<string, string | null>>();
  const occurrencesByGroup = new Map<string, Set<number>>();
  for (const row of rows) {
    if (repeating.has(row.itemGroupOid)) {
      let occurrence = byOccurrence.get(row.itemGroupRepeatKey);
      if (!occurrence) {
        occurrence = {};
        byOccurrence.set(row.itemGroupRepeatKey, occurrence);
      }
      occurrence[row.itemOid] = row.value;
      let keys = occurrencesByGroup.get(row.itemGroupOid);
      if (!keys) {
        keys = new Set();
        occurrencesByGroup.set(row.itemGroupOid, keys);
      }
      keys.add(row.itemGroupRepeatKey);
    } else {
      base[row.itemOid] = row.value;
    }
  }
  return { base, byOccurrence, occurrencesByGroup };
}

export async function runChecksOverRows(
  checks: CompiledCheck[],
  mdv: MetaDataVersion,
  rows: ItemValueRow[],
): Promise<OccurrenceFinding[]> {
  if (checks.length === 0) return [];
  const { base, byOccurrence } = bucketRows(mdv, rows);
  return checksOverBuckets(checks, mdv, base, byOccurrence);
}

async function checksOverBuckets(
  checks: CompiledCheck[],
  mdv: MetaDataVersion,
  base: Record<string, string | null>,
  byOccurrence: Map<number, Record<string, string | null>>,
): Promise<OccurrenceFinding[]> {
  const findings: OccurrenceFinding[] = [];
  const baseResults = await runChecks(checks, buildRuleContext(mdv, base));
  const firedAtFormLevel = new Set<string>();
  for (const [oid, result] of baseResults) {
    if (result.fired) {
      firedAtFormLevel.add(oid);
      findings.push({ checkOid: oid, message: result.message, repeatKey: null });
    }
  }

  for (const key of [...byOccurrence.keys()].sort((a, b) => a - b)) {
    const context = buildRuleContext(mdv, { ...base, ...byOccurrence.get(key) });
    const results = await runChecks(checks, context);
    for (const [oid, result] of results) {
      if (result.fired && !firedAtFormLevel.has(oid)) {
        findings.push({ checkOid: oid, message: result.message, repeatKey: key });
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Dynamic form state (ADR-0014): derivations (MethodDef), collection
// exceptions (skip logic), dependent options, and skip-aware edit checks.
// Evaluation order: derive → skip → null skipped values (context only) →
// option exclusions → edit checks. Derivations see raw (pre-skip) values;
// skip conditions see derived values — one-way ordering, no circularity.
// ---------------------------------------------------------------------------

/** Address of one field occurrence: `${groupOid}:${repeatKey}:${itemOid}`.
 *  Non-repeating groups use repeat key 1. */
export function fieldKey(groupOid: string, repeatKey: number, itemOid: string): string {
  return `${groupOid}:${repeatKey}:${itemOid}`;
}

/** Synthetic checkOid namespace for skip-residual queries; cannot collide
 *  with ConditionDef OIDs used as edit checks (those are excluded from the
 *  namespace by convention: SKIP.<conditionOid>.<itemOid>). */
export const SKIP_CHECK_PREFIX = "SKIP.";

export function skipCheckOid(conditionOid: string, itemOid: string): string {
  return `${SKIP_CHECK_PREFIX}${conditionOid}.${itemOid}`;
}

/** A stored value persisting in a field not collected under current
 *  responses: the site must clear it (audited) or change the controlling
 *  answer. Raised as a system query, never auto-deleted. */
export interface SkipResidualFinding {
  checkOid: string;
  conditionOid: string;
  itemGroupOid: string;
  itemOid: string;
  /** null = non-repeating group; a number = that occurrence. */
  repeatKey: number | null;
  message: string;
}

export interface FormStateResult {
  /** Edit-check findings, evaluated with skipped fields nulled out. */
  findings: OccurrenceFinding[];
  /** Computed value for every derived field occurrence (null when its
   *  inputs are missing, the expression fails, or the field is skipped). */
  derived: ItemValueRow[];
  /** Field occurrences not collected under current responses (fieldKey). */
  skippedFields: Set<string>;
  /** Excluded code list options per field occurrence (fieldKey → values). */
  excludedOptions: Map<string, Set<string>>;
  /** Stored values persisting in skipped fields. */
  residuals: SkipResidualFinding[];
}

interface CompiledExpression {
  evaluate(context: RuleContext): Promise<unknown>;
}

/** Compile once, evaluate defensively: any failure yields undefined. */
function compileExpression(code: string): CompiledExpression {
  let compiled: ReturnType<typeof jsonata> | null = null;
  try {
    compiled = jsonata(code);
  } catch {
    compiled = null;
  }
  return {
    async evaluate(context) {
      if (!compiled) return undefined;
      try {
        return await compiled.evaluate(context);
      } catch {
        return undefined;
      }
    },
  };
}

/** Item OIDs an expression reads, by substring scan — the ADR-0007
 *  backtick-quoted-OID convention, same approach as the blinded-reference
 *  validator warning. */
export function extractItemDependencies(code: string, itemOids: Iterable<string>): string[] {
  return [...itemOids].filter((oid) => code.includes(oid));
}

function jsonataCode(def: {
  formalExpressions: { context?: string | undefined; code: string }[];
}): string | undefined {
  return def.formalExpressions.find((e) => e.context === JSONATA_CONTEXT)?.code;
}

export interface CompiledDerivation {
  itemGroupOid: string;
  itemOid: string;
  methodOid: string;
  expression: string;
  /** Computed value as stored (string), or null when incomputable. */
  evaluate(context: RuleContext): Promise<string | null>;
}

/** Values are stored as strings; buildRuleContext re-coerces on read. */
function stringifyDerived(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "number":
      return Number.isFinite(value) ? String(value) : null;
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return value;
    default:
      return null;
  }
}

/**
 * Derivations in evaluation order: an item derived from another derived
 * item computes after it. Members of a dependency cycle are dropped
 * defensively (publish-time validation reports the cycle as an error).
 */
export function compileDerivations(mdv: MetaDataVersion): CompiledDerivation[] {
  const methods = new Map(mdv.methodDefs.map((m) => [m.oid, m]));
  const entries: Omit<CompiledDerivation, "evaluate">[] = [];
  for (const group of mdv.itemGroupDefs) {
    for (const ref of group.itemRefs) {
      if (!ref.methodOid) continue;
      const method = methods.get(ref.methodOid);
      const expression = method ? jsonataCode(method) : undefined;
      if (expression === undefined) continue;
      entries.push({
        itemGroupOid: group.oid,
        itemOid: ref.itemOid,
        methodOid: ref.methodOid,
        expression,
      });
    }
  }

  const derivedOids = new Set(entries.map((e) => e.itemOid));
  const deps = new Map<string, Set<string>>();
  for (const e of entries) {
    let set = deps.get(e.itemOid);
    if (!set) {
      set = new Set();
      deps.set(e.itemOid, set);
    }
    for (const oid of extractItemDependencies(e.expression, derivedOids)) {
      if (oid !== e.itemOid) set.add(oid);
    }
  }

  const rank = new Map<string, number>();
  const remaining = new Map(deps);
  while (remaining.size > 0) {
    const ready = [...remaining.keys()].filter(
      (oid) => ![...(remaining.get(oid) ?? [])].some((dep) => remaining.has(dep)),
    );
    if (ready.length === 0) break; // remainder is cyclic: drop it
    for (const oid of ready) {
      rank.set(oid, rank.size);
      remaining.delete(oid);
    }
  }

  return entries
    .filter((e) => rank.has(e.itemOid))
    .sort((a, b) => (rank.get(a.itemOid) ?? 0) - (rank.get(b.itemOid) ?? 0))
    .map((e) => {
      const compiled = compileExpression(e.expression);
      return {
        ...e,
        async evaluate(context: RuleContext) {
          return stringifyDerived(await compiled.evaluate(context));
        },
      };
    });
}

export interface CompiledCondition {
  conditionOid: string;
  /** True = the exception applies (not collected / option excluded). */
  evaluate(context: RuleContext): Promise<boolean>;
}

export interface CollectionExceptions {
  /** groupOid → itemOid → condition (ItemRef-level skip). */
  itemLevel: Map<string, Map<string, CompiledCondition>>;
  /** target groupOid → conditions from referencing ItemGroupRefs (any true
   *  skips the group and its descendants). StudyEventDef-level refs are
   *  scheduling, not form state, and are not honored here. */
  groupLevel: Map<string, CompiledCondition[]>;
  /** codeListOid → codedValue → condition (option excluded when true). */
  optionLevel: Map<string, Map<string, CompiledCondition>>;
}

export function collectionExceptions(mdv: MetaDataVersion): CollectionExceptions {
  const conditions = new Map(mdv.conditionDefs.map((c) => [c.oid, c]));
  const compiledByOid = new Map<string, CompiledCondition>();
  const compile = (conditionOid: string): CompiledCondition | undefined => {
    const cached = compiledByOid.get(conditionOid);
    if (cached) return cached;
    const def = conditions.get(conditionOid);
    const code = def ? jsonataCode(def) : undefined;
    if (code === undefined) return undefined;
    const expression = compileExpression(code);
    const compiled: CompiledCondition = {
      conditionOid,
      async evaluate(context) {
        return (await expression.evaluate(context)) === true;
      },
    };
    compiledByOid.set(conditionOid, compiled);
    return compiled;
  };

  const itemLevel = new Map<string, Map<string, CompiledCondition>>();
  const groupLevel = new Map<string, CompiledCondition[]>();
  for (const group of mdv.itemGroupDefs) {
    for (const ref of group.itemRefs) {
      if (!ref.collectionExceptionConditionOid) continue;
      const condition = compile(ref.collectionExceptionConditionOid);
      if (!condition) continue;
      let perItem = itemLevel.get(group.oid);
      if (!perItem) {
        perItem = new Map();
        itemLevel.set(group.oid, perItem);
      }
      perItem.set(ref.itemOid, condition);
    }
    for (const ref of group.itemGroupRefs) {
      if (!ref.collectionExceptionConditionOid) continue;
      const condition = compile(ref.collectionExceptionConditionOid);
      if (!condition) continue;
      groupLevel.set(ref.itemGroupOid, [...(groupLevel.get(ref.itemGroupOid) ?? []), condition]);
    }
  }

  const optionLevel = new Map<string, Map<string, CompiledCondition>>();
  for (const codeList of mdv.codeLists) {
    for (const item of codeList.items) {
      if (!item.collectionExceptionConditionOid) continue;
      const condition = compile(item.collectionExceptionConditionOid);
      if (!condition) continue;
      let perValue = optionLevel.get(codeList.oid);
      if (!perValue) {
        perValue = new Map();
        optionLevel.set(codeList.oid, perValue);
      }
      perValue.set(item.codedValue, condition);
    }
  }

  return { itemLevel, groupLevel, optionLevel };
}

/** Groups reachable from `oid` through ItemGroupRef edges (excluding `oid`). */
function descendantGroups(mdv: MetaDataVersion, oid: string): Set<string> {
  const byOid = new Map(mdv.itemGroupDefs.map((g) => [g.oid, g]));
  const found = new Set<string>();
  const queue = [oid];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) break;
    for (const ref of byOid.get(current)?.itemGroupRefs ?? []) {
      if (found.has(ref.itemGroupOid) || ref.itemGroupOid === oid) continue;
      found.add(ref.itemGroupOid);
      queue.push(ref.itemGroupOid);
    }
  }
  return found;
}

function residualMessage(itemName: string): string {
  return `"${itemName}" has a value but is not collected under the current responses: clear it or revisit the controlling answer`;
}

/**
 * Every skip-residual check OID a build can produce, with its display
 * message — lets a client render readable text for open SKIP.* queries
 * without re-deriving the addressing scheme.
 */
export function skipResidualMessages(mdv: MetaDataVersion): Map<string, string> {
  const itemNames = new Map(mdv.itemDefs.map((i) => [i.oid, i.name]));
  const groupsByOid = new Map(mdv.itemGroupDefs.map((g) => [g.oid, g]));
  const message = (itemOid: string) => residualMessage(itemNames.get(itemOid) ?? itemOid);
  const map = new Map<string, string>();
  for (const group of mdv.itemGroupDefs) {
    for (const ref of group.itemRefs) {
      if (!ref.collectionExceptionConditionOid) continue;
      map.set(skipCheckOid(ref.collectionExceptionConditionOid, ref.itemOid), message(ref.itemOid));
    }
    for (const ref of group.itemGroupRefs) {
      if (!ref.collectionExceptionConditionOid) continue;
      for (const groupOid of [ref.itemGroupOid, ...descendantGroups(mdv, ref.itemGroupOid)]) {
        for (const itemRef of groupsByOid.get(groupOid)?.itemRefs ?? []) {
          map.set(
            skipCheckOid(ref.collectionExceptionConditionOid, itemRef.itemOid),
            message(itemRef.itemOid),
          );
        }
      }
    }
  }
  return map;
}

/**
 * Full dynamic state of a form's data, byte-identical in the browser and on
 * the server (the ADR-0007 dual-evaluation pattern). Occurrence handling
 * matches runChecksOverRows: non-repeating groups form the base context;
 * each repeating occurrence evaluates as base + that occurrence's values.
 *
 * All skip conditions are evaluated against the post-derivation contexts in
 * a single pass — a skip condition reading another skipped field sees its
 * value, not null (no cascading re-evaluation).
 */
export async function evaluateFormState(
  mdv: MetaDataVersion,
  rows: ItemValueRow[],
): Promise<FormStateResult> {
  const repeating = repeatingGroupOids(mdv);
  const { base, byOccurrence, occurrencesByGroup } = bucketRows(mdv, rows);
  const occurrenceKeys = (groupOid: string): number[] =>
    [...(occurrencesByGroup.get(groupOid) ?? [])].sort((a, b) => a - b);
  const baseContext = () => buildRuleContext(mdv, base);
  const occurrenceContext = (key: number) =>
    buildRuleContext(mdv, { ...base, ...byOccurrence.get(key) });

  // 1. Derivations, in dependency order, over raw values; each computed
  //    value is visible to later derivations, conditions, and checks.
  const derived: ItemValueRow[] = [];
  for (const derivation of compileDerivations(mdv)) {
    if (repeating.has(derivation.itemGroupOid)) {
      for (const key of occurrenceKeys(derivation.itemGroupOid)) {
        const value = await derivation.evaluate(occurrenceContext(key));
        const occurrence = byOccurrence.get(key);
        if (occurrence) occurrence[derivation.itemOid] = value;
        derived.push({
          itemGroupOid: derivation.itemGroupOid,
          itemGroupRepeatKey: key,
          itemOid: derivation.itemOid,
          value,
        });
      }
    } else {
      const value = await derivation.evaluate(baseContext());
      base[derivation.itemOid] = value;
      derived.push({
        itemGroupOid: derivation.itemGroupOid,
        itemGroupRepeatKey: 1,
        itemOid: derivation.itemOid,
        value,
      });
    }
  }

  // 2. Collection exceptions. Group-level skips propagate to descendant
  //    groups; an occurrence-scoped skip of a repeating group propagates
  //    only to repeating descendants at the same occurrence (a non-repeating
  //    descendant under an occurrence skip stays collected — when in doubt,
  //    collect).
  const exceptions = collectionExceptions(mdv);
  const skippedFields = new Set<string>();
  const skipCause = new Map<string, string>();
  const groupsByOid = new Map(mdv.itemGroupDefs.map((g) => [g.oid, g]));

  const markField = (groupOid: string, repeatKey: number, itemOid: string, causeOid: string) => {
    const key = fieldKey(groupOid, repeatKey, itemOid);
    skippedFields.add(key);
    if (!skipCause.has(key)) skipCause.set(key, causeOid);
  };
  const markGroup = (groupOid: string, repeatKey: number | null, causeOid: string) => {
    const group = groupsByOid.get(groupOid);
    if (!group) return;
    const keys =
      repeatKey !== null ? [repeatKey] : repeating.has(groupOid) ? occurrenceKeys(groupOid) : [1];
    for (const key of keys) {
      for (const ref of group.itemRefs) markField(groupOid, key, ref.itemOid, causeOid);
    }
    for (const descendant of descendantGroups(mdv, groupOid)) {
      if (repeatKey !== null && !repeating.has(descendant)) continue;
      const descendantKeys =
        repeatKey !== null
          ? [repeatKey]
          : repeating.has(descendant)
            ? occurrenceKeys(descendant)
            : [1];
      for (const key of descendantKeys) {
        for (const ref of groupsByOid.get(descendant)?.itemRefs ?? []) {
          markField(descendant, key, ref.itemOid, causeOid);
        }
      }
    }
  };

  for (const [groupOid, conditions] of exceptions.groupLevel) {
    if (repeating.has(groupOid)) {
      for (const key of occurrenceKeys(groupOid)) {
        for (const condition of conditions) {
          if (await condition.evaluate(occurrenceContext(key))) {
            markGroup(groupOid, key, condition.conditionOid);
          }
        }
      }
    } else {
      for (const condition of conditions) {
        if (await condition.evaluate(baseContext())) {
          markGroup(groupOid, null, condition.conditionOid);
        }
      }
    }
  }

  for (const [groupOid, perItem] of exceptions.itemLevel) {
    if (repeating.has(groupOid)) {
      for (const key of occurrenceKeys(groupOid)) {
        const context = occurrenceContext(key);
        for (const [itemOid, condition] of perItem) {
          if (await condition.evaluate(context))
            markField(groupOid, key, itemOid, condition.conditionOid);
        }
      }
    } else {
      const context = baseContext();
      for (const [itemOid, condition] of perItem) {
        if (await condition.evaluate(context))
          markField(groupOid, 1, itemOid, condition.conditionOid);
      }
    }
  }

  // 3. Null skipped values in the evaluation contexts only — stored data is
  //    never touched (retain-and-flag). Residuals report stored values that
  //    persist in skipped fields; skipped derived fields converge to null
  //    through the derivation write path instead, so they are not residuals.
  const storedByFieldKey = new Map<string, string | null>();
  for (const row of rows) {
    const key = repeating.has(row.itemGroupOid) ? row.itemGroupRepeatKey : 1;
    storedByFieldKey.set(fieldKey(row.itemGroupOid, key, row.itemOid), row.value);
  }
  const derivedFieldKeys = new Set(
    derived.map((d) => fieldKey(d.itemGroupOid, d.itemGroupRepeatKey, d.itemOid)),
  );
  const itemNames = new Map(mdv.itemDefs.map((i) => [i.oid, i.name]));
  const residuals: SkipResidualFinding[] = [];
  for (const key of skippedFields) {
    const [groupOid = "", repeatText = "1", itemOid = ""] = key.split(":");
    const repeatKey = Number(repeatText);
    if (repeating.has(groupOid)) {
      const occurrence = byOccurrence.get(repeatKey);
      if (occurrence && itemOid in occurrence) occurrence[itemOid] = null;
    } else if (itemOid in base) {
      base[itemOid] = null;
    }
    if (derivedFieldKeys.has(key)) {
      const entry = derived.find(
        (d) => fieldKey(d.itemGroupOid, d.itemGroupRepeatKey, d.itemOid) === key,
      );
      if (entry) entry.value = null;
      continue;
    }
    const stored = storedByFieldKey.get(key);
    if (stored === undefined || stored === null || stored === "") continue;
    const conditionOid = skipCause.get(key) ?? "";
    residuals.push({
      checkOid: skipCheckOid(conditionOid, itemOid),
      conditionOid,
      itemGroupOid: groupOid,
      itemOid,
      repeatKey: repeating.has(groupOid) ? repeatKey : null,
      message: residualMessage(itemNames.get(itemOid) ?? itemOid),
    });
  }

  // 4. Option exclusions, against the final (derived + skip-nulled) contexts.
  const excludedOptions = new Map<string, Set<string>>();
  const itemsByOid = new Map(mdv.itemDefs.map((i) => [i.oid, i]));
  for (const group of mdv.itemGroupDefs) {
    for (const ref of group.itemRefs) {
      const item = itemsByOid.get(ref.itemOid);
      const perValue = item?.codeListRef
        ? exceptions.optionLevel.get(item.codeListRef.codeListOid)
        : undefined;
      if (!perValue || perValue.size === 0) continue;
      const contexts: [number, RuleContext][] = repeating.has(group.oid)
        ? occurrenceKeys(group.oid).map((key) => [key, occurrenceContext(key)])
        : [[1, baseContext()]];
      for (const [key, context] of contexts) {
        for (const [codedValue, condition] of perValue) {
          if (!(await condition.evaluate(context))) continue;
          const target = fieldKey(group.oid, key, ref.itemOid);
          let set = excludedOptions.get(target);
          if (!set) {
            set = new Set();
            excludedOptions.set(target, set);
          }
          set.add(codedValue);
        }
      }
    }
  }

  // 5. Edit checks over the final contexts: skipped fields cannot fire them.
  const findings = await checksOverBuckets(compileEditChecks(mdv), mdv, base, byOccurrence);

  return { findings, derived, skippedFields, excludedOptions, residuals };
}
