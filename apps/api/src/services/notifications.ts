import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Permission } from "../auth/permissions.js";
import { type PermissionScope, usersWithPermission } from "../auth/rbac.js";
import type { Db } from "../db/client.js";
import { notifications } from "../db/schema/index.js";

export type NotificationType =
  | "query.opened"
  | "query.answered"
  | "form.awaiting_signature"
  | "form.overdue";

export interface NewNotification {
  userId: string;
  studyId: string;
  type: NotificationType;
  title: string;
  body: string;
  payload?: Record<string, unknown>;
  /** Set for scan-generated notifications so re-scans are no-ops. */
  dedupeKey?: string;
}

/**
 * Inserts notifications — called inside the same transaction as the event
 * they announce (next to its audit write), so an event and its notifications
 * commit or roll back together. Deliberately explicit emission over tailing
 * the audit table: four event types do not justify a polling reader.
 */
export async function notify(db: Db, items: NewNotification[]): Promise<void> {
  if (items.length === 0) return;
  await db
    .insert(notifications)
    .values(
      items.map((item) => ({
        userId: item.userId,
        studyId: item.studyId,
        type: item.type,
        title: item.title,
        body: item.body,
        payload: item.payload ?? {},
        dedupeKey: item.dedupeKey ?? null,
      })),
    )
    .onConflictDoNothing();
}

/**
 * Fan-out to everyone holding a permission in scope, excluding the actor —
 * nobody needs a notification about their own action.
 */
export async function notifyPermissionHolders(
  db: Db,
  input: {
    permission: Permission;
    scope: PermissionScope;
    excludeUserId: string;
    notification: Omit<NewNotification, "userId">;
  },
): Promise<void> {
  const recipients = (await usersWithPermission(db, input.permission, input.scope)).filter(
    (userId) => userId !== input.excludeUserId,
  );
  await notify(
    db,
    recipients.map((userId) => ({ ...input.notification, userId })),
  );
}

export async function listNotifications(
  db: Db,
  userId: string,
  opts: { unreadOnly?: boolean; limit?: number } = {},
) {
  const conditions = [eq(notifications.userId, userId)];
  if (opts.unreadOnly) conditions.push(isNull(notifications.readAt));
  return db
    .select({
      id: notifications.id,
      studyId: notifications.studyId,
      type: notifications.type,
      title: notifications.title,
      body: notifications.body,
      payload: notifications.payload,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt))
    .limit(Math.min(opts.limit ?? 20, 100));
}

export async function unreadCount(db: Db, userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return row?.count ?? 0;
}

/** Marks one notification read; only the owner's rows qualify. */
export async function markRead(db: Db, userId: string, notificationId: string): Promise<boolean> {
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
      ),
    )
    .returning({ id: notifications.id });
  return rows.length > 0;
}

export async function markAllRead(db: Db, userId: string): Promise<number> {
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return rows.length;
}
