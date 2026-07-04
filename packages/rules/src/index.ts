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
