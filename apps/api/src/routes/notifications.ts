import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/plugin.js";
import type { AuthenticatedUser } from "../auth/service.js";
import {
  listNotifications,
  markAllRead,
  markRead,
  unreadCount,
} from "../services/notifications.js";

const listQuerySchema = z.object({
  unread: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** Self-scoped by construction: every handler operates on the caller's rows. */
export const notificationRoutes: FastifyPluginAsync = async (app) => {
  app.get("/notifications", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const user = request.user as AuthenticatedUser;
    return listNotifications(app.db, user.id, {
      ...(parsed.data.unread !== undefined ? { unreadOnly: parsed.data.unread } : {}),
      ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
    });
  });

  app.get("/notifications/unread-count", { preHandler: requireAuth }, async (request) => {
    const user = request.user as AuthenticatedUser;
    return { count: await unreadCount(app.db, user.id) };
  });

  app.post("/notifications/:id/read", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.user as AuthenticatedUser;
    const marked = await markRead(app.db, user.id, id);
    if (!marked) return reply.code(404).send({ error: "notification not found or already read" });
    return { ok: true };
  });

  app.post("/notifications/read-all", { preHandler: requireAuth }, async (request) => {
    const user = request.user as AuthenticatedUser;
    return { marked: await markAllRead(app.db, user.id) };
  });
};
