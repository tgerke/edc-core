import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { studies } from "./studies.js";
import { users } from "./users.js";

// The Part 11 audit trail (P11-01): one row per create/modify/state-change,
// written in the same transaction as the change it records. Append-only,
// enforced by trigger — see migration 0001_audit_triggers.
export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    studyId: uuid("study_id").references(() => studies.id),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    oldValue: jsonb("old_value"),
    newValue: jsonb("new_value"),
    reason: text("reason"),
  },
  (t) => [
    index("audit_entity_lookup").on(t.entityType, t.entityId),
    index("audit_study_time").on(t.studyId, t.occurredAt),
  ],
);

// Structured access log (P11-14, §11.10(h) device checks): one row per API
// request, written on response. Operational telemetry, not the audit trail —
// auth events (login, lockout, binding violations) still go to audit_events.
// user_id is null for unauthenticated requests; session_id is deliberately
// not a FK so log retention never couples to session housekeeping.
export const accessLog = pgTable(
  "access_log",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    userId: uuid("user_id").references(() => users.id),
    sessionId: uuid("session_id"),
    method: text("method").notNull(),
    // Pathname only — query strings can carry tokens or filter values.
    path: text("path").notNull(),
    route: text("route"),
    statusCode: integer("status_code").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    durationMs: integer("duration_ms"),
  },
  (t) => [
    index("access_log_time").on(t.occurredAt),
    index("access_log_user_time").on(t.userId, t.occurredAt),
  ],
);
