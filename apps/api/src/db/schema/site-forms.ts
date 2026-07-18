import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sites, studies, studyMetadataVersions } from "./studies.js";
import { users } from "./users.js";

// A site's named form-layout variant (BYOFW half B: sponsor governs the data,
// the site adapts the forms/workflow that capture it). The identity row is
// stable; the definitions live in versions below.
export const siteFormVariants = pgTable(
  "site_form_variants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id),
    name: text("name").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("site_form_variant_name_unique").on(t.studyId, t.siteId, t.name)],
);

// Append-only definition versions: every site edit inserts a new row (the
// prior stays for audit); status transitions are the one permitted mutation
// and each writes an audit event. A version targets one build
// (metadata_version_id) — amendments revalidate and carry or stale it.
export const siteFormVariantVersions = pgTable(
  "site_form_variant_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => siteFormVariants.id),
    version: integer("version").notNull(),
    metadataVersionId: uuid("metadata_version_id")
      .notNull()
      .references(() => studyMetadataVersions.id),
    definition: jsonb("definition").notNull(),
    status: text("status", {
      enum: ["draft", "submitted", "approved", "changes_requested", "retired", "stale"],
    })
      .notNull()
      .default("draft"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("site_form_variant_version_unique").on(t.variantId, t.version)],
);
