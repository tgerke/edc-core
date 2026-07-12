import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireSystemAdmin } from "../auth/plugin.js";
import type { AuthenticatedUser } from "../auth/service.js";
import { securityAnomalies, users } from "../db/schema/index.js";
import { acknowledgeAnomaly } from "../services/security-anomalies.js";

const filterSchema = z.object({
  status: z.enum(["open", "acknowledged"]).optional(),
  kind: z.enum(["failed_login_burst", "lockout", "session_binding_violation"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  format: z.enum(["json", "csv"]).default("json"),
});

const acknowledgeSchema = z.object({
  note: z.string().trim().min(1).max(2000).optional(),
});

function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * The anomaly review surface (E6-06): detection is only a control if the
 * findings are reviewed and the response is recorded. System-administration
 * scope like the access log — anomalies span studies and unauthenticated
 * traffic. Acknowledgement is audited.
 */
export const securityAnomalyRoutes: FastifyPluginAsync = async (app) => {
  const acknowledgers = alias(users, "acknowledgers");

  app.get(
    "/admin/security-anomalies",
    { preHandler: requireSystemAdmin() },
    async (request, reply) => {
      const parsed = filterSchema.safeParse(request.query ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const f = parsed.data;

      const conditions = [];
      if (f.status === "open") conditions.push(isNull(securityAnomalies.acknowledgedAt));
      if (f.status === "acknowledged") conditions.push(isNotNull(securityAnomalies.acknowledgedAt));
      if (f.kind) conditions.push(eq(securityAnomalies.kind, f.kind));
      const where = and(...conditions);

      const entries = await app.db
        .select({
          id: securityAnomalies.id,
          detectedAt: securityAnomalies.detectedAt,
          kind: securityAnomalies.kind,
          severity: securityAnomalies.severity,
          user: users.username,
          ip: securityAnomalies.ip,
          summary: securityAnomalies.summary,
          details: securityAnomalies.details,
          acknowledgedAt: securityAnomalies.acknowledgedAt,
          acknowledgedBy: acknowledgers.username,
          acknowledgedNote: securityAnomalies.acknowledgedNote,
        })
        .from(securityAnomalies)
        .leftJoin(users, eq(securityAnomalies.userId, users.id))
        .leftJoin(acknowledgers, eq(securityAnomalies.acknowledgedBy, acknowledgers.id))
        .where(where)
        .orderBy(desc(securityAnomalies.detectedAt), desc(securityAnomalies.id))
        .limit(f.format === "csv" ? 10_000 : f.limit)
        .offset(f.format === "csv" ? 0 : f.offset);

      if (f.format === "csv") {
        const header =
          "detected_at,kind,severity,user,ip,summary,acknowledged_at,acknowledged_by,acknowledged_note";
        const lines = entries.map((e) =>
          [
            e.detectedAt.toISOString(),
            e.kind,
            e.severity,
            e.user,
            e.ip,
            e.summary,
            e.acknowledgedAt?.toISOString(),
            e.acknowledgedBy,
            e.acknowledgedNote,
          ]
            .map(csvField)
            .join(","),
        );
        return reply
          .header("content-type", "text/csv; charset=utf-8")
          .header("content-disposition", 'attachment; filename="security-anomalies.csv"')
          .send([header, ...lines].join("\n"));
      }

      const [{ total } = { total: 0 }] = await app.db
        .select({ total: sql<number>`count(*)::int` })
        .from(securityAnomalies)
        .where(where);

      return { total, entries };
    },
  );

  app.post(
    "/admin/security-anomalies/:id/acknowledge",
    { preHandler: requireSystemAdmin() },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = acknowledgeSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const user = request.user as AuthenticatedUser;

      const result = await acknowledgeAnomaly(app.db, {
        anomalyId: id,
        userId: user.id,
        ...(parsed.data.note ? { note: parsed.data.note } : {}),
      });
      if (!result.ok) {
        if (result.code === "not_found") {
          return reply.code(404).send({ error: "anomaly not found" });
        }
        return reply.code(409).send({ error: "anomaly already acknowledged" });
      }
      return { ok: true };
    },
  );
};
