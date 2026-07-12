import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { auditEvents, itemValueVersions } from "./schema/index.js";

export interface ItemValueWrite {
  formInstanceId: string;
  itemGroupOid: string;
  itemGroupRepeatKey?: number;
  itemOid: string;
  value: string | null;
  actorId: string;
  studyId: string;
  /** Required when changing an existing value (clinical correction convention). */
  reasonForChange?: string;
  /** Set by machine write paths: the audit trail records the value as
   * item_value.imported (lab import) or item_value.integrated (RTSM intake)
   * so data origin is permanently distinguishable. */
  origin?: "import" | "integration";
}

/**
 * The canonical clinical-data write path: appends a new item value version and
 * its audit event in one transaction. There is deliberately no "update value"
 * anywhere in the codebase — corrections append (ADR-0002; P11-01, E6-04).
 */
export async function appendItemValue(db: Db, write: ItemValueWrite) {
  const repeatKey = write.itemGroupRepeatKey ?? 1;

  return db.transaction(async (tx) => {
    // Serialize concurrent writers of the same item so versions can't collide.
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtextextended(
        ${`${write.formInstanceId}:${write.itemGroupOid}:${repeatKey}:${write.itemOid}`}, 0))
    `);

    const [latest] = await tx
      .select({ version: itemValueVersions.version, value: itemValueVersions.value })
      .from(itemValueVersions)
      .where(
        and(
          eq(itemValueVersions.formInstanceId, write.formInstanceId),
          eq(itemValueVersions.itemGroupOid, write.itemGroupOid),
          eq(itemValueVersions.itemGroupRepeatKey, repeatKey),
          eq(itemValueVersions.itemOid, write.itemOid),
        ),
      )
      .orderBy(desc(itemValueVersions.version))
      .limit(1);

    if (latest && !write.reasonForChange) {
      throw new Error("reasonForChange is required when changing an existing value");
    }

    const [inserted] = await tx
      .insert(itemValueVersions)
      .values({
        formInstanceId: write.formInstanceId,
        itemGroupOid: write.itemGroupOid,
        itemGroupRepeatKey: repeatKey,
        itemOid: write.itemOid,
        version: (latest?.version ?? 0) + 1,
        value: write.value,
        reasonForChange: write.reasonForChange ?? null,
        createdBy: write.actorId,
      })
      .returning();
    if (!inserted) throw new Error("item value insert returned no row");

    await tx.insert(auditEvents).values({
      actorId: write.actorId,
      studyId: write.studyId,
      action: latest
        ? "item_value.changed"
        : write.origin === "import"
          ? "item_value.imported"
          : write.origin === "integration"
            ? "item_value.integrated"
            : "item_value.entered",
      entityType: "item_value",
      entityId: inserted.id,
      oldValue: latest ? { value: latest.value } : null,
      newValue: { value: write.value },
      reason: write.reasonForChange ?? null,
    });

    return inserted;
  });
}
