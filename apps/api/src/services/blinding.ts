import type { MetaDataVersion } from "@edc-core/odm";
import { inArray } from "drizzle-orm";
import { hasPermission, type PermissionScope } from "../auth/rbac.js";
import type { Db } from "../db/client.js";
import { itemValueVersions } from "../db/schema/index.js";
import { latestMetadataVersion } from "./capture.js";
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
