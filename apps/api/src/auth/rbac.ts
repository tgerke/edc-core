import { and, eq, isNull, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { auditEvents, rolePermissions, userStudyRoles } from "../db/schema/index.js";
import type { Permission } from "./permissions.js";

export interface PermissionScope {
  studyId: string;
  /** When set, grants scoped to a different site do not qualify. */
  siteId?: string;
}

/**
 * A user holds a permission in a study when any unrevoked role grant for that
 * study carries it. Site-scoped grants (siteId set on the grant) only apply
 * to their own site; study-wide grants (siteId null) apply everywhere.
 * System admins do NOT implicitly hold clinical permissions — deliberate:
 * administering the system must not entitle anyone to enter or sign data.
 */
export async function hasPermission(
  db: Db,
  userId: string,
  permission: Permission,
  scope: PermissionScope,
): Promise<boolean> {
  const siteCondition = scope.siteId
    ? or(isNull(userStudyRoles.siteId), eq(userStudyRoles.siteId, scope.siteId))
    : isNull(userStudyRoles.siteId);

  const rows = await db
    .select({ roleId: userStudyRoles.roleId })
    .from(userStudyRoles)
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, userStudyRoles.roleId))
    .where(
      and(
        eq(userStudyRoles.userId, userId),
        eq(userStudyRoles.studyId, scope.studyId),
        isNull(userStudyRoles.revokedAt),
        eq(rolePermissions.permission, permission),
        siteCondition,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Membership = any unrevoked role grant in the study (read visibility). */
export async function isStudyMember(db: Db, userId: string, studyId: string): Promise<boolean> {
  const rows = await db
    .select({ id: userStudyRoles.id })
    .from(userStudyRoles)
    .where(
      and(
        eq(userStudyRoles.userId, userId),
        eq(userStudyRoles.studyId, studyId),
        isNull(userStudyRoles.revokedAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function grantRole(
  db: Db,
  grant: {
    userId: string;
    studyId: string;
    roleId: string;
    siteId?: string;
    grantedBy: string;
  },
) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(userStudyRoles)
      .values({
        userId: grant.userId,
        studyId: grant.studyId,
        roleId: grant.roleId,
        siteId: grant.siteId ?? null,
        grantedBy: grant.grantedBy,
      })
      .returning();
    if (!row) throw new Error("role grant insert returned no row");
    await tx.insert(auditEvents).values({
      actorId: grant.grantedBy,
      studyId: grant.studyId,
      action: "rbac.role_granted",
      entityType: "user_study_role",
      entityId: row.id,
      newValue: { userId: grant.userId, roleId: grant.roleId, siteId: grant.siteId ?? null },
    });
    return row;
  });
}

export async function revokeRole(db: Db, grantId: string, revokedBy: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(userStudyRoles)
      .set({ revokedAt: new Date() })
      .where(and(eq(userStudyRoles.id, grantId), isNull(userStudyRoles.revokedAt)))
      .returning();
    if (!row) throw new Error("role grant not found or already revoked");
    await tx.insert(auditEvents).values({
      actorId: revokedBy,
      studyId: row.studyId,
      action: "rbac.role_revoked",
      entityType: "user_study_role",
      entityId: row.id,
      oldValue: { userId: row.userId, roleId: row.roleId, siteId: row.siteId },
    });
  });
}
