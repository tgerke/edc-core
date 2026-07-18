import { type BuildDiff, diffMetaDataVersions, type MetaDataVersion } from "@edc-core/odm";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  auditEvents,
  formInstances,
  migrationRuns,
  studyEventInstances,
  studyMetadataVersions,
  subjects,
} from "../db/schema/index.js";
import { CaptureError, type FormStatus, resolveFormContext } from "./capture.js";
import { runPostWritePipeline } from "./form-state.js";
import type { StudyBuildDefinition } from "./study-builds.js";

/**
 * Mid-study amendment migration: re-points in-flight form instances to a
 * newer study build and re-runs their edit checks. Signed and locked forms
 * never migrate — their signature hashes bind to the pinned build; re-signing
 * after an amendment is an explicit, separate act (P11-09/P11-11).
 */

const MIGRATABLE_STATUSES: FormStatus[] = ["not_started", "in_progress", "complete", "verified"];
const BATCH_SIZE = 50;
const MAX_RECORDED_ERRORS = 50;

export async function loadBuild(db: Db, studyId: string, version: number) {
  const [row] = await db
    .select()
    .from(studyMetadataVersions)
    .where(
      and(eq(studyMetadataVersions.studyId, studyId), eq(studyMetadataVersions.version, version)),
    )
    .limit(1);
  if (!row) return null;
  return { ...row, mdv: (row.definition as unknown as StudyBuildDefinition).metaDataVersion };
}

export async function diffBuilds(
  db: Db,
  studyId: string,
  fromVersion: number,
  toVersion: number,
): Promise<BuildDiff | null> {
  const [from, to] = await Promise.all([
    loadBuild(db, studyId, fromVersion),
    loadBuild(db, studyId, toVersion),
  ]);
  if (!from || !to) return null;
  return diffMetaDataVersions(from.mdv, to.mdv);
}

/** All (itemGroupOid, itemOid) placements capture can store against. */
function placementSet(mdv: MetaDataVersion): Set<string> {
  const set = new Set<string>();
  for (const group of mdv.itemGroupDefs) {
    for (const ref of group.itemRefs) set.add(`${group.oid} ${ref.itemOid}`);
  }
  return set;
}

export function castable(value: string, dataType: string): boolean {
  switch (dataType) {
    case "integer":
      return /^[+-]?\d+$/.test(value.trim());
    case "float":
    case "double":
    case "decimal":
      return (
        !Number.isNaN(Number.parseFloat(value)) &&
        /^[+-]?\d*\.?\d+([eE][+-]?\d+)?$/.test(value.trim())
      );
    case "boolean":
      return /^(true|false|1|0)$/i.test(value.trim());
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
    case "datetime":
      return !Number.isNaN(Date.parse(value));
    default:
      return true; // text and friends accept anything
  }
}

export interface MigrationImpact {
  targetVersion: number;
  eligible: {
    total: number;
    byStatus: Partial<Record<FormStatus, number>>;
    byFromVersion: Record<number, number>;
  };
  excluded: { signed: number; locked: number };
  /** One diff per distinct pinned build among eligible forms. */
  diffs: { fromVersion: number; diff: BuildDiff }[];
  /** Captured values whose (group, item) placement no longer exists in the
   * target build: they stay in the audit trail but stop rendering. */
  orphanedValues: { itemGroupOid: string; itemOid: string; valueCount: number }[];
  /** Values that will not cast to the item's new data type. */
  typeConflicts: {
    itemGroupOid: string;
    itemOid: string;
    from: string;
    to: string;
    nonCastableCount: number;
  }[];
  /** Checks added or changed in the target: expect them to fire on migration. */
  checksAddedOrChanged: string[];
}

interface EligibleRow {
  formInstanceId: string;
  status: FormStatus;
  fromVersion: number;
}

async function eligibleForms(db: Db, studyId: string, targetId: string): Promise<EligibleRow[]> {
  const rows = await db
    .select({
      formInstanceId: formInstances.id,
      status: formInstances.status,
      fromVersion: studyMetadataVersions.version,
    })
    .from(formInstances)
    .innerJoin(studyEventInstances, eq(formInstances.studyEventInstanceId, studyEventInstances.id))
    .innerJoin(subjects, eq(studyEventInstances.subjectId, subjects.id))
    .innerJoin(studyMetadataVersions, eq(formInstances.metadataVersionId, studyMetadataVersions.id))
    .where(
      and(
        eq(subjects.studyId, studyId),
        ne(formInstances.metadataVersionId, targetId),
        inArray(formInstances.status, MIGRATABLE_STATUSES),
      ),
    )
    .orderBy(formInstances.id);
  return rows as EligibleRow[];
}

export async function analyzeMigration(
  db: Db,
  studyId: string,
  targetVersion: number,
): Promise<MigrationImpact> {
  const target = await loadBuild(db, studyId, targetVersion);
  if (!target) throw new CaptureError("not_found", `build v${targetVersion} not found`);

  const eligible = await eligibleForms(db, studyId, target.id);
  const byStatus: Partial<Record<FormStatus, number>> = {};
  const byFromVersion: Record<number, number> = {};
  for (const row of eligible) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    byFromVersion[row.fromVersion] = (byFromVersion[row.fromVersion] ?? 0) + 1;
  }

  const excludedRows = await db
    .select({ status: formInstances.status, count: sql<number>`count(*)::int` })
    .from(formInstances)
    .innerJoin(studyEventInstances, eq(formInstances.studyEventInstanceId, studyEventInstances.id))
    .innerJoin(subjects, eq(studyEventInstances.subjectId, subjects.id))
    .where(
      and(
        eq(subjects.studyId, studyId),
        ne(formInstances.metadataVersionId, target.id),
        inArray(formInstances.status, ["signed", "locked"]),
      ),
    )
    .groupBy(formInstances.status);
  const excluded = {
    signed: excludedRows.find((r) => r.status === "signed")?.count ?? 0,
    locked: excludedRows.find((r) => r.status === "locked")?.count ?? 0,
  };

  const diffs: { fromVersion: number; diff: BuildDiff }[] = [];
  for (const fromVersion of Object.keys(byFromVersion).map(Number).sort()) {
    const from = await loadBuild(db, studyId, fromVersion);
    if (from) diffs.push({ fromVersion, diff: diffMetaDataVersions(from.mdv, target.mdv) });
  }

  // Current values on eligible forms, grouped by placement.
  const valueRows = await db.execute<{
    item_group_oid: string;
    item_oid: string;
    value_count: number;
  }>(sql`
    SELECT ivc.item_group_oid, ivc.item_oid,
           count(*) FILTER (WHERE ivc.value IS NOT NULL)::int AS value_count
    FROM item_values_current ivc
    JOIN form_instances fi ON fi.id = ivc.form_instance_id
    JOIN study_event_instances sei ON sei.id = fi.study_event_instance_id
    JOIN subjects s ON s.id = sei.subject_id
    WHERE s.study_id = ${studyId}
      AND fi.metadata_version_id <> ${target.id}
      AND fi.status IN ('not_started','in_progress','complete','verified')
    GROUP BY ivc.item_group_oid, ivc.item_oid
  `);
  const targetPlacements = placementSet(target.mdv);
  const orphanedValues = valueRows
    .filter((r) => r.value_count > 0 && !targetPlacements.has(`${r.item_group_oid} ${r.item_oid}`))
    .map((r) => ({
      itemGroupOid: r.item_group_oid,
      itemOid: r.item_oid,
      valueCount: r.value_count,
    }));

  // Castability of surviving values against changed data types.
  const typeChanges = new Map<string, { from: string; to: string }>();
  for (const { diff } of diffs) {
    for (const item of diff.items) {
      if (item.kind === "changed" && item.changes?.dataType) {
        typeChanges.set(`${item.itemGroupOid} ${item.itemOid}`, item.changes.dataType);
      }
    }
  }
  const typeConflicts: MigrationImpact["typeConflicts"] = [];
  for (const [key, change] of typeChanges) {
    const [itemGroupOid, itemOid] = key.split(" ") as [string, string];
    const values = await db.execute<{ value: string }>(sql`
      SELECT ivc.value
      FROM item_values_current ivc
      JOIN form_instances fi ON fi.id = ivc.form_instance_id
      JOIN study_event_instances sei ON sei.id = fi.study_event_instance_id
      JOIN subjects s ON s.id = sei.subject_id
      WHERE s.study_id = ${studyId}
        AND fi.metadata_version_id <> ${target.id}
        AND fi.status IN ('not_started','in_progress','complete','verified')
        AND ivc.item_group_oid = ${itemGroupOid}
        AND ivc.item_oid = ${itemOid}
        AND ivc.value IS NOT NULL
    `);
    const nonCastableCount = values.filter((r) => !castable(r.value, change.to)).length;
    if (nonCastableCount > 0) {
      typeConflicts.push({ itemGroupOid, itemOid, ...change, nonCastableCount });
    }
  }

  const checksAddedOrChanged = [
    ...new Set(
      diffs.flatMap(({ diff }) =>
        diff.editChecks.filter((c) => c.kind !== "removed").map((c) => c.oid),
      ),
    ),
  ];

  return {
    targetVersion,
    eligible: { total: eligible.length, byStatus, byFromVersion },
    excluded,
    diffs,
    orphanedValues,
    typeConflicts,
    checksAddedOrChanged,
  };
}

/**
 * Creates the run row under a per-study advisory lock (one run at a time),
 * then returns it. The caller starts the driver with `runMigrationDriver` —
 * fire-and-forget, so the route can answer immediately with the run id.
 */
export async function startMigration(
  db: Db,
  input: { studyId: string; targetVersion: number; actorId: string },
) {
  const target = await loadBuild(db, input.studyId, input.targetVersion);
  if (!target) throw new CaptureError("not_found", `build v${input.targetVersion} not found`);

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`edc-core:amendment:${input.studyId}`}, 0))`,
    );
    const [active] = await tx
      .select({ id: migrationRuns.id })
      .from(migrationRuns)
      .where(and(eq(migrationRuns.studyId, input.studyId), eq(migrationRuns.status, "running")))
      .limit(1);
    if (active) {
      throw new CaptureError("conflict", "a migration is already running for this study");
    }

    const eligible = await eligibleForms(tx as unknown as Db, input.studyId, target.id);
    const [run] = await tx
      .insert(migrationRuns)
      .values({
        studyId: input.studyId,
        targetMetadataVersionId: target.id,
        startedBy: input.actorId,
        status: "running",
        totalForms: eligible.length,
      })
      .returning();
    if (!run) throw new Error("migration run insert returned no row");
    await tx.insert(auditEvents).values({
      actorId: input.actorId,
      studyId: input.studyId,
      action: "migration.started",
      entityType: "migration_run",
      entityId: run.id,
      newValue: { targetVersion: input.targetVersion, totalForms: eligible.length },
    });
    return run;
  });
}

/**
 * The migration driver: per-form transactions in bounded batches, so a large
 * study never holds one giant lock and a failure affects only its form. Each
 * form's re-point, audit row, and edit-check/query reconciliation commit
 * together. Idempotent to re-run: migrated forms are no longer eligible.
 */
export async function runMigrationDriver(db: Db, runId: string): Promise<void> {
  const [run] = await db.select().from(migrationRuns).where(eq(migrationRuns.id, runId)).limit(1);
  if (!run || run.status !== "running") return;
  const targetId = run.targetMetadataVersionId;

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  const errors: { formInstanceId: string; message: string }[] = [];
  // Failed forms remain "eligible" in the re-query; excluding them here is
  // what makes the loop terminate.
  const failedIds = new Set<string>();

  try {
    for (;;) {
      const batch = (await eligibleForms(db, run.studyId, targetId))
        .filter((row) => !failedIds.has(row.formInstanceId))
        .slice(0, BATCH_SIZE);
      if (batch.length === 0) break;

      for (const row of batch) {
        try {
          const outcome = await db.transaction(async (tx) => {
            const txDb = tx as unknown as Db;
            const context = await resolveFormContext(txDb, row.formInstanceId);
            if (
              !context ||
              context.metadataVersionId === targetId ||
              !MIGRATABLE_STATUSES.includes(context.status)
            ) {
              return "skipped" as const;
            }
            const [updated] = await tx
              .update(formInstances)
              .set({ metadataVersionId: targetId })
              .where(
                and(
                  eq(formInstances.id, context.formInstanceId),
                  eq(formInstances.status, context.status),
                  eq(formInstances.metadataVersionId, context.metadataVersionId),
                ),
              )
              .returning();
            if (!updated) return "skipped" as const; // concurrent status change
            await tx.insert(auditEvents).values({
              actorId: run.startedBy,
              studyId: context.studyId,
              action: "form.migrated",
              entityType: "form_instance",
              entityId: context.formInstanceId,
              oldValue: { metadataVersionId: context.metadataVersionId },
              newValue: { metadataVersionId: targetId, migrationRunId: runId },
            });
            // Reconcile against the new build: changed method expressions
            // recompute derivations, then newly firing checks open queries
            // and checks that vanished auto-close (audited).
            await runPostWritePipeline(
              txDb,
              { ...context, metadataVersionId: targetId },
              run.startedBy,
            );
            return "migrated" as const;
          });
          if (outcome === "migrated") processed += 1;
          else skipped += 1;
        } catch (err) {
          failed += 1;
          failedIds.add(row.formInstanceId);
          if (errors.length < MAX_RECORDED_ERRORS) {
            errors.push({
              formInstanceId: row.formInstanceId,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      await db
        .update(migrationRuns)
        .set({ processedForms: processed, skippedForms: skipped, failedForms: failed, errors })
        .where(eq(migrationRuns.id, runId));
    }

    await db
      .update(migrationRuns)
      .set({
        status: failed > 0 ? "completed_with_errors" : "completed",
        processedForms: processed,
        skippedForms: skipped,
        failedForms: failed,
        errors,
        finishedAt: new Date(),
      })
      .where(eq(migrationRuns.id, runId));
  } catch (err) {
    await db
      .update(migrationRuns)
      .set({
        status: "failed",
        errors: [
          ...errors,
          { formInstanceId: "", message: err instanceof Error ? err.message : String(err) },
        ],
        finishedAt: new Date(),
      })
      .where(eq(migrationRuns.id, runId));
  }
}

/**
 * Boot-time sweep: a run left `running` by an API restart cannot resume (the
 * driver is an in-process loop), but re-running is safe — mark it failed so
 * the UI tells the truth. Called from server startup, not buildServer, so
 * tests that build servers do not sweep each other's runs.
 */
export async function sweepInterruptedMigrations(db: Db): Promise<number> {
  const stale = await db
    .update(migrationRuns)
    .set({ status: "failed", finishedAt: new Date() })
    .where(eq(migrationRuns.status, "running"))
    .returning({ id: migrationRuns.id });
  return stale.length;
}
