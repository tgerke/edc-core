import { Readable } from "node:stream";
import { type SQL, and, desc, eq, gte, isNull, lt, lte, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireSystemAdmin } from "../auth/plugin.js";
import { hasPermission } from "../auth/rbac.js";
import type { Db } from "../db/client.js";
import { auditEvents, users } from "../db/schema/index.js";
import { canUnblind, maskBlindedAuditRows } from "../services/blinding.js";

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

const CSV_HEADER =
  "occurred_at,actor,actor_name,action,entity_type,entity_id,old_value,new_value,reason";
const CSV_BATCH = 1_000;

function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function selectRows(db: Db, where: SQL | undefined, limit: number, byId = false) {
  return db
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
    .orderBy(...(byId ? [desc(auditEvents.id)] : [desc(auditEvents.occurredAt), desc(auditEvents.id)]))
    .limit(limit);
}

type AuditRow = Awaited<ReturnType<typeof selectRows>>[number];

function csvLine(e: AuditRow): string {
  return [
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
    .join(",");
}

/**
 * A CSV export is an inspection copy (P11-02): it must be complete, so no
 * row cap. Keyset-paged batches keep memory flat however large the trail is.
 * The cursor is the id alone — a JS Date cursor truncates Postgres's
 * microsecond timestamps and silently drops rows — so the export is ordered
 * by id (insertion order, newest first) rather than the UI's timestamp sort.
 */
function csvStream(
  db: Db,
  conditions: SQL[],
  mask?: (rows: AuditRow[]) => Promise<AuditRow[]>,
): Readable {
  async function* chunks() {
    yield `${CSV_HEADER}\n`;
    let cursor: bigint | undefined;
    for (;;) {
      const page =
        cursor === undefined ? conditions : [...conditions, lt(auditEvents.id, cursor)];
      const batch = await selectRows(db, and(...page), CSV_BATCH, true);
      const last = batch.at(-1);
      if (!last) return;
      cursor = last.id;
      const visible = mask ? await mask(batch) : batch;
      yield `${visible.map(csvLine).join("\n")}\n`;
    }
  }
  // objectMode defaults to true for Readable.from; the reply needs bytes.
  return Readable.from(chunks(), { objectMode: false });
}

/**
 * The E6(R3) audit review surface (E6-03): the trail is not just stored but
 * reviewable — filterable by action, entity, actor, and time, and exportable
 * as CSV for inspection copies (P11-05). Read-only by construction; the
 * table itself rejects UPDATE/DELETE by trigger.
 *
 * Two scopes: per-study (`audit.review`-gated, blinding-masked) and system
 * (`/admin/audit`, system-administration scope) for the events written with
 * no study — logins, account lifecycle, cross-study role changes — which
 * would otherwise be recorded but unreviewable.
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

    // Blinded audit review: reviewers without data.unblind see who/when/why
    // for blinded items, but not the values themselves.
    const unblinded = await canUnblind(app.db, request.user.id, { studyId });

    if (f.format === "csv") {
      const mask = unblinded
        ? undefined
        : (rows: AuditRow[]) => maskBlindedAuditRows(app.db, studyId, rows);
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="audit-${studyId}.csv"`)
        .send(csvStream(app.db, conditions, mask));
    }

    const where = and(...conditions);
    const rows = await selectRows(app.db, where, f.limit).offset(f.offset);
    const visible = unblinded ? rows : await maskBlindedAuditRows(app.db, studyId, rows);
    const events = visible.map((row) => ({ ...row, id: String(row.id) }));

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

  // System-level events carry no study id, so no study-scoped permission can
  // reach them; system-administration scope mirrors /admin/access-log. No
  // blinding masking: nothing item-level is ever written without a study.
  app.get("/admin/audit", { preHandler: requireSystemAdmin() }, async (request, reply) => {
    const parsed = filterSchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const f = parsed.data;

    const conditions = [isNull(auditEvents.studyId)];
    if (f.action) conditions.push(eq(auditEvents.action, f.action));
    if (f.entityType) conditions.push(eq(auditEvents.entityType, f.entityType));
    if (f.entityId) conditions.push(eq(auditEvents.entityId, f.entityId));
    if (f.actor) conditions.push(eq(users.username, f.actor));
    if (f.from) conditions.push(gte(auditEvents.occurredAt, new Date(f.from)));
    if (f.to) conditions.push(lte(auditEvents.occurredAt, new Date(f.to)));

    if (f.format === "csv") {
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", 'attachment; filename="system-audit.csv"')
        .send(csvStream(app.db, conditions));
    }

    const where = and(...conditions);
    const rows = await selectRows(app.db, where, f.limit).offset(f.offset);
    const events = rows.map((row) => ({ ...row, id: String(row.id) }));

    const [{ total } = { total: 0 }] = await app.db
      .select({ total: sql<number>`count(*)::int` })
      .from(auditEvents)
      .innerJoin(users, eq(auditEvents.actorId, users.id))
      .where(where);
    const facets = await app.db
      .select({
        action: auditEvents.action,
        entityType: auditEvents.entityType,
      })
      .from(auditEvents)
      .where(isNull(auditEvents.studyId))
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
