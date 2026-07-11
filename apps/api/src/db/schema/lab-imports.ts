import {
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

/**
 * A named per-study mapping from a central lab's CSV layout (column names,
 * visit labels, test codes) onto build OIDs. Mutable — labs change file
 * layouts mid-study — so every create/update writes an audit event carrying
 * the full old/new config. Runs snapshot the config they executed with.
 */
export const labImportMappings = pgTable(
  "lab_import_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id),
    name: text("name").notNull(),
    config: jsonb("config").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by")
      .notNull()
      .references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("lab_import_mapping_name_unique").on(t.studyId, t.name)],
);

/**
 * One row per lab-import run. Progress counters update as the driver
 * proceeds so the UI can poll; row-level problems land in `issues` (capped)
 * and never abort the run. The imported values themselves live where all
 * clinical data lives — append-only item_value_versions with audit rows —
 * so this table is operational, not part of the trail.
 */
export const labImportRuns = pgTable(
  "lab_import_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id),
    mappingId: uuid("mapping_id")
      .notNull()
      .references(() => labImportMappings.id),
    /** Snapshot at execution: the report stays interpretable after mapping edits. */
    mappingConfig: jsonb("mapping_config").notNull(),
    fileName: text("file_name"),
    startedBy: uuid("started_by")
      .notNull()
      .references(() => users.id),
    status: text("status", {
      enum: ["running", "completed", "completed_with_errors", "failed"],
    })
      .notNull()
      .default("running"),
    totalRows: integer("total_rows").notNull().default(0),
    processedRows: integer("processed_rows").notNull().default(0),
    counts: jsonb("counts").notNull().default({}),
    issues: jsonb("issues").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("lab_import_run_study").on(t.studyId, t.createdAt)],
);
