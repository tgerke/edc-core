import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
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

// Detected security anomalies (E6-06): the scheduler's periodic sweep over
// access_log and audit_events materialises each finding once — dedupe_key is
// unique, so re-scans are no-ops. Acknowledgement is the recorded response;
// it writes a security.anomaly_acknowledged audit event alongside the update.
export const securityAnomalies = pgTable(
  "security_anomalies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    kind: text("kind", {
      enum: ["failed_login_burst", "lockout", "session_binding_violation"],
    }).notNull(),
    severity: text("severity", { enum: ["warning", "critical"] }).notNull(),
    userId: uuid("user_id").references(() => users.id),
    ip: text("ip"),
    summary: text("summary").notNull(),
    /** Rule-specific evidence: counts, window bounds, source audit event id. */
    details: jsonb("details").notNull().default({}),
    dedupeKey: text("dedupe_key").notNull(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    acknowledgedBy: uuid("acknowledged_by").references(() => users.id),
    acknowledgedNote: text("acknowledged_note"),
  },
  (t) => [
    uniqueIndex("security_anomaly_dedupe").on(t.dedupeKey),
    index("security_anomaly_time").on(t.detectedAt),
  ],
);
