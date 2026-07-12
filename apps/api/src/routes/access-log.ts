import { and, desc, eq, gte, like, lte, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireSystemAdmin } from "../auth/plugin.js";
import { accessLog, users } from "../db/schema/index.js";

const filterSchema = z.object({
  user: z.string().min(1).optional(),
  ip: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  status: z.coerce.number().int().min(100).max(599).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  format: z.enum(["json", "csv"]).default("json"),
});

function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * The access-log review surface (P11-14): §11.10(h) device checks produce
 * evidence only if someone can inspect it. System-administration scope, like
 * user administration — the log spans studies and unauthenticated attempts,
 * so no study-scoped permission fits. Filterable by user, source address,
 * path prefix, status, and time; CSV export for inspection copies.
 */
export const accessLogRoutes: FastifyPluginAsync = async (app) => {
  app.get("/admin/access-log", { preHandler: requireSystemAdmin() }, async (request, reply) => {
    const parsed = filterSchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const f = parsed.data;

    const conditions = [];
    if (f.user) conditions.push(eq(users.username, f.user));
    if (f.ip) conditions.push(eq(accessLog.ip, f.ip));
    if (f.path) conditions.push(like(accessLog.path, `${f.path.replaceAll("%", "")}%`));
    if (f.status !== undefined) conditions.push(eq(accessLog.statusCode, f.status));
    if (f.from) conditions.push(gte(accessLog.occurredAt, new Date(f.from)));
    if (f.to) conditions.push(lte(accessLog.occurredAt, new Date(f.to)));
    // and() of an empty list is undefined — an unfiltered where() is a no-op.
    const where = and(...conditions);

    const rows = await app.db
      .select({
        id: accessLog.id,
        occurredAt: accessLog.occurredAt,
        user: users.username,
        userName: users.fullName,
        method: accessLog.method,
        path: accessLog.path,
        route: accessLog.route,
        statusCode: accessLog.statusCode,
        ip: accessLog.ip,
        userAgent: accessLog.userAgent,
        sessionId: accessLog.sessionId,
        durationMs: accessLog.durationMs,
      })
      .from(accessLog)
      .leftJoin(users, eq(accessLog.userId, users.id))
      .where(where)
      .orderBy(desc(accessLog.occurredAt), desc(accessLog.id))
      .limit(f.format === "csv" ? 10_000 : f.limit)
      .offset(f.format === "csv" ? 0 : f.offset);
    const entries = rows.map((row) => ({ ...row, id: String(row.id) }));

    if (f.format === "csv") {
      const header = "occurred_at,user,method,path,status,ip,user_agent,session_id,duration_ms";
      const lines = entries.map((e) =>
        [
          e.occurredAt.toISOString(),
          e.user,
          e.method,
          e.path,
          e.statusCode,
          e.ip,
          e.userAgent,
          e.sessionId,
          e.durationMs,
        ]
          .map(csvField)
          .join(","),
      );
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", 'attachment; filename="access-log.csv"')
        .send([header, ...lines].join("\n"));
    }

    const [{ total } = { total: 0 }] = await app.db
      .select({ total: sql<number>`count(*)::int` })
      .from(accessLog)
      .leftJoin(users, eq(accessLog.userId, users.id))
      .where(where);

    return { total, entries };
  });
};
