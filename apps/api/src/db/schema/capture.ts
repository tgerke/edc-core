import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sites, studies, studyMetadataVersions } from "./studies.js";
import { users } from "./users.js";

// Pseudonymous by design: no direct identifiers live in clinical tables;
// the site holds the subjectKey → person link. Traceability: DP-01.
export const subjects = pgTable(
  "subjects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id),
    subjectKey: text("subject_key").notNull(),
    // Lifecycle is enforced by SUBJECT_TRANSITIONS (services/capture.ts);
    // history lives in the audit trail (subject.status_changed), not here.
    status: text("status", {
      enum: ["screening", "enrolled", "screen_failed", "completed", "withdrawn"],
    })
      .notNull()
      .default("screening"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("subject_key_unique").on(t.studyId, t.subjectKey)],
);

export const studyEventInstances = pgTable(
  "study_event_instances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => subjects.id),
    eventOid: text("event_oid").notNull(),
    repeatKey: integer("repeat_key").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("event_instance_unique").on(t.subjectId, t.eventOid, t.repeatKey)],
);

// Workflow states are the Part 11 operational-sequence check (P11-13);
// transitions are enforced server-side and audited.
export const formInstances = pgTable(
  "form_instances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studyEventInstanceId: uuid("study_event_instance_id")
      .notNull()
      .references(() => studyEventInstances.id),
    formOid: text("form_oid").notNull(),
    repeatKey: integer("repeat_key").notNull().default(1),
    // Which study build this form was captured under.
    metadataVersionId: uuid("metadata_version_id")
      .notNull()
      .references(() => studyMetadataVersions.id),
    status: text("status", {
      enum: ["not_started", "in_progress", "complete", "verified", "signed", "locked"],
    })
      .notNull()
      .default("not_started"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("form_instance_unique").on(t.studyEventInstanceId, t.formOid, t.repeatKey)],
);

// Append-only: every value change is a new row with version = previous + 1.
// UPDATE/DELETE are rejected by trigger (ADR-0002; P11-01). Current values
// are read via the item_values_current view. value null = value cleared.
export const itemValueVersions = pgTable(
  "item_value_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    formInstanceId: uuid("form_instance_id")
      .notNull()
      .references(() => formInstances.id),
    itemGroupOid: text("item_group_oid").notNull(),
    itemGroupRepeatKey: integer("item_group_repeat_key").notNull().default(1),
    itemOid: text("item_oid").notNull(),
    version: integer("version").notNull(),
    value: text("value"),
    reasonForChange: text("reason_for_change"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("item_value_version_unique").on(
      t.formInstanceId,
      t.itemGroupOid,
      t.itemGroupRepeatKey,
      t.itemOid,
      t.version,
    ),
    index("item_value_lookup").on(t.formInstanceId, t.itemOid),
  ],
);
