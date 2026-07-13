import type { MetaDataVersion } from "@edc-core/odm";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import {
  auditEvents,
  formInstances,
  labImportMappings,
  labImportRuns,
  sites,
  studyEventInstances,
  studyMetadataVersions,
  subjects,
} from "../db/schema/index.js";
import { castable } from "./amendments.js";
import { blindedItemOids, canUnblind } from "./blinding.js";
import {
  CaptureError,
  ensureFormInstance,
  INTAKE_BLOCKED_STATUSES,
  latestMetadataVersion,
  resolveFormContext,
  type SubjectStatus,
  writeItemValue,
} from "./capture.js";
import { evaluateFormChecks } from "./checks.js";
import type { StudyBuildDefinition } from "./study-builds.js";

/**
 * Lab data import: central-lab CSV batches (tall format, one row per test
 * result) land on ordinary eCRF forms through the standard audited write
 * path, so audit, edit checks, blinding, SDV, signing, casebooks, and the
 * analytics lake all apply by construction. Imports never overwrite: an
 * identical existing value is skipped (re-imports are idempotent) and a
 * differing one is reported as a conflict for a human to resolve.
 */

const BATCH_SIZE = 50;
const MAX_RECORDED_ISSUES = 200;

// ── Mapping config ─────────────────────────────────────────────────────────

const oidPlacementSchema = z.object({
  itemGroupOid: z.string().min(1),
  itemOid: z.string().min(1),
});

const testTargetSchema = oidPlacementSchema.extend({
  unitItemOid: z.string().min(1).optional(),
});

export const labImportConfigSchema = z.object({
  formOid: z.string().min(1),
  columns: z.object({
    subjectKey: z.string().min(1),
    siteOid: z.string().min(1).optional(),
    visit: z.string().min(1),
    testCode: z.string().min(1),
    result: z.string().min(1),
    unit: z.string().min(1).optional(),
    collectionDate: z.string().min(1).optional(),
  }),
  /** Visit-column label (matched case-insensitively) → StudyEventDef OID. */
  visitMap: z.record(z.string().min(1), z.string().min(1)),
  /** Test-code-column value → where the result (and optional unit) lands. */
  tests: z.record(z.string().min(1), testTargetSchema),
  /** Written once per form instance when columns.collectionDate is set. */
  collectionDateItem: oidPlacementSchema.optional(),
});
export type LabImportConfig = z.infer<typeof labImportConfigSchema>;

// ── CSV parsing (RFC 4180) ─────────────────────────────────────────────────

export interface CsvRecord {
  /** 1-based line the record starts on (quoted fields may span lines). */
  line: number;
  fields: string[];
}

/**
 * Minimal RFC 4180 parser: quoted fields, doubled-quote escapes, embedded
 * commas/newlines, CRLF or LF. The repo hand-rolls CSV writing already;
 * a dependency for this is not warranted. Throws on structural problems
 * (unterminated quote, ragged rows) — a malformed file fails whole.
 */
export function parseCsv(content: string): { header: string[]; rows: CsvRecord[] } {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let recordStartLine = 1;

  const endField = () => {
    fields.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    // A record of one empty field is a blank line; skip it.
    if (!(fields.length === 1 && fields[0] === "")) {
      records.push({ line: recordStartLine, fields });
    }
    fields = [];
    recordStartLine = line;
  };

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\n") {
      line++;
      endRecord();
    } else if (ch === "\r") {
      if (content[i + 1] !== "\n") {
        line++;
        endRecord();
      }
    } else {
      field += ch;
    }
  }
  if (inQuotes) throw new CaptureError("invalid", "CSV ends inside a quoted field");
  if (field !== "" || fields.length > 0) endRecord();

  const [headerRecord, ...rows] = records;
  if (!headerRecord) throw new CaptureError("invalid", "CSV file is empty");
  const width = headerRecord.fields.length;
  for (const row of rows) {
    if (row.fields.length !== width) {
      throw new CaptureError(
        "invalid",
        `CSV line ${row.line}: expected ${width} fields, got ${row.fields.length}`,
      );
    }
  }
  return { header: headerRecord.fields, rows };
}

// ── Row outcomes ───────────────────────────────────────────────────────────

export const ROW_OUTCOMES = [
  "imported",
  "skipped_unchanged",
  "conflict_existing_value",
  "skipped_form_status",
  "skipped_subject_status",
  "skipped_blinded",
  "error_no_subject",
  "error_site_mismatch",
  "error_no_event",
  "error_unknown_test",
  "error_bad_value",
  "skipped_pinned_build",
  "error_write_failed",
] as const;
export type RowOutcome = (typeof ROW_OUTCOMES)[number];

export interface LabImportIssue {
  line: number;
  subjectKey: string;
  testCode: string;
  outcome: RowOutcome;
  message: string;
}

export type OutcomeCounts = Partial<Record<RowOutcome, number>>;

export interface LabImportPreview {
  totalRows: number;
  counts: OutcomeCounts;
  issues: LabImportIssue[];
  issuesTruncated: boolean;
  formsTouched: number;
  formInstancesToCreate: number;
}

/** One value a row wants to place. `label` names it in issue messages. */
interface RowTarget {
  itemGroupOid: string;
  itemOid: string;
  value: string;
  label: "result" | "unit" | "collection date";
  blinded: boolean;
}

interface PendingRow {
  line: number;
  subjectKey: string;
  testCode: string;
  targets: RowTarget[];
}

interface FormGroup {
  subjectId: string;
  subjectKey: string;
  siteId: string;
  eventOid: string;
  rows: PendingRow[];
}

/** Everything the driver needs; `preview` is what the validate route returns. */
export interface LabImportPlan {
  mapping: { id: string; name: string };
  config: LabImportConfig;
  totalRows: number;
  formOid: string;
  preview: LabImportPreview;
  /** Rows that passed static validation, grouped by target form instance.
   * Form status and existing-value comparisons are re-derived inside each
   * form's transaction at execute time — the preview's versions of those
   * outcomes are advisory. */
  groups: FormGroup[];
  /** Outcomes settled at analyze time (bad rows); final for the run. */
  staticCounts: OutcomeCounts;
  staticIssues: LabImportIssue[];
  staticRows: number;
}

class OutcomeCollector {
  counts: OutcomeCounts = {};
  issues: LabImportIssue[] = [];
  truncated = false;

  add(outcome: RowOutcome, issue?: Omit<LabImportIssue, "outcome">) {
    this.counts[outcome] = (this.counts[outcome] ?? 0) + 1;
    if (issue && outcome !== "imported" && outcome !== "skipped_unchanged") {
      if (this.issues.length < MAX_RECORDED_ISSUES) this.issues.push({ ...issue, outcome });
      else this.truncated = true;
    }
  }
}

function mergeCounts(into: OutcomeCounts, from: OutcomeCounts): OutcomeCounts {
  for (const [key, value] of Object.entries(from)) {
    const outcome = key as RowOutcome;
    into[outcome] = (into[outcome] ?? 0) + (value ?? 0);
  }
  return into;
}

// ── Build lookups ──────────────────────────────────────────────────────────

/** Group OIDs reachable from the form via nested ItemGroupRefs. */
function formGroupOids(mdv: MetaDataVersion, formOid: string): Set<string> {
  const byOid = new Map(mdv.itemGroupDefs.map((g) => [g.oid, g]));
  const reachable = new Set<string>();
  const queue = [formOid];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (reachable.has(oid)) continue;
    reachable.add(oid);
    const def = byOid.get(oid);
    for (const ref of def?.itemGroupRefs ?? []) queue.push(ref.itemGroupOid);
  }
  return reachable;
}

function placementExists(mdv: MetaDataVersion, itemGroupOid: string, itemOid: string): boolean {
  const group = mdv.itemGroupDefs.find((g) => g.oid === itemGroupOid);
  return group?.itemRefs.some((ref) => ref.itemOid === itemOid) ?? false;
}

// ── Analyze (shared by dry-run and execute) ────────────────────────────────

export interface LabImportInput {
  studyId: string;
  mappingId: string;
  content: string;
  actorId: string;
}

export async function analyzeLabImport(db: Db, input: LabImportInput): Promise<LabImportPlan> {
  const [mapping] = await db
    .select()
    .from(labImportMappings)
    .where(
      and(eq(labImportMappings.id, input.mappingId), eq(labImportMappings.studyId, input.studyId)),
    )
    .limit(1);
  if (!mapping) throw new CaptureError("not_found", "lab import mapping not found");

  const configParsed = labImportConfigSchema.safeParse(mapping.config);
  if (!configParsed.success) {
    throw new CaptureError("invalid", `mapping config is invalid: ${configParsed.error.message}`);
  }
  const config = configParsed.data;

  const mdvRow = await latestMetadataVersion(db, input.studyId);
  if (!mdvRow) throw new CaptureError("invalid", "study has no published build");
  const mdv = (mdvRow.definition as unknown as StudyBuildDefinition).metaDataVersion;

  // Structural checks against the latest build — a config that references
  // missing OIDs fails whole rather than producing per-row noise.
  const form = mdv.itemGroupDefs.find((g) => g.oid === config.formOid);
  if (!form) throw new CaptureError("invalid", `form ${config.formOid} not found in latest build`);
  for (const [label, eventOid] of Object.entries(config.visitMap)) {
    const event = mdv.studyEventDefs.find((e) => e.oid === eventOid);
    if (!event) {
      throw new CaptureError("invalid", `visitMap "${label}": event ${eventOid} not in build`);
    }
    if (!event.itemGroupRefs.some((ref) => ref.itemGroupOid === config.formOid)) {
      throw new CaptureError(
        "invalid",
        `visitMap "${label}": event ${eventOid} does not include form ${config.formOid}`,
      );
    }
  }
  const groupOids = formGroupOids(mdv, config.formOid);
  const itemDefs = new Map(mdv.itemDefs.map((item) => [item.oid, item]));
  const checkPlacement = (where: string, itemGroupOid: string, itemOid: string) => {
    if (!groupOids.has(itemGroupOid)) {
      throw new CaptureError(
        "invalid",
        `${where}: group ${itemGroupOid} is not part of form ${config.formOid}`,
      );
    }
    if (!placementExists(mdv, itemGroupOid, itemOid)) {
      throw new CaptureError("invalid", `${where}: item ${itemOid} not in group ${itemGroupOid}`);
    }
    if (!itemDefs.has(itemOid)) {
      throw new CaptureError("invalid", `${where}: item ${itemOid} has no ItemDef`);
    }
  };
  for (const [code, target] of Object.entries(config.tests)) {
    checkPlacement(`test "${code}"`, target.itemGroupOid, target.itemOid);
    if (target.unitItemOid) {
      checkPlacement(`test "${code}" unit`, target.itemGroupOid, target.unitItemOid);
    }
  }
  if (config.collectionDateItem) {
    checkPlacement(
      "collectionDateItem",
      config.collectionDateItem.itemGroupOid,
      config.collectionDateItem.itemOid,
    );
  }

  const { header, rows } = parseCsv(input.content);
  const columnIndex = new Map<string, number>();
  header.forEach((name, i) => {
    if (!columnIndex.has(name)) columnIndex.set(name, i);
  });
  for (const name of Object.values(config.columns)) {
    if (name !== undefined && !columnIndex.has(name)) {
      throw new CaptureError("invalid", `CSV is missing mapped column "${name}"`);
    }
  }
  const col = (row: CsvRecord, name: string | undefined): string =>
    name === undefined ? "" : (row.fields[columnIndex.get(name) as number] ?? "").trim();

  const studySubjects = await db
    .select({
      id: subjects.id,
      subjectKey: subjects.subjectKey,
      siteId: subjects.siteId,
      status: subjects.status,
    })
    .from(subjects)
    .where(eq(subjects.studyId, input.studyId));
  const subjectsByKey = new Map(studySubjects.map((s) => [s.subjectKey, s]));
  const studySites = await db
    .select({ id: sites.id, oid: sites.oid })
    .from(sites)
    .where(eq(sites.studyId, input.studyId));
  const siteOidById = new Map(studySites.map((s) => [s.id, s.oid]));

  const blinded = blindedItemOids(mdv);
  const unblindBySite = new Map<string, boolean>();
  const importerCanUnblind = async (siteId: string): Promise<boolean> => {
    const cached = unblindBySite.get(siteId);
    if (cached !== undefined) return cached;
    const allowed = await canUnblind(db, input.actorId, { studyId: input.studyId, siteId });
    unblindBySite.set(siteId, allowed);
    return allowed;
  };

  const visitMap = new Map(
    Object.entries(config.visitMap).map(([label, oid]) => [label.trim().toUpperCase(), oid]),
  );

  const staticOutcomes = new OutcomeCollector();
  const groups = new Map<string, FormGroup>();

  for (const row of rows) {
    const subjectKey = col(row, config.columns.subjectKey);
    const testCode = col(row, config.columns.testCode);
    const issueBase = { line: row.line, subjectKey, testCode };

    const subject = subjectsByKey.get(subjectKey);
    if (!subject) {
      staticOutcomes.add("error_no_subject", {
        ...issueBase,
        message:
          subjectKey === "" ? "subject key is empty" : `subject "${subjectKey}" is not enrolled`,
      });
      continue;
    }
    // Status-aware intake (#67): rows for subjects who are out of the study
    // are skipped and reported, like conflicts — never written silently.
    if (INTAKE_BLOCKED_STATUSES.includes(subject.status as SubjectStatus)) {
      staticOutcomes.add("skipped_subject_status", {
        ...issueBase,
        message: `subject "${subjectKey}" is ${subject.status}; reinstate before importing`,
      });
      continue;
    }
    if (config.columns.siteOid) {
      const fileSite = col(row, config.columns.siteOid);
      const actualSite = siteOidById.get(subject.siteId);
      if (fileSite !== actualSite) {
        staticOutcomes.add("error_site_mismatch", {
          ...issueBase,
          message: `file says site "${fileSite}" but subject is at site "${actualSite}"`,
        });
        continue;
      }
    }
    const visitLabel = col(row, config.columns.visit);
    const eventOid = visitMap.get(visitLabel.toUpperCase());
    if (!eventOid) {
      staticOutcomes.add("error_no_event", {
        ...issueBase,
        message: `visit "${visitLabel}" is not in the mapping's visitMap`,
      });
      continue;
    }
    const target = config.tests[testCode];
    if (!target) {
      staticOutcomes.add("error_unknown_test", {
        ...issueBase,
        message: `test code "${testCode}" is not in the mapping`,
      });
      continue;
    }

    const targets: RowTarget[] = [];
    const result = col(row, config.columns.result);
    // biome-ignore lint/style/noNonNullAssertion: placement checked above
    const resultDef = itemDefs.get(target.itemOid)!;
    if (result === "" || !castable(result, resultDef.dataType)) {
      staticOutcomes.add("error_bad_value", {
        ...issueBase,
        message:
          result === ""
            ? "result is empty"
            : `result "${result}" is not a valid ${resultDef.dataType}`,
      });
      continue;
    }
    targets.push({
      itemGroupOid: target.itemGroupOid,
      itemOid: target.itemOid,
      value: result,
      label: "result",
      blinded: blinded.has(target.itemOid),
    });

    if (config.columns.unit && target.unitItemOid) {
      const unit = col(row, config.columns.unit);
      if (unit !== "") {
        targets.push({
          itemGroupOid: target.itemGroupOid,
          itemOid: target.unitItemOid,
          value: unit,
          label: "unit",
          blinded: blinded.has(target.unitItemOid),
        });
      }
    }
    if (config.columns.collectionDate && config.collectionDateItem) {
      const date = col(row, config.columns.collectionDate);
      if (date !== "") {
        // biome-ignore lint/style/noNonNullAssertion: placement checked above
        const dateDef = itemDefs.get(config.collectionDateItem.itemOid)!;
        if (!castable(date, dateDef.dataType)) {
          staticOutcomes.add("error_bad_value", {
            ...issueBase,
            message: `collection date "${date}" is not a valid ${dateDef.dataType}`,
          });
          continue;
        }
        targets.push({
          itemGroupOid: config.collectionDateItem.itemGroupOid,
          itemOid: config.collectionDateItem.itemOid,
          value: date,
          label: "collection date",
          blinded: blinded.has(config.collectionDateItem.itemOid),
        });
      }
    }

    if (targets.some((t) => t.blinded) && !(await importerCanUnblind(subject.siteId))) {
      staticOutcomes.add("skipped_blinded", {
        ...issueBase,
        message: "row targets a blinded item and you do not hold data.unblind for this site",
      });
      continue;
    }

    const groupKey = `${subject.id}:${eventOid}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = { subjectId: subject.id, subjectKey, siteId: subject.siteId, eventOid, rows: [] };
      groups.set(groupKey, group);
    }
    group.rows.push({ line: row.line, subjectKey, testCode, targets });
  }

  let groupList = [...groups.values()];
  const existingByKey = new Map<
    string,
    { formInstanceId: string; status: string; metadataVersionId: string }
  >();
  const subjectIds = [...new Set(groupList.map((g) => g.subjectId))];
  if (subjectIds.length > 0) {
    const existing = await db
      .select({
        subjectId: studyEventInstances.subjectId,
        eventOid: studyEventInstances.eventOid,
        formInstanceId: formInstances.id,
        status: formInstances.status,
        metadataVersionId: formInstances.metadataVersionId,
      })
      .from(formInstances)
      .innerJoin(
        studyEventInstances,
        eq(formInstances.studyEventInstanceId, studyEventInstances.id),
      )
      .where(
        and(
          inArray(studyEventInstances.subjectId, subjectIds),
          eq(studyEventInstances.repeatKey, 1),
          eq(formInstances.formOid, config.formOid),
          eq(formInstances.repeatKey, 1),
        ),
      );
    for (const row of existing) {
      existingByKey.set(`${row.subjectId}:${row.eventOid}`, row);
    }
  }

  // A form pinned to an older build only renders items that build defines.
  // Rows whose targets are missing from the pinned build are skipped rather
  // than stored invisibly — run the amendment migration first.
  const pinnedBuilds = new Map<string, MetaDataVersion>();
  for (const group of groupList) {
    const existing = existingByKey.get(`${group.subjectId}:${group.eventOid}`);
    if (!existing || existing.metadataVersionId === mdvRow.id) continue;
    let pinned = pinnedBuilds.get(existing.metadataVersionId);
    if (!pinned) {
      const [row] = await db
        .select({ definition: studyMetadataVersions.definition })
        .from(studyMetadataVersions)
        .where(eq(studyMetadataVersions.id, existing.metadataVersionId))
        .limit(1);
      if (!row) continue;
      pinned = (row.definition as unknown as StudyBuildDefinition).metaDataVersion;
      pinnedBuilds.set(existing.metadataVersionId, pinned);
    }
    const pinnedMdv = pinned;
    group.rows = group.rows.filter((row) => {
      const missing = row.targets.find(
        (t) => !placementExists(pinnedMdv, t.itemGroupOid, t.itemOid),
      );
      if (!missing) return true;
      staticOutcomes.add("skipped_pinned_build", {
        line: row.line,
        subjectKey: row.subjectKey,
        testCode: row.testCode,
        message: `form is pinned to an older build without item ${missing.itemOid}; run the amendment migration first`,
      });
      return false;
    });
  }
  groupList = groupList.filter((g) => g.rows.length > 0);

  // Preview-only pass: classify pending rows against current form statuses
  // and values. The driver re-derives these inside each form's transaction,
  // so between validate and execute the preview can drift — the run report
  // is the truth.
  const preview = new OutcomeCollector();
  preview.counts = mergeCounts({}, staticOutcomes.counts);
  preview.issues = [...staticOutcomes.issues];
  preview.truncated = staticOutcomes.truncated;
  const existingIds = [...existingByKey.values()].map((e) => e.formInstanceId);
  const currentValues = new Map<string, string | null>();
  if (existingIds.length > 0) {
    const valueRows = await db.execute<{
      form_instance_id: string;
      item_group_oid: string;
      item_group_repeat_key: number;
      item_oid: string;
      value: string | null;
    }>(sql`
      SELECT form_instance_id, item_group_oid, item_group_repeat_key, item_oid, value
      FROM item_values_current
      WHERE form_instance_id IN (${sql.join(
        existingIds.map((id) => sql`${id}`),
        sql`, `,
      )})
    `);
    for (const row of valueRows) {
      if (row.item_group_repeat_key !== 1) continue;
      currentValues.set(`${row.form_instance_id}:${row.item_group_oid}:${row.item_oid}`, row.value);
    }
  }

  let formInstancesToCreate = 0;
  for (const group of groupList) {
    const existing = existingByKey.get(`${group.subjectId}:${group.eventOid}`);
    if (!existing) formInstancesToCreate += 1;
    const writable =
      !existing || existing.status === "not_started" || existing.status === "in_progress";
    // Values already placed earlier in this same file count as "existing"
    // for later duplicate rows, matching what the driver will do.
    const seen = new Map<string, string>();
    for (const row of group.rows) {
      const issueBase = { line: row.line, subjectKey: row.subjectKey, testCode: row.testCode };
      if (!writable) {
        preview.add("skipped_form_status", {
          ...issueBase,
          message: `form is ${existing?.status}; reopen it before importing`,
        });
        continue;
      }
      const verdict = classifyRow(
        row,
        (t) => {
          const key = `${t.itemGroupOid}:${t.itemOid}`;
          const fromFile = seen.get(key);
          if (fromFile !== undefined) return fromFile;
          if (!existing) return undefined;
          return currentValues.get(`${existing.formInstanceId}:${key}`) ?? undefined;
        },
        (t) => seen.set(`${t.itemGroupOid}:${t.itemOid}`, t.value),
      );
      preview.add(verdict.outcome, { ...issueBase, message: verdict.message });
    }
  }

  return {
    mapping: { id: mapping.id, name: mapping.name },
    config,
    totalRows: rows.length,
    formOid: config.formOid,
    preview: {
      totalRows: rows.length,
      counts: preview.counts,
      issues: preview.issues,
      issuesTruncated: preview.truncated,
      formsTouched: groupList.length,
      formInstancesToCreate,
    },
    groups: groupList,
    staticCounts: staticOutcomes.counts,
    staticIssues: staticOutcomes.issues,
    staticRows: Object.values(staticOutcomes.counts).reduce((a, b) => a + (b ?? 0), 0),
  };
}

/**
 * Shared row semantics for preview and execute: each target is written when
 * absent, skipped when identical, and reported (never written) when it
 * differs. `lookup` answers "what value is there now"; `record` is called
 * for values that would be written so duplicate rows later in the same file
 * compare against them.
 */
function classifyRow(
  row: PendingRow,
  lookup: (t: RowTarget) => string | undefined,
  record: (t: RowTarget) => void,
): { outcome: RowOutcome; message: string; writes: RowTarget[] } {
  const writes: RowTarget[] = [];
  const conflicts: string[] = [];
  for (const target of row.targets) {
    const existing = lookup(target);
    if (existing === undefined) {
      writes.push(target);
      record(target);
    } else if (existing !== target.value) {
      conflicts.push(
        target.blinded
          ? `${target.label} differs from an existing (blinded) value`
          : `${target.label} "${target.value}" differs from existing "${existing}"`,
      );
    }
    // identical → nothing to do for this target
  }
  if (conflicts.length > 0) {
    return { outcome: "conflict_existing_value", message: conflicts.join("; "), writes };
  }
  if (writes.length > 0) return { outcome: "imported", message: "", writes };
  return { outcome: "skipped_unchanged", message: "", writes };
}

// ── Execute ────────────────────────────────────────────────────────────────

export async function startLabImport(
  db: Db,
  input: LabImportInput & { fileName?: string },
): Promise<{ run: typeof labImportRuns.$inferSelect; plan: LabImportPlan }> {
  const plan = await analyzeLabImport(db, input);

  const run = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`edc-core:lab-import:${input.studyId}`}, 0))`,
    );
    const [active] = await tx
      .select({ id: labImportRuns.id })
      .from(labImportRuns)
      .where(and(eq(labImportRuns.studyId, input.studyId), eq(labImportRuns.status, "running")))
      .limit(1);
    if (active) {
      throw new CaptureError("conflict", "a lab import is already running for this study");
    }
    const [inserted] = await tx
      .insert(labImportRuns)
      .values({
        studyId: input.studyId,
        mappingId: input.mappingId,
        mappingConfig: plan.config,
        fileName: input.fileName ?? null,
        startedBy: input.actorId,
        status: "running",
        totalRows: plan.totalRows,
      })
      .returning();
    if (!inserted) throw new Error("lab import run insert returned no row");
    await tx.insert(auditEvents).values({
      actorId: input.actorId,
      studyId: input.studyId,
      action: "lab_import.started",
      entityType: "lab_import_run",
      entityId: inserted.id,
      newValue: {
        mappingId: plan.mapping.id,
        mappingName: plan.mapping.name,
        fileName: input.fileName ?? null,
        totalRows: plan.totalRows,
      },
    });
    return inserted;
  });
  return { run, plan };
}

/**
 * The import driver: one transaction per target form instance, in bounded
 * batches, so a large file never holds one giant lock and a failure affects
 * only its form. Each form's instance creation, value writes, and edit-check
 * reconciliation commit together. The CSV itself is never stored — the plan
 * (parsed and statically validated by analyze) travels in memory, which is
 * why an interrupted run cannot resume and is swept to failed at boot.
 */
export async function runLabImportDriver(
  db: Db,
  runId: string,
  plan: LabImportPlan,
): Promise<void> {
  const [run] = await db.select().from(labImportRuns).where(eq(labImportRuns.id, runId)).limit(1);
  if (!run || run.status !== "running") return;

  const collector = new OutcomeCollector();
  collector.counts = mergeCounts({}, plan.staticCounts);
  collector.issues = [...plan.staticIssues];
  let processed = plan.staticRows;

  const finish = async (status: "completed" | "completed_with_errors" | "failed") => {
    await db
      .update(labImportRuns)
      .set({
        status,
        processedRows: processed,
        counts: collector.counts,
        issues: collector.issues,
        finishedAt: new Date(),
      })
      .where(eq(labImportRuns.id, runId));
    try {
      await db.insert(auditEvents).values({
        actorId: run.startedBy,
        studyId: run.studyId,
        action: status === "failed" ? "lab_import.failed" : "lab_import.completed",
        entityType: "lab_import_run",
        entityId: runId,
        newValue: { status, counts: collector.counts },
      });
    } catch {
      // the run row already tells the truth; the completion audit is best-effort
    }
  };

  try {
    for (let offset = 0; offset < plan.groups.length; offset += BATCH_SIZE) {
      const batch = plan.groups.slice(offset, offset + BATCH_SIZE);
      for (const group of batch) {
        try {
          await db.transaction(async (tx) => {
            const txDb = tx as unknown as Db;
            const form = await ensureFormInstance(txDb, {
              subjectId: group.subjectId,
              eventOid: group.eventOid,
              formOid: plan.formOid,
              actorId: run.startedBy,
            });
            let context = await resolveFormContext(txDb, form.id);
            if (!context) throw new Error("form context vanished");

            if (context.status !== "not_started" && context.status !== "in_progress") {
              for (const row of group.rows) {
                collector.add("skipped_form_status", {
                  line: row.line,
                  subjectKey: row.subjectKey,
                  testCode: row.testCode,
                  message: `form is ${context.status}; reopen it before importing`,
                });
              }
              return;
            }

            const valueRows = await tx.execute<{
              item_group_oid: string;
              item_group_repeat_key: number;
              item_oid: string;
              value: string | null;
            }>(sql`
              SELECT item_group_oid, item_group_repeat_key, item_oid, value
              FROM item_values_current
              WHERE form_instance_id = ${context.formInstanceId}
            `);
            const current = new Map<string, string | null>();
            for (const row of valueRows) {
              if (row.item_group_repeat_key !== 1) continue;
              current.set(`${row.item_group_oid}:${row.item_oid}`, row.value);
            }

            let wrote = false;
            for (const row of group.rows) {
              const { outcome, message, writes } = classifyRow(
                row,
                (t) => current.get(`${t.itemGroupOid}:${t.itemOid}`) ?? undefined,
                () => {},
              );
              for (const target of writes) {
                await writeItemValue(txDb, context, {
                  itemGroupOid: target.itemGroupOid,
                  itemOid: target.itemOid,
                  value: target.value,
                  actorId: run.startedBy,
                  origin: "import",
                });
                current.set(`${target.itemGroupOid}:${target.itemOid}`, target.value);
                if (context.status === "not_started") {
                  // writeItemValue already transitioned the row; keep the
                  // local context in step so later writes in this form do
                  // not emit duplicate form.status_changed audit rows.
                  context = { ...context, status: "in_progress" };
                }
                wrote = true;
              }
              collector.add(outcome, {
                line: row.line,
                subjectKey: row.subjectKey,
                testCode: row.testCode,
                message,
              });
            }

            if (wrote) await evaluateFormChecks(txDb, context, run.startedBy);
          });
        } catch (err) {
          for (const row of group.rows) {
            collector.add("error_write_failed", {
              line: row.line,
              subjectKey: row.subjectKey,
              testCode: row.testCode,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
        processed += group.rows.length;
      }

      await db
        .update(labImportRuns)
        .set({ processedRows: processed, counts: collector.counts, issues: collector.issues })
        .where(eq(labImportRuns.id, runId));
    }

    const clean = Object.entries(collector.counts).every(
      ([outcome, count]) =>
        outcome === "imported" || outcome === "skipped_unchanged" || (count ?? 0) === 0,
    );
    await finish(clean ? "completed" : "completed_with_errors");
  } catch (err) {
    collector.issues.push({
      line: 0,
      subjectKey: "",
      testCode: "",
      outcome: "error_write_failed",
      message: err instanceof Error ? err.message : String(err),
    });
    await finish("failed");
  }
}

/**
 * Boot-time sweep: a run left `running` by an API restart cannot resume (the
 * parsed plan lives in driver memory), but re-importing the same file is safe
 * and idempotent — mark it failed so the UI tells the truth.
 */
export async function sweepInterruptedLabImports(db: Db): Promise<number> {
  const stale = await db
    .update(labImportRuns)
    .set({ status: "failed", finishedAt: new Date() })
    .where(eq(labImportRuns.status, "running"))
    .returning({ id: labImportRuns.id });
  return stale.length;
}

// ── Mappings ───────────────────────────────────────────────────────────────

export function isUniqueViolation(err: unknown): boolean {
  let current = err;
  while (current instanceof Error) {
    if ((current as { code?: string }).code === "23505") return true;
    current = current.cause;
  }
  return false;
}

export async function createLabImportMapping(
  db: Db,
  input: { studyId: string; name: string; config: LabImportConfig; actorId: string },
) {
  try {
    return await db.transaction(async (tx) => {
      const [mapping] = await tx
        .insert(labImportMappings)
        .values({
          studyId: input.studyId,
          name: input.name,
          config: input.config,
          createdBy: input.actorId,
          updatedBy: input.actorId,
        })
        .returning();
      if (!mapping) throw new Error("mapping insert returned no row");
      await tx.insert(auditEvents).values({
        actorId: input.actorId,
        studyId: input.studyId,
        action: "lab_import_mapping.created",
        entityType: "lab_import_mapping",
        entityId: mapping.id,
        newValue: { name: input.name, config: input.config },
      });
      return mapping;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new CaptureError("conflict", `a mapping named "${input.name}" already exists`);
    }
    throw err;
  }
}

export async function updateLabImportMapping(
  db: Db,
  input: {
    studyId: string;
    mappingId: string;
    name?: string;
    config?: LabImportConfig;
    actorId: string;
  },
) {
  try {
    return await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(labImportMappings)
        .where(
          and(
            eq(labImportMappings.id, input.mappingId),
            eq(labImportMappings.studyId, input.studyId),
          ),
        )
        .limit(1);
      if (!existing) throw new CaptureError("not_found", "lab import mapping not found");
      const [updated] = await tx
        .update(labImportMappings)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.config !== undefined ? { config: input.config } : {}),
          updatedBy: input.actorId,
          updatedAt: new Date(),
        })
        .where(eq(labImportMappings.id, input.mappingId))
        .returning();
      if (!updated) throw new Error("mapping update returned no row");
      await tx.insert(auditEvents).values({
        actorId: input.actorId,
        studyId: input.studyId,
        action: "lab_import_mapping.updated",
        entityType: "lab_import_mapping",
        entityId: updated.id,
        oldValue: { name: existing.name, config: existing.config },
        newValue: { name: updated.name, config: updated.config },
      });
      return updated;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new CaptureError("conflict", `a mapping named "${input.name}" already exists`);
    }
    throw err;
  }
}
