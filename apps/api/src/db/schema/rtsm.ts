import { boolean, index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { itemValueVersions, subjects } from "./capture.js";
import { apiKeys } from "./integrations.js";
import { studies } from "./studies.js";
import { users } from "./users.js";

/**
 * Per-study RTSM intake wiring: which eCRF item an incoming randomization
 * arm lands on. Deployment configuration, not protocol metadata — it names
 * build OIDs but does not define them, so it lives in a table (like
 * lab_import_mappings), is mutable, and every change writes an audit event
 * with the full old/new config.
 */
export const rtsmConfigs = pgTable("rtsm_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  studyId: uuid("study_id")
    .notNull()
    .references(() => studies.id)
    .unique(),
  eventOid: text("event_oid").notNull(),
  formOid: text("form_oid").notNull(),
  itemGroupOid: text("item_group_oid").notNull(),
  itemOid: text("item_oid").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by")
    .notNull()
    .references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Append-only wire record of every assignment POST, including rejects
 * (enforced by the rtsm_events_append_only trigger). The full payload is
 * stored so external transfers can be reconciled against the RTSM's own log;
 * because the payload carries the arm, the events listing masks it for
 * viewers without data.unblind. The arm value itself lives in
 * item_value_versions (item_value_version_id links the applied write) — this
 * table is transfer evidence, deliberately excluded from the analytics lake.
 */
export const rtsmEvents = pgTable(
  "rtsm_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id),
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKeys.id),
    /** Null when the outcome is rejected for an unknown subject. */
    subjectId: uuid("subject_id").references(() => subjects.id),
    /** As received on the wire, even when no subject matches. */
    subjectKey: text("subject_key").notNull(),
    randomizationId: text("randomization_id").notNull(),
    payload: jsonb("payload").notNull(),
    outcome: text("outcome", {
      enum: ["applied", "duplicate", "conflict", "rejected"],
    }).notNull(),
    reason: text("reason"),
    itemValueVersionId: uuid("item_value_version_id").references(() => itemValueVersions.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("rtsm_event_study").on(t.studyId, t.createdAt),
    index("rtsm_event_randomization").on(t.studyId, t.randomizationId),
  ],
);
