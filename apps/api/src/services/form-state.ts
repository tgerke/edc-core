import type { MetaDataVersion } from "@edc-core/odm";
import {
  compileDerivations,
  evaluateFormState,
  type FormStateResult,
  fieldKey,
  type ItemValueRow,
} from "@edc-core/rules";
import { eq, sql } from "drizzle-orm";
import { appendItemValue } from "../db/audit.js";
import type { Db } from "../db/client.js";
import { studyMetadataVersions } from "../db/schema/index.js";
import { CaptureError, type FormContext } from "./capture.js";
import { type CheckFinding, evaluateFormChecks } from "./checks.js";
import type { StudyBuildDefinition } from "./study-builds.js";

/** Reason recorded on automatic derivation rewrites (audit requires one). */
const DERIVATION_REASON = "derived: source data changed";

export interface FormState {
  mdv: MetaDataVersion;
  rows: ItemValueRow[];
  state: FormStateResult;
}

/**
 * The form's dynamic state as the server sees it: pinned build + current
 * stored values, run through the shared rules pipeline (ADR-0014). The same
 * evaluation runs client-side for instant feedback; this copy is the truth.
 */
export async function loadFormState(db: Db, context: FormContext): Promise<FormState | null> {
  const [mdvRow] = await db
    .select({ definition: studyMetadataVersions.definition })
    .from(studyMetadataVersions)
    .where(eq(studyMetadataVersions.id, context.metadataVersionId))
    .limit(1);
  if (!mdvRow) return null;
  const mdv = (mdvRow.definition as unknown as StudyBuildDefinition).metaDataVersion;

  const valueRows = await db.execute<{
    item_group_oid: string;
    item_group_repeat_key: number;
    item_oid: string;
    value: string | null;
  }>(
    sql`SELECT item_group_oid, item_group_repeat_key, item_oid, value
        FROM item_values_current
        WHERE form_instance_id = ${context.formInstanceId}`,
  );
  const rows: ItemValueRow[] = valueRows.map((row) => ({
    itemGroupOid: row.item_group_oid,
    itemGroupRepeatKey: row.item_group_repeat_key,
    itemOid: row.item_oid,
    value: row.value,
  }));

  return { mdv, rows, state: await evaluateFormState(mdv, rows) };
}

/**
 * Gate for every intake path (route write, RTSM, lab import): rejects writes
 * to derived items (system-written only), writes into fields not collected
 * under the current responses (clearing to null stays allowed — that is how
 * a site resolves a skip-residual query), and code list values currently
 * excluded for the field.
 */
export function assertWriteAllowed(
  formState: FormState,
  write: {
    itemGroupOid: string;
    itemGroupRepeatKey?: number | undefined;
    itemOid: string;
    value: string | null;
  },
): void {
  const { mdv, state } = formState;
  const derivedTargets = new Set(
    compileDerivations(mdv).map((d) => `${d.itemGroupOid}:${d.itemOid}`),
  );
  if (derivedTargets.has(`${write.itemGroupOid}:${write.itemOid}`)) {
    throw new CaptureError(
      "invalid",
      `"${write.itemOid}" is a derived item: its value is computed, not entered`,
    );
  }
  const key = fieldKey(write.itemGroupOid, write.itemGroupRepeatKey ?? 1, write.itemOid);
  if (write.value !== null && state.skippedFields.has(key)) {
    throw new CaptureError(
      "invalid",
      `"${write.itemOid}" is not collected under the current responses; clear the value or revisit the controlling answer`,
    );
  }
  if (write.value !== null && state.excludedOptions.get(key)?.has(write.value)) {
    throw new CaptureError(
      "invalid",
      `option "${write.value}" is not available for "${write.itemOid}" under the current responses`,
    );
  }
}

/**
 * Recomputes every derivation from stored values and appends the changes as
 * system writes (origin "derivation", action item_value.derived). A derived
 * value that was never stored and computes to null is not written — nothing
 * to record. Attribution follows the lab-import pattern: the actor is
 * whoever's write triggered recomputation.
 */
export async function applyDerivations(
  db: Db,
  context: FormContext,
  actorId: string,
): Promise<void> {
  const loaded = await loadFormState(db, context);
  if (!loaded) return;
  const stored = new Map(
    loaded.rows.map((row) => [
      fieldKey(row.itemGroupOid, row.itemGroupRepeatKey, row.itemOid),
      row.value,
    ]),
  );
  for (const entry of loaded.state.derived) {
    const key = fieldKey(entry.itemGroupOid, entry.itemGroupRepeatKey, entry.itemOid);
    const existing = stored.get(key);
    if (existing === undefined && entry.value === null) continue;
    if (existing === entry.value) continue;
    await appendItemValue(db, {
      formInstanceId: context.formInstanceId,
      studyId: context.studyId,
      itemGroupOid: entry.itemGroupOid,
      itemGroupRepeatKey: entry.itemGroupRepeatKey,
      itemOid: entry.itemOid,
      value: entry.value,
      actorId,
      origin: "derivation",
      ...(existing !== undefined ? { reasonForChange: DERIVATION_REASON } : {}),
    });
  }
}

/**
 * The post-write sequence for every accepted data change: derivations first
 * (their results feed the checks), then check/residual query reconciliation.
 */
export async function runPostWritePipeline(
  db: Db,
  context: FormContext,
  actorId: string,
): Promise<CheckFinding[]> {
  await applyDerivations(db, context, actorId);
  return evaluateFormChecks(db, context, actorId);
}
