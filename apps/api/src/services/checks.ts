import { buildRuleContext, compileEditChecks, runChecks } from "@edc-core/rules";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { auditEvents, queries, studyMetadataVersions } from "../db/schema/index.js";
import type { FormContext } from "./capture.js";
import type { StudyBuildDefinition } from "./study-builds.js";

export interface CheckFinding {
  checkOid: string;
  message: string;
}

/**
 * Evaluates the form's edit checks against its current values and reconciles
 * system queries: one open query per firing check, auto-closed when the data
 * problem is resolved. Runs after every accepted item write (E6-08 groundwork;
 * the manual query lifecycle lands in Phase 4).
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

  const checks = compileEditChecks(mdv);
  if (checks.length === 0) return [];

  // Latest value per item, flattened by item OID (repeat 1 semantics for now,
  // matching the entry UI).
  const valueRows = await db.execute<{ item_oid: string; value: string | null }>(
    sql`SELECT item_oid, value FROM item_values_current
        WHERE form_instance_id = ${context.formInstanceId}`,
  );
  const values: Record<string, string | null> = {};
  for (const row of valueRows) values[row.item_oid] = row.value;

  const results = await runChecks(checks, buildRuleContext(mdv, values));

  // "Active" includes answered: a site's answer must not let a still-failing
  // check open a duplicate query for the same problem.
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
  const openByCheck = new Map(activeSystemQueries.map((q) => [q.checkOid as string, q]));

  const findings: CheckFinding[] = [];
  for (const check of checks) {
    const result = results.get(check.oid);
    if (!result) continue;
    const open = openByCheck.get(check.oid);

    if (result.fired) {
      findings.push({ checkOid: check.oid, message: result.message });
      if (!open) {
        await db.transaction(async (tx) => {
          const [query] = await tx
            .insert(queries)
            .values({
              studyId: context.studyId,
              formInstanceId: context.formInstanceId,
              origin: "system",
              checkOid: check.oid,
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
            newValue: { origin: "system", checkOid: check.oid, message: result.message },
          });
        });
      }
    } else if (open) {
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
          newValue: { reason: "auto-resolved by data change", checkOid: check.oid },
        });
      });
    }
  }
  return findings;
}
