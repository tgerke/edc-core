import { bigserial, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
