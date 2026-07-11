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
import { formInstances } from "./capture.js";
import { studies } from "./studies.js";
import { users } from "./users.js";

/**
 * A loaded medical dictionary (MedDRA or WHODrug). Global — dictionaries are
 * licensed, versioned reference data shared across studies, not study
 * content; edc-core ships none. Immutable after load: a new dictionary
 * release is a new row, never an update.
 */
export const dictionaries = pgTable(
  "dictionaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type", { enum: ["MedDRA", "WHODrug"] }).notNull(),
    /** Customer-supplied release label, e.g. "27.1" or "2026 Mar 1". */
    version: text("version").notNull(),
    termsCount: integer("terms_count").notNull().default(0),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("dictionary_type_version_unique").on(t.type, t.version)],
);

/**
 * One row per codable term: a MedDRA LLT with its full hierarchy path, or a
 * WHODrug drug name with its ATC assignment. `normalizedTerm` is the single
 * normalization (lowercase, trimmed, collapsed whitespace) used for both
 * exact-match auto-coding and workbench search.
 */
export const dictionaryTerms = pgTable(
  "dictionary_terms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dictionaryId: uuid("dictionary_id")
      .notNull()
      .references(() => dictionaries.id),
    /** MedDRA LLT code / WHODrug drug code. Unique within a dictionary. */
    code: text("code").notNull(),
    /** MedDRA LLT term / WHODrug drug name. */
    term: text("term").notNull(),
    normalizedTerm: text("normalized_term").notNull(),
    // MedDRA hierarchy (null for WHODrug)
    ptCode: text("pt_code"),
    ptTerm: text("pt_term"),
    hltCode: text("hlt_code"),
    hltTerm: text("hlt_term"),
    hlgtCode: text("hlgt_code"),
    hlgtTerm: text("hlgt_term"),
    socCode: text("soc_code"),
    socTerm: text("soc_term"),
    // WHODrug ATC assignment (null for MedDRA)
    atcCode: text("atc_code"),
    atcText: text("atc_text"),
  },
  (t) => [
    uniqueIndex("dictionary_term_code_unique").on(t.dictionaryId, t.code),
    index("dictionary_term_exact").on(t.dictionaryId, t.normalizedTerm),
    // A trigram GIN index for substring search is added in raw SQL (0013);
    // drizzle-orm has no gin_trgm_ops helper.
  ],
);

/**
 * Which dictionary a study codes against, per type. Mutable — rebinding to a
 * new dictionary release mid-study is routine and audited; history lives on
 * the codings themselves, each of which stamps the dictionary it used.
 */
export const studyDictionaries = pgTable(
  "study_dictionaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id),
    dictionaryType: text("dictionary_type", { enum: ["MedDRA", "WHODrug"] }).notNull(),
    dictionaryId: uuid("dictionary_id")
      .notNull()
      .references(() => dictionaries.id),
    updatedBy: uuid("updated_by")
      .notNull()
      .references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("study_dictionary_type_unique").on(t.studyId, t.dictionaryType)],
);

/**
 * One row per auto-coding run. Progress counters update as the driver
 * proceeds so the UI can poll; per-occurrence problems land in `issues`
 * (capped) and never abort the run. The assignments themselves live in the
 * append-only codings table with audit rows, so this table is operational.
 */
export const codingRuns = pgTable(
  "coding_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id),
    startedBy: uuid("started_by")
      .notNull()
      .references(() => users.id),
    status: text("status", {
      enum: ["running", "completed", "completed_with_errors", "failed"],
    })
      .notNull()
      .default("running"),
    totalOccurrences: integer("total_occurrences").notNull().default(0),
    processedOccurrences: integer("processed_occurrences").notNull().default(0),
    counts: jsonb("counts").notNull().default({}),
    issues: jsonb("issues").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("coding_run_study").on(t.studyId, t.createdAt)],
);

/**
 * Coding assignments, versioned per verbatim item occurrence exactly like
 * item_value_versions: append-only (0013 trigger), corrections append the
 * next version, a "cleared" row has null dictionary/code columns. Each row
 * snapshots the verbatim it coded and the full dictionary path, so reports
 * stay interpretable across dictionary rebinds and staleness is a read-time
 * comparison against item_values_current — codings never touch form
 * workflow state or signatures.
 */
export const codings = pgTable(
  "codings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id),
    formInstanceId: uuid("form_instance_id")
      .notNull()
      .references(() => formInstances.id),
    itemGroupOid: text("item_group_oid").notNull(),
    itemGroupRepeatKey: integer("item_group_repeat_key").notNull().default(1),
    itemOid: text("item_oid").notNull(),
    version: integer("version").notNull(),
    /** The item value this action was taken against. */
    verbatim: text("verbatim").notNull(),
    dictionaryId: uuid("dictionary_id").references(() => dictionaries.id),
    dictionaryVersion: text("dictionary_version"),
    code: text("code"),
    term: text("term"),
    ptCode: text("pt_code"),
    ptTerm: text("pt_term"),
    hltCode: text("hlt_code"),
    hltTerm: text("hlt_term"),
    hlgtCode: text("hlgt_code"),
    hlgtTerm: text("hlgt_term"),
    socCode: text("soc_code"),
    socTerm: text("soc_term"),
    atcCode: text("atc_code"),
    atcText: text("atc_text"),
    origin: text("origin", { enum: ["auto", "manual"] }).notNull(),
    codingRunId: uuid("coding_run_id").references(() => codingRuns.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("coding_version_unique").on(
      t.formInstanceId,
      t.itemGroupOid,
      t.itemGroupRepeatKey,
      t.itemOid,
      t.version,
    ),
    index("coding_study").on(t.studyId, t.createdAt),
  ],
);
