import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const studies = pgTable("studies", {
  id: uuid("id").primaryKey().defaultRandom(),
  oid: text("oid").notNull().unique(),
  name: text("name").notNull(),
  protocolName: text("protocol_name"),
  status: text("status", { enum: ["design", "active", "locked", "archived"] })
    .notNull()
    .default("design"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sites = pgTable(
  "sites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id),
    oid: text("oid").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("site_oid_unique").on(t.studyId, t.oid)],
);

// One row per published study build. The ODM-shaped definition (events, forms,
// item groups, items, codelists, conditions) is stored whole as jsonb; Phase 2
// adds relational projections where the builder needs to query into it.
// Versions are immutable once published — edits create a new version.
export const studyMetadataVersions = pgTable(
  "study_metadata_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id),
    version: integer("version").notNull(),
    definition: jsonb("definition").notNull(),
    note: text("note"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("study_metadata_version_unique").on(t.studyId, t.version)],
);
