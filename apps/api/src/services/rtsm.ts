import type { MetaDataVersion } from "@edc-core/odm";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { hasPermission } from "../auth/rbac.js";
import type { Db } from "../db/client.js";
import { auditEvents, rtsmConfigs, rtsmEvents, subjects } from "../db/schema/index.js";
import { castable } from "./amendments.js";
import { BLINDED_PLACEHOLDER, blindedItemOids, canUnblind } from "./blinding.js";
import {
  CaptureError,
  ensureFormInstance,
  INTAKE_BLOCKED_STATUSES,
  latestMetadataVersion,
  resolveFormContext,
  type SubjectStatus,
  writeItemValue,
} from "./capture.js";
import { assertWriteAllowed, loadFormState, runPostWritePipeline } from "./form-state.js";
import type { StudyBuildDefinition } from "./study-builds.js";

/**
 * RTSM assignment intake (ADR-0010): an external randomization system posts
 * a subject's treatment-arm assignment and it lands as an ordinary blinded
 * eCRF item through the standard audited write path — audit, edit checks,
 * blinding, casebooks, and the analytics lake apply by construction, exactly
 * like lab imports. Assignments never overwrite: an identical replay is a
 * duplicate, a differing arm is a conflict for humans to resolve, and every
 * POST (including rejects) leaves an append-only rtsm_events row so the
 * transfer can be reconciled against the RTSM's own log.
 */

export const rtsmConfigSchema = z.object({
  eventOid: z.string().min(1),
  formOid: z.string().min(1),
  itemGroupOid: z.string().min(1),
  itemOid: z.string().min(1),
  enabled: z.boolean(),
});
export type RtsmConfigInput = z.infer<typeof rtsmConfigSchema>;

export const rtsmAssignmentSchema = z.object({
  subjectKey: z.string().min(1).max(200),
  arm: z.string().min(1).max(500),
  /** The RTSM's own transaction identifier, recorded for reconciliation. */
  randomizationId: z.string().min(1).max(200),
  assignedAt: z.iso.datetime({ offset: true }).optional(),
  /** Opaque in v1: stored and masked with the arm, never written to items. */
  strata: z.record(z.string(), z.string()).optional(),
  source: z.string().min(1).max(200).optional(),
});
export type RtsmAssignment = z.infer<typeof rtsmAssignmentSchema>;

export type RtsmOutcome = "applied" | "duplicate" | "conflict" | "rejected";

async function latestBuild(db: Db, studyId: string): Promise<MetaDataVersion | null> {
  const mdvRow = await latestMetadataVersion(db, studyId);
  if (!mdvRow) return null;
  return (mdvRow.definition as unknown as StudyBuildDefinition).metaDataVersion;
}

/** Structural validation against the latest build, like analyzeLabImport. */
function checkConfigAgainstBuild(mdv: MetaDataVersion, config: RtsmConfigInput): void {
  const event = mdv.studyEventDefs.find((e) => e.oid === config.eventOid);
  if (!event) throw new CaptureError("invalid", `event ${config.eventOid} not in latest build`);
  if (!event.itemGroupRefs.some((ref) => ref.itemGroupOid === config.formOid)) {
    throw new CaptureError(
      "invalid",
      `event ${config.eventOid} does not include form ${config.formOid}`,
    );
  }
  const form = mdv.itemGroupDefs.find((g) => g.oid === config.formOid);
  if (!form) throw new CaptureError("invalid", `form ${config.formOid} not in latest build`);
  // Group OIDs reachable from the form via nested ItemGroupRefs.
  const byOid = new Map(mdv.itemGroupDefs.map((g) => [g.oid, g]));
  const reachable = new Set<string>();
  const queue = [config.formOid];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (reachable.has(oid)) continue;
    reachable.add(oid);
    for (const ref of byOid.get(oid)?.itemGroupRefs ?? []) queue.push(ref.itemGroupOid);
  }
  if (!reachable.has(config.itemGroupOid)) {
    throw new CaptureError(
      "invalid",
      `group ${config.itemGroupOid} is not part of form ${config.formOid}`,
    );
  }
  const group = mdv.itemGroupDefs.find((g) => g.oid === config.itemGroupOid);
  if (!group?.itemRefs.some((ref) => ref.itemOid === config.itemOid)) {
    throw new CaptureError("invalid", `item ${config.itemOid} not in group ${config.itemGroupOid}`);
  }
  if (!mdv.itemDefs.some((item) => item.oid === config.itemOid)) {
    throw new CaptureError("invalid", `item ${config.itemOid} has no ItemDef`);
  }
}

export async function upsertRtsmConfig(
  db: Db,
  input: { studyId: string; config: RtsmConfigInput; actorId: string },
) {
  const mdv = await latestBuild(db, input.studyId);
  if (!mdv) throw new CaptureError("invalid", "study has no published build");
  checkConfigAgainstBuild(mdv, input.config);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(rtsmConfigs)
      .where(eq(rtsmConfigs.studyId, input.studyId))
      .limit(1);
    const saved = existing
      ? (
          await tx
            .update(rtsmConfigs)
            .set({ ...input.config, updatedBy: input.actorId, updatedAt: new Date() })
            .where(eq(rtsmConfigs.id, existing.id))
            .returning()
        )[0]
      : (
          await tx
            .insert(rtsmConfigs)
            .values({
              studyId: input.studyId,
              ...input.config,
              createdBy: input.actorId,
              updatedBy: input.actorId,
            })
            .returning()
        )[0];
    if (!saved) throw new Error("rtsm config write returned no row");
    const snapshot = (row: typeof saved) => ({
      eventOid: row.eventOid,
      formOid: row.formOid,
      itemGroupOid: row.itemGroupOid,
      itemOid: row.itemOid,
      enabled: row.enabled,
    });
    await tx.insert(auditEvents).values({
      actorId: input.actorId,
      studyId: input.studyId,
      action: existing ? "rtsm_config.updated" : "rtsm_config.created",
      entityType: "rtsm_config",
      entityId: saved.id,
      oldValue: existing ? snapshot(existing) : null,
      newValue: snapshot(saved),
    });
    return saved;
  });
}

export interface AssignmentResult {
  outcome: RtsmOutcome;
  /** Safe to echo to the RTSM: never contains the arm. */
  reason: string | null;
  eventId: string;
}

/**
 * Applies one posted assignment. The decision (applied / duplicate /
 * conflict) is made against the item's current value inside the write
 * transaction, so replays are idempotent regardless of interleaving; the
 * rtsm_events row and its audit event commit atomically with the item write.
 * Rejections record an event row too — an unknown subject is exactly the
 * discrepancy reconciliation needs to see.
 */
export async function applyAssignment(
  db: Db,
  input: {
    studyId: string;
    apiKeyId: string;
    serviceUserId: string;
    assignment: RtsmAssignment;
  },
): Promise<AssignmentResult> {
  const { studyId, assignment } = input;

  const record = async (
    outcome: RtsmOutcome,
    reason: string | null,
    extra: { subjectId?: string; itemValueVersionId?: string } = {},
    tx: Db = db,
  ): Promise<AssignmentResult> => {
    const [event] = await tx
      .insert(rtsmEvents)
      .values({
        studyId,
        apiKeyId: input.apiKeyId,
        subjectId: extra.subjectId ?? null,
        subjectKey: assignment.subjectKey,
        randomizationId: assignment.randomizationId,
        payload: assignment,
        outcome,
        reason,
        itemValueVersionId: extra.itemValueVersionId ?? null,
        createdBy: input.serviceUserId,
      })
      .returning();
    if (!event) throw new Error("rtsm event insert returned no row");
    // Deliberately arm-free: rtsm audit rows are not covered by the
    // item-value masking in maskBlindedAuditRows, so the value never
    // appears here. The item write carries its own (maskable) audit row.
    await tx.insert(auditEvents).values({
      actorId: input.serviceUserId,
      studyId,
      action: `rtsm.assignment_${outcome}`,
      entityType: "rtsm_event",
      entityId: event.id,
      newValue: {
        subjectKey: assignment.subjectKey,
        randomizationId: assignment.randomizationId,
        source: assignment.source ?? null,
        reason,
      },
    });
    return { outcome, reason, eventId: event.id };
  };

  const [config] = await db
    .select()
    .from(rtsmConfigs)
    .where(eq(rtsmConfigs.studyId, studyId))
    .limit(1);
  if (!config) return record("rejected", "RTSM intake is not configured for this study");
  if (!config.enabled) return record("rejected", "RTSM intake is disabled for this study");

  const mdvRow = await latestMetadataVersion(db, studyId);
  if (!mdvRow) return record("rejected", "study has no published build");
  const mdv = (mdvRow.definition as unknown as StudyBuildDefinition).metaDataVersion;
  const itemDef = mdv.itemDefs.find((item) => item.oid === config.itemOid);
  if (!itemDef) {
    return record("rejected", `configured item ${config.itemOid} is not in the latest build`);
  }
  if (!castable(assignment.arm, itemDef.dataType)) {
    return record("rejected", `arm is not a valid ${itemDef.dataType}`);
  }

  const [subject] = await db
    .select({ id: subjects.id, siteId: subjects.siteId, status: subjects.status })
    .from(subjects)
    .where(and(eq(subjects.studyId, studyId), eq(subjects.subjectKey, assignment.subjectKey)))
    .limit(1);
  if (!subject) {
    return record("rejected", `subject "${assignment.subjectKey}" is not enrolled`);
  }
  // Status-aware intake (#67): a subject who is out of the study must not
  // silently accept an assignment; reinstatement is the correction path.
  if (INTAKE_BLOCKED_STATUSES.includes(subject.status as SubjectStatus)) {
    return record(
      "rejected",
      `subject "${assignment.subjectKey}" is ${subject.status}; reinstate the subject before assigning`,
      { subjectId: subject.id },
    );
  }

  // Defense in depth: the route guard already proved the key, but the write
  // is attributed to the service account, whose audited rtsm_agent grant
  // must still be in force (revoking it disables the integration).
  const scope = { studyId, siteId: subject.siteId };
  if (!(await hasPermission(db, input.serviceUserId, "integration.rtsm", scope))) {
    return record("rejected", "service account no longer holds integration.rtsm (grant revoked?)", {
      subjectId: subject.id,
    });
  }
  const blinded = blindedItemOids(mdv);
  if (blinded.has(config.itemOid) && !(await canUnblind(db, input.serviceUserId, scope))) {
    return record(
      "rejected",
      "target item is blinded and the service account no longer holds data.unblind",
      { subjectId: subject.id },
    );
  }

  try {
    return await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const form = await ensureFormInstance(txDb, {
        subjectId: subject.id,
        eventOid: config.eventOid,
        formOid: config.formOid,
        actorId: input.serviceUserId,
      });
      const context = await resolveFormContext(txDb, form.id);
      if (!context) throw new Error("form context vanished");

      // A form pinned to an older build only renders items that build
      // defines — refuse to store the arm invisibly (lab-import precedent).
      if (context.metadataVersionId !== mdvRow.id) {
        const [pinned] = await tx.execute<{ definition: unknown }>(
          sql`SELECT definition FROM study_metadata_versions WHERE id = ${context.metadataVersionId}`,
        );
        const pinnedMdv = pinned
          ? (pinned.definition as StudyBuildDefinition).metaDataVersion
          : null;
        const present = pinnedMdv?.itemGroupDefs
          .find((g) => g.oid === config.itemGroupOid)
          ?.itemRefs.some((ref) => ref.itemOid === config.itemOid);
        if (!present) {
          return record(
            "rejected",
            "form is pinned to an older build without the arm item; run the amendment migration first",
            { subjectId: subject.id },
            txDb,
          );
        }
      }

      const current = await tx.execute<{ value: string | null }>(sql`
        SELECT value FROM item_values_current
        WHERE form_instance_id = ${context.formInstanceId}
          AND item_group_oid = ${config.itemGroupOid}
          AND item_group_repeat_key = 1
          AND item_oid = ${config.itemOid}
      `);
      const existing = current[0];
      if (existing) {
        if (existing.value === assignment.arm) {
          return record(
            "duplicate",
            "an identical assignment is already recorded",
            { subjectId: subject.id },
            txDb,
          );
        }
        // Never overwrite, and never reveal either value in the response.
        return record(
          "conflict",
          "a different assignment is already recorded; resolve in the EDC",
          { subjectId: subject.id },
          txDb,
        );
      }

      if (context.status !== "not_started" && context.status !== "in_progress") {
        return record(
          "conflict",
          `target form is ${context.status}; reopen it before re-sending`,
          { subjectId: subject.id },
          txDb,
        );
      }

      // Unattended intake must not write into a derived or not-collected
      // target; reject visibly instead of leaving a silent bad value.
      const formState = await loadFormState(txDb, context);
      if (formState) {
        try {
          assertWriteAllowed(formState, {
            itemGroupOid: config.itemGroupOid,
            itemOid: config.itemOid,
            value: assignment.arm,
          });
        } catch (err) {
          return record(
            "rejected",
            err instanceof Error ? err.message : String(err),
            { subjectId: subject.id },
            txDb,
          );
        }
      }

      const written = await writeItemValue(txDb, context, {
        itemGroupOid: config.itemGroupOid,
        itemOid: config.itemOid,
        value: assignment.arm,
        actorId: input.serviceUserId,
        origin: "integration",
      });
      await runPostWritePipeline(txDb, { ...context, status: "in_progress" }, input.serviceUserId);
      return record(
        "applied",
        null,
        { subjectId: subject.id, itemValueVersionId: written.id },
        txDb,
      );
    });
  } catch (err) {
    // Concurrent duplicate POSTs can race past the current-value read; the
    // per-item advisory lock in appendItemValue turns the loser into this
    // error rather than a second version.
    const message = err instanceof Error ? err.message : String(err);
    return record("conflict", `write did not apply: ${message}`, { subjectId: subject.id });
  }
}

const EVENTS_LIMIT = 100;

/**
 * Recent intake events for the study UI. The stored payload carries the arm
 * (and strata), so unless the configured target item is un-blinded in the
 * latest build or the viewer holds a study-wide data.unblind grant, both are
 * masked. Study-wide deliberately: one listing spans subjects at many sites,
 * so a site-scoped grant does not qualify.
 */
export async function listRtsmEvents(
  db: Db,
  input: { studyId: string; viewerId: string },
): Promise<Array<Record<string, unknown>>> {
  const rows = await db
    .select()
    .from(rtsmEvents)
    .where(eq(rtsmEvents.studyId, input.studyId))
    .orderBy(desc(rtsmEvents.createdAt))
    .limit(EVENTS_LIMIT);
  if (rows.length === 0) return [];

  let mask = true;
  const [config] = await db
    .select({ itemOid: rtsmConfigs.itemOid })
    .from(rtsmConfigs)
    .where(eq(rtsmConfigs.studyId, input.studyId))
    .limit(1);
  const mdv = await latestBuild(db, input.studyId);
  if (config && mdv && !blindedItemOids(mdv).has(config.itemOid)) mask = false;
  else if (await canUnblind(db, input.viewerId, { studyId: input.studyId })) mask = false;

  return rows.map((row) => {
    if (!mask) return { ...row, blinded: false };
    const payload = row.payload as Record<string, unknown>;
    return {
      ...row,
      blinded: true,
      payload: {
        ...payload,
        ...(payload.arm !== undefined ? { arm: BLINDED_PLACEHOLDER } : {}),
        ...(payload.strata !== undefined ? { strata: BLINDED_PLACEHOLDER } : {}),
      },
    };
  });
}
