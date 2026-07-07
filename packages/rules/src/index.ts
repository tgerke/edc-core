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

/** Extract the edit checks defined in a study build. */
export function compileEditChecks(mdv: MetaDataVersion): CompiledCheck[] {
  const collectionExceptionOids = new Set(
    mdv.itemGroupDefs
      .flatMap((group) => group.itemRefs)
      .map((ref) => ref.collectionExceptionConditionOid)
      .filter((oid): oid is string => oid !== undefined),
  );

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
export async function runChecksOverRows(
  checks: CompiledCheck[],
  mdv: MetaDataVersion,
  rows: ItemValueRow[],
): Promise<OccurrenceFinding[]> {
  if (checks.length === 0) return [];
  const repeating = repeatingGroupOids(mdv);

  const base: Record<string, string | null> = {};
  const byOccurrence = new Map<number, Record<string, string | null>>();
  for (const row of rows) {
    if (repeating.has(row.itemGroupOid)) {
      let occurrence = byOccurrence.get(row.itemGroupRepeatKey);
      if (!occurrence) {
        occurrence = {};
        byOccurrence.set(row.itemGroupRepeatKey, occurrence);
      }
      occurrence[row.itemOid] = row.value;
    } else {
      base[row.itemOid] = row.value;
    }
  }

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
