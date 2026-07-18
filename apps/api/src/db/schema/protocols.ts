import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { studies, studyMetadataVersions } from "./studies.js";
import { users } from "./users.js";

// One row per imported protocol document version (raw USDM wrapper JSON,
// stored whole). The protocol is a first-class artifact alongside — not
// inside — study builds: one protocol version may go through several
// compilation iterations before one publishes. Append-only like
// study_metadata_versions (trigger in 0021_protocols.sql).
export const protocolVersions = pgTable(
  "protocol_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id),
    version: integer("version").notNull(),
    usdmVersion: text("usdm_version").notNull(),
    package: jsonb("package").notNull(),
    note: text("note"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("protocol_version_unique").on(t.studyId, t.version)],
);

// Review workspace for a compiled protocol: the candidate build definition
// stays mutable (draft-item resolution) until published, at which point the
// immutable copy lives in study_metadata_versions and this row just records
// the link. Deliberately NOT append-only — it is scratch state, and every
// edit writes an audit event.
export const protocolCompilations = pgTable("protocol_compilations", {
  id: uuid("id").primaryKey().defaultRandom(),
  protocolVersionId: uuid("protocol_version_id")
    .notNull()
    .references(() => protocolVersions.id),
  candidate: jsonb("candidate").notNull(),
  // Denormalized from candidate for queue badges and the publish gate.
  unresolvedCount: integer("unresolved_count").notNull().default(0),
  traceability: jsonb("traceability").notNull().default([]),
  warnings: jsonb("warnings").notNull().default([]),
  status: text("status", { enum: ["in_review", "published", "discarded"] })
    .notNull()
    .default("in_review"),
  publishedMetadataVersionId: uuid("published_metadata_version_id").references(
    () => studyMetadataVersions.id,
  ),
  updatedBy: uuid("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Derived at publish time from the compiler's trace rows; regenerable, kept
// relational so "which items derive from BC X" is a join, not a jsonb unpack.
export const protocolTraceability = pgTable("protocol_traceability", {
  id: uuid("id").primaryKey().defaultRandom(),
  metadataVersionId: uuid("metadata_version_id")
    .notNull()
    .references(() => studyMetadataVersions.id),
  protocolVersionId: uuid("protocol_version_id")
    .notNull()
    .references(() => protocolVersions.id),
  odmOid: text("odm_oid").notNull(),
  odmType: text("odm_type", { enum: ["event", "form", "item", "codelist"] }).notNull(),
  usdmId: text("usdm_id").notNull(),
  usdmInstanceType: text("usdm_instance_type").notNull(),
  relation: text("relation", { enum: ["derived_from", "placeholder_for"] }).notNull(),
});
