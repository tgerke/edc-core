/**
 * Edit-check expression engine.
 *
 * Requirements (see ADR-0004):
 * - side-effect free, sandboxed — expressions can read item values, never mutate
 * - identical evaluation client-side (instant feedback) and server-side (source of truth)
 * - serializable in study metadata (ODM FormalExpression)
 *
 * Phase 3 selects and integrates the expression language (CEL or JSONata).
 * This module currently establishes the evaluation contract.
 */

/** Item values visible to an edit check, keyed by ItemDef OID. */
export type RuleContext = Readonly<Record<string, string | number | boolean | null>>;

export interface RuleResult {
  passed: boolean;
  /** Message raised as a query when the check fails. */
  message: string;
}

export interface EditCheck {
  oid: string;
  expression: string;
  message: string;
  evaluate(context: RuleContext): RuleResult;
}
