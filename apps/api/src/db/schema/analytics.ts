import { bigint, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
