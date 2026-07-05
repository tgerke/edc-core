import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { hasPermission } from "../auth/rbac.js";
import { auditEvents, users } from "../db/schema/index.js";

const filterSchema = z.object({
  action: z.string().min(1).optional(),
  entityType: z.string().min(1).optional(),
  entityId: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  format: z.enum(["json", "csv"]).default("json"),
});

function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * The E6(R3) audit review surface (E6-03): the trail is not just stored but
 * reviewable — filterable by action, entity, actor, and time, and exportable
 * as CSV for inspection copies (P11-05). Read-only by construction; the
 * table itself rejects UPDATE/DELETE by trigger.
 */
export const auditRoutes: FastifyPluginAsync = async (app) => {
  app.get("/studies/:studyId/audit", async (request, reply) => {
    const { studyId } = request.params as { studyId: string };
    if (!request.user) return reply.code(401).send({ error: "authentication required" });
    if (!(await hasPermission(app.db, request.user.id, "audit.review", { studyId }))) {
      return reply.code(403).send({ error: "missing permission: audit.review" });
    }
    const parsed = filterSchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const f = parsed.data;

    const conditions = [eq(auditEvents.studyId, studyId)];
    if (f.action) conditions.push(eq(auditEvents.action, f.action));
    if (f.entityType) conditions.push(eq(auditEvents.entityType, f.entityType));
    if (f.entityId) conditions.push(eq(auditEvents.entityId, f.entityId));
    if (f.actor) conditions.push(eq(users.username, f.actor));
    if (f.from) conditions.push(gte(auditEvents.occurredAt, new Date(f.from)));
    if (f.to) conditions.push(lte(auditEvents.occurredAt, new Date(f.to)));
    const where = and(...conditions);

    const rows = await app.db
      .select({
        id: auditEvents.id,
        occurredAt: auditEvents.occurredAt,
        actor: users.username,
        actorName: users.fullName,
        action: auditEvents.action,
        entityType: auditEvents.entityType,
        entityId: auditEvents.entityId,
        oldValue: auditEvents.oldValue,
        newValue: auditEvents.newValue,
        reason: auditEvents.reason,
      })
      .from(auditEvents)
      .innerJoin(users, eq(auditEvents.actorId, users.id))
      .where(where)
      .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
      .limit(f.format === "csv" ? 10_000 : f.limit)
      .offset(f.format === "csv" ? 0 : f.offset);

    const events = rows.map((row) => ({ ...row, id: String(row.id) }));

    if (f.format === "csv") {
      const header =
        "occurred_at,actor,actor_name,action,entity_type,entity_id,old_value,new_value,reason";
      const lines = events.map((e) =>
        [
          e.occurredAt.toISOString(),
          e.actor,
          e.actorName,
          e.action,
          e.entityType,
          e.entityId,
          e.oldValue,
          e.newValue,
          e.reason,
        ]
          .map(csvField)
          .join(","),
      );
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="audit-${studyId}.csv"`)
        .send([header, ...lines].join("\n"));
    }

    const [{ total } = { total: 0 }] = await app.db
      .select({ total: sql<number>`count(*)::int` })
      .from(auditEvents)
      .innerJoin(users, eq(auditEvents.actorId, users.id))
      .where(where);
    // Facets scoped to the study drive the filter dropdowns.
    const facets = await app.db
      .select({
        action: auditEvents.action,
        entityType: auditEvents.entityType,
      })
      .from(auditEvents)
      .where(eq(auditEvents.studyId, studyId))
      .groupBy(auditEvents.action, auditEvents.entityType);

    return {
      total,
      events,
      facets: {
        actions: [...new Set(facets.map((f) => f.action))].sort(),
        entityTypes: [...new Set(facets.map((f) => f.entityType))].sort(),
      },
    };
  });
};
