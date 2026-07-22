import {
  bigint,
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

// One row per published point-in-time dataset (E6-07). The actual data lives
// in DuckLake (Parquet files cataloged in this same Postgres, schema
// "ducklake"); lakeVersion pins the DuckLake snapshot, so readers use
// `AT (VERSION => lakeVersion)` and the dataset stays immutable no matter
// how many snapshots are published after it.
export const snapshots = pgTable(
  "snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id),
    note: text("note"),
    status: text("status", { enum: ["pending", "published", "failed"] })
      .notNull()
      .default("pending"),
    // Lake schema holding this study's tables, e.g. study_st_demo_001.
    schemaName: text("schema_name").notNull(),
    lakeVersion: bigint("lake_version", { mode: "bigint" }),
    // SnapshotManifest: tables published, their ODM origins, and column maps.
    manifest: jsonb("manifest"),
    error: text("error"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [index("snapshot_study_idx").on(t.studyId, t.createdAt)],
);

// Saved workbench scripts. Content is versioned (E6-04: traceable
// transformations) — saving appends a new version row, never rewrites.
export const workbenchScripts = pgTable(
  "workbench_scripts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id),
    name: text("name").notNull(),
    language: text("language", { enum: ["r", "python", "sql"] }).notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("workbench_script_name_unique").on(t.studyId, t.name)],
);

export const workbenchScriptVersions = pgTable(
  "workbench_script_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scriptId: uuid("script_id")
      .notNull()
      .references(() => workbenchScripts.id),
    version: integer("version").notNull(),
    content: text("content").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("workbench_script_version_unique").on(t.scriptId, t.version)],
);

// One row per workbench execution: exact content run, pinned snapshot, and
// outcome — the E6-04 evidence trail for data transformations. R/Python
// runs also persist logs and outputs; SQL results are not stored (rerunning
// the content against the pinned snapshot reproduces them).
export const workbenchExecutions = pgTable(
  "workbench_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => snapshots.id),
    scriptId: uuid("script_id").references(() => workbenchScripts.id),
    scriptVersion: integer("script_version"),
    language: text("language", { enum: ["r", "python", "sql"] }).notNull(),
    content: text("content").notNull(),
    status: text("status", { enum: ["succeeded", "failed"] }).notNull(),
    stdout: text("stdout"),
    error: text("error"),
    result: jsonb("result"),
    elapsedMs: integer("elapsed_ms"),
    executedBy: uuid("executed_by")
      .notNull()
      .references(() => users.id),
    executedAt: timestamp("executed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workbench_execution_study_idx").on(t.studyId, t.executedAt)],
);
