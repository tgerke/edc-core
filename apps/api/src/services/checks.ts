import { evaluateFormState, type ItemValueRow } from "@edc-core/rules";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { auditEvents, queries, studyMetadataVersions } from "../db/schema/index.js";
import type { FormContext } from "./capture.js";
import type { StudyBuildDefinition } from "./study-builds.js";

export interface CheckFinding {
  checkOid: string;
  message: string;
  /** null = form-level; a number = a specific repeating-group occurrence. */
  repeatKey: number | null;
}

/**
 * Evaluates the form's edit checks against its current values and reconciles
 * system queries: one open query per firing check, auto-closed when the data
 * problem is resolved. Runs after every accepted item write (E6-08 groundwork;
 * the manual query lifecycle lands in Phase 4).
 *
 * Skip-aware (ADR-0014): checks run with not-collected fields nulled out,
 * and a stored value persisting in a skipped field raises its own system
 * query under a synthetic SKIP.<condition>.<item> check OID, auto-closed
 * when the site clears the value or the controlling answer changes back.
 */
export async function evaluateFormChecks(
  db: Db,
  context: FormContext,
  actorId: string,
): Promise<CheckFinding[]> {
  const [mdvRow] = await db
    .select({ definition: studyMetadataVersions.definition })
    .from(studyMetadataVersions)
    .where(eq(studyMetadataVersions.id, context.metadataVersionId))
    .limit(1);
  if (!mdvRow) return [];
  const mdv = (mdvRow.definition as unknown as StudyBuildDefinition).metaDataVersion;

  // Latest value per (item, occurrence); the rules engine attributes each
  // finding either to the form or to a repeating-group occurrence.
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

  const state = await evaluateFormState(mdv, rows);
  const occurrenceFindings = [
    ...state.findings,
    ...state.residuals.map((residual) => ({
      checkOid: residual.checkOid,
      message: residual.message,
      repeatKey: residual.repeatKey,
    })),
  ];

  // "Active" includes answered: a site's answer must not let a still-failing
  // check open a duplicate query for the same problem. One query per
  // (check, occurrence); form-level findings carry a null repeat key.
  const activeSystemQueries = await db
    .select()
    .from(queries)
    .where(
      and(
        eq(queries.formInstanceId, context.formInstanceId),
        eq(queries.origin, "system"),
        inArray(queries.status, ["open", "answered"]),
        isNotNull(queries.checkOid),
      ),
    );
  const dedupeKey = (checkOid: string, repeatKey: number | null) =>
    `${checkOid}:${repeatKey ?? ""}`;
  const openByKey = new Map(
    activeSystemQueries.map((q) => [dedupeKey(q.checkOid as string, q.itemGroupRepeatKey), q]),
  );

  const findings: CheckFinding[] = [];
  const firedKeys = new Set<string>();
  for (const finding of occurrenceFindings) {
    findings.push({
      checkOid: finding.checkOid,
      message: finding.message,
      repeatKey: finding.repeatKey,
    });
    const key = dedupeKey(finding.checkOid, finding.repeatKey);
    firedKeys.add(key);
    if (!openByKey.has(key)) {
      await db.transaction(async (tx) => {
        const [query] = await tx
          .insert(queries)
          .values({
            studyId: context.studyId,
            formInstanceId: context.formInstanceId,
            origin: "system",
            checkOid: finding.checkOid,
            itemGroupRepeatKey: finding.repeatKey,
            openedBy: actorId,
          })
          .returning();
        if (!query) throw new Error("query insert returned no row");
        await tx.insert(auditEvents).values({
          actorId,
          studyId: context.studyId,
          action: "query.opened",
          entityType: "query",
          entityId: query.id,
          newValue: {
            origin: "system",
            checkOid: finding.checkOid,
            repeatKey: finding.repeatKey,
            message: finding.message,
          },
        });
      });
    }
  }

  for (const [key, open] of openByKey) {
    if (firedKeys.has(key)) continue;
    await db.transaction(async (tx) => {
      await tx
        .update(queries)
        .set({ status: "closed", closedAt: new Date() })
        .where(eq(queries.id, open.id));
      await tx.insert(auditEvents).values({
        actorId,
        studyId: context.studyId,
        action: "query.closed",
        entityType: "query",
        entityId: open.id,
        newValue: { reason: "auto-resolved by data change", checkOid: open.checkOid },
      });
    });
  }
  return findings;
}
