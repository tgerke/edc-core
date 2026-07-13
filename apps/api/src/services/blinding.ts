import type { MetaDataVersion } from "@edc-core/odm";
import { and, asc, eq, inArray } from "drizzle-orm";
import { hasPermission, type PermissionScope } from "../auth/rbac.js";
import type { Db } from "../db/client.js";
import { auditEvents, itemValueVersions, subjectUnblindings, users } from "../db/schema/index.js";
import { CaptureError, latestMetadataVersion } from "./capture.js";
import type { StudyBuildDefinition } from "./study-builds.js";

/**
 * Item-level blinding (ADR-0009). The flag lives in the study build
 * (ItemDef.blinded, edc:Blinded in ODM XML), so it versions and pins with
 * everything else. Enforcement is per-viewer at every Postgres-direct read
 * (form read, casebook, audit) and structural at snapshot publish: blinded
 * columns never enter the analytics lake, which covers the SQL workbench,
 * the R engine, exports, and archives by construction.
 */

export const BLINDED_PLACEHOLDER = "[BLINDED]";

export function blindedItemOids(mdv: MetaDataVersion): Set<string> {
  return new Set(mdv.itemDefs.filter((item) => item.blinded).map((item) => item.oid));
}

/**
 * Purely permission-based — no isSystemAdmin bypass. A system administrator
 * unblinding themselves must do it through an audited role grant.
 */
export async function canUnblind(db: Db, userId: string, scope: PermissionScope): Promise<boolean> {
  return hasPermission(db, userId, "data.unblind", scope);
}

/**
 * Masks values in place-shaped rows: the row survives (layout and "was it
 * entered" stay intact) but the value is withheld and flagged. Omitting rows
 * instead would be indistinguishable from missing data.
 */
export function maskItemValues<T extends { item_oid: string; value: string | null }>(
  rows: T[],
  blinded: Set<string>,
): (T & { blinded?: boolean })[] {
  if (blinded.size === 0) return rows;
  return rows.map((row) =>
    blinded.has(row.item_oid) && row.value !== null ? { ...row, value: null, blinded: true } : row,
  );
}

interface AuditLikeRow {
  entityType: string;
  entityId: string;
  oldValue: unknown;
  newValue: unknown;
}

/**
 * Masks old/new values on item-value audit rows whose item is blinded in the
 * study's latest build (latest, not per-form pinned: conservative and cheap —
 * an item blinded anywhere masks its whole history). Blinded reviewers still
 * see who changed what and when, and the stated reason — just not the values.
 */
export async function maskBlindedAuditRows<T extends AuditLikeRow>(
  db: Db,
  studyId: string,
  rows: T[],
): Promise<T[]> {
  const mdv = await latestMetadataVersion(db, studyId);
  if (!mdv) return rows;
  const blinded = blindedItemOids(
    (mdv.definition as unknown as StudyBuildDefinition).metaDataVersion,
  );
  if (blinded.size === 0) return rows;

  const valueIds = rows.filter((row) => row.entityType === "item_value").map((row) => row.entityId);
  if (valueIds.length === 0) return rows;
  const versions = await db
    .select({ id: itemValueVersions.id, itemOid: itemValueVersions.itemOid })
    .from(itemValueVersions)
    .where(inArray(itemValueVersions.id, valueIds));
  const blindedIds = new Set(versions.filter((v) => blinded.has(v.itemOid)).map((v) => v.id));

  const mask = (value: unknown) => (value == null ? value : { value: BLINDED_PLACEHOLDER });
  return rows.map((row) =>
    row.entityType === "item_value" && blindedIds.has(row.entityId)
      ? { ...row, oldValue: mask(row.oldValue), newValue: mask(row.newValue) }
      : row,
  );
}

// E6(R3) Annex 1 §4.1.4 taxonomy: planned, or unplanned (inadvertent,
// emergency); "other" covers unplanned unblinding that is neither.
export const UNBLINDING_CATEGORIES = ["emergency", "inadvertent", "planned", "other"] as const;
export type UnblindingCategory = (typeof UNBLINDING_CATEGORIES)[number];

/**
 * The explicit break-the-blind event. Recording only, deliberately: the
 * record documents that the blind was broken for this subject (by whom,
 * when, why), while in-system visibility of blinded values stays governed
 * by data.unblind grants — an emergency unblinding of one investigator
 * must not unmask the subject for every other viewer.
 */
export async function breakBlind(
  db: Db,
  input: {
    studyId: string;
    subjectId: string;
    category: UnblindingCategory;
    reason: string;
    actorId: string;
  },
) {
  const reason = input.reason.trim();
  if (!reason) throw new CaptureError("invalid", "a reason is required to break the blind");

  return db.transaction(async (tx) => {
    const [event] = await tx
      .insert(subjectUnblindings)
      .values({
        studyId: input.studyId,
        subjectId: input.subjectId,
        category: input.category,
        reason,
        createdBy: input.actorId,
      })
      .returning();
    if (!event) throw new Error("unblinding insert returned no row");
    await tx.insert(auditEvents).values({
      actorId: input.actorId,
      studyId: input.studyId,
      action: "subject.unblinded",
      entityType: "subject",
      entityId: input.subjectId,
      newValue: { category: input.category, unblindingId: event.id },
      reason,
    });
    return event;
  });
}

/** Unblinding events for one subject, oldest first, with the actor's name. */
export async function listUnblindings(db: Db, studyId: string, subjectId: string) {
  return db
    .select({
      id: subjectUnblindings.id,
      category: subjectUnblindings.category,
      reason: subjectUnblindings.reason,
      actorName: users.fullName,
      createdAt: subjectUnblindings.createdAt,
    })
    .from(subjectUnblindings)
    .innerJoin(users, eq(subjectUnblindings.createdBy, users.id))
    .where(
      and(eq(subjectUnblindings.studyId, studyId), eq(subjectUnblindings.subjectId, subjectId)),
    )
    .orderBy(asc(subjectUnblindings.createdAt));
}

/** Whether each of the given subjects has at least one unblinding event. */
export async function unblindedSubjectIds(db: Db, subjectIds: string[]): Promise<Set<string>> {
  if (subjectIds.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ subjectId: subjectUnblindings.subjectId })
    .from(subjectUnblindings)
    .where(inArray(subjectUnblindings.subjectId, subjectIds));
  return new Set(rows.map((r) => r.subjectId));
}
