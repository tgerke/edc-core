import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { studies, studyMetadataVersions } from "./studies.js";
import { users } from "./users.js";

/**
 * One row per amendment-migration run: re-pointing in-flight (unsigned) form
 * instances to a newer study build and re-running their edit checks. Progress
 * counters are updated as the run proceeds so the UI can poll; per-form
 * failures are recorded in `errors` and never abort the run.
 */
export const migrationRuns = pgTable("migration_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  studyId: uuid("study_id")
    .notNull()
    .references(() => studies.id),
  targetMetadataVersionId: uuid("target_metadata_version_id")
    .notNull()
    .references(() => studyMetadataVersions.id),
  startedBy: uuid("started_by")
    .notNull()
    .references(() => users.id),
  status: text("status", {
    enum: ["running", "completed", "completed_with_errors", "failed"],
  })
    .notNull()
    .default("running"),
  totalForms: integer("total_forms").notNull().default(0),
  processedForms: integer("processed_forms").notNull().default(0),
  skippedForms: integer("skipped_forms").notNull().default(0),
  failedForms: integer("failed_forms").notNull().default(0),
  errors: jsonb("errors").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});
