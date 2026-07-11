import type { MetaDataVersion } from "@edc-core/odm";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  auditEvents,
  codingRuns,
  codings,
  dictionaries,
  dictionaryTerms,
  studyDictionaries,
} from "../db/schema/index.js";
import { CaptureError, latestMetadataVersion, resolveFormContext } from "./capture.js";
import { type DictionaryType, normalizeTerm } from "./dictionaries.js";
import type { StudyBuildDefinition } from "./study-builds.js";

/**
 * Medical coding: verbatim terms captured on eCRF items flagged with
 * edc:CodingDictionary are assigned dictionary terms (MedDRA LLT with its
 * hierarchy path, or a WHODrug drug name with ATC). Codings live beside the
 * clinical record in their own append-only versioned table — deliberately
 * NOT as form item values — so coding proceeds on completed, signed, and
 * locked forms without touching form workflow state or signatures. Every
 * coding stamps the verbatim it coded and the dictionary it used; a later
 * site correction of the verbatim makes the coding "stale" by simple
 * read-time comparison.
 */

const BATCH_SIZE = 50;
const MAX_RECORDED_ISSUES = 200;

// ── Coding targets (edc:CodingDictionary consumers) ────────────────────────

/**
 * itemOid → dictionary type for the build's coding-target items. Blinded
 * items are excluded: coding surfaces show verbatims to any data.code
 * holder, which would bypass ADR-0009. Like blinding's audit masking,
 * targets always come from the latest build — coding is a cross-form
 * data-management activity, not pinned per instance.
 */
export function codingTargets(mdv: MetaDataVersion): Map<string, DictionaryType> {
  const targets = new Map<string, DictionaryType>();
  for (const item of mdv.itemDefs) {
    if (item.codingDictionary && !item.blinded) {
      targets.set(item.oid, item.codingDictionary);
    }
  }
  return targets;
}

async function latestBuildTargets(db: Db, studyId: string) {
  const mdvRow = await latestMetadataVersion(db, studyId);
  if (!mdvRow) throw new CaptureError("invalid", "study has no published build");
  const mdv = (mdvRow.definition as unknown as StudyBuildDefinition).metaDataVersion;
  return { mdv, targets: codingTargets(mdv) };
}

// ── Settings (study → dictionary bindings) ─────────────────────────────────

export async function getCodingSettings(db: Db, studyId: string) {
  const bindings = await db
    .select({
      dictionaryType: studyDictionaries.dictionaryType,
      dictionaryId: studyDictionaries.dictionaryId,
      version: dictionaries.version,
      termsCount: dictionaries.termsCount,
    })
    .from(studyDictionaries)
    .innerJoin(dictionaries, eq(studyDictionaries.dictionaryId, dictionaries.id))
    .where(eq(studyDictionaries.studyId, studyId));
  const availableDictionaries = await db
    .select({
      id: dictionaries.id,
      type: dictionaries.type,
      version: dictionaries.version,
      termsCount: dictionaries.termsCount,
    })
    .from(dictionaries)
    .orderBy(desc(dictionaries.createdAt));
  return { bindings, availableDictionaries };
}

export async function setDictionaryBinding(
  db: Db,
  input: {
    studyId: string;
    dictionaryType: DictionaryType;
    dictionaryId: string | null;
    actorId: string;
  },
) {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: studyDictionaries.id,
        dictionaryId: studyDictionaries.dictionaryId,
        version: dictionaries.version,
      })
      .from(studyDictionaries)
      .innerJoin(dictionaries, eq(studyDictionaries.dictionaryId, dictionaries.id))
      .where(
        and(
          eq(studyDictionaries.studyId, input.studyId),
          eq(studyDictionaries.dictionaryType, input.dictionaryType),
        ),
      )
      .limit(1);

    if (input.dictionaryId === null) {
      if (!existing) return;
      await tx.delete(studyDictionaries).where(eq(studyDictionaries.id, existing.id));
      await tx.insert(auditEvents).values({
        actorId: input.actorId,
        studyId: input.studyId,
        action: "study_dictionary.unbound",
        entityType: "study_dictionary",
        entityId: existing.id,
        oldValue: { dictionaryId: existing.dictionaryId, version: existing.version },
        newValue: null,
      });
      return;
    }

    const [dictionary] = await tx
      .select()
      .from(dictionaries)
      .where(eq(dictionaries.id, input.dictionaryId))
      .limit(1);
    if (!dictionary) throw new CaptureError("not_found", "dictionary not found");
    if (dictionary.type !== input.dictionaryType) {
      throw new CaptureError(
        "invalid",
        `dictionary is ${dictionary.type}, not ${input.dictionaryType}`,
      );
    }

    let entityId: string;
    if (existing) {
      if (existing.dictionaryId === input.dictionaryId) return;
      await tx
        .update(studyDictionaries)
        .set({ dictionaryId: input.dictionaryId, updatedBy: input.actorId, updatedAt: new Date() })
        .where(eq(studyDictionaries.id, existing.id));
      entityId = existing.id;
    } else {
      const [inserted] = await tx
        .insert(studyDictionaries)
        .values({
          studyId: input.studyId,
          dictionaryType: input.dictionaryType,
          dictionaryId: input.dictionaryId,
          updatedBy: input.actorId,
        })
        .returning({ id: studyDictionaries.id });
      if (!inserted) throw new Error("study dictionary insert returned no row");
      entityId = inserted.id;
    }
    await tx.insert(auditEvents).values({
      actorId: input.actorId,
      studyId: input.studyId,
      action: "study_dictionary.bound",
      entityType: "study_dictionary",
      entityId,
      oldValue: existing
        ? { dictionaryId: existing.dictionaryId, version: existing.version }
        : null,
      newValue: { dictionaryId: dictionary.id, version: dictionary.version },
    });
  });
}

async function boundDictionary(db: Db, studyId: string, type: DictionaryType) {
  const [binding] = await db
    .select({
      dictionaryId: studyDictionaries.dictionaryId,
      version: dictionaries.version,
    })
    .from(studyDictionaries)
    .innerJoin(dictionaries, eq(studyDictionaries.dictionaryId, dictionaries.id))
    .where(and(eq(studyDictionaries.studyId, studyId), eq(studyDictionaries.dictionaryType, type)))
    .limit(1);
  return binding ?? null;
}

// ── The coding write path ──────────────────────────────────────────────────

type DictionaryTermRow = typeof dictionaryTerms.$inferSelect;

interface CodingWrite {
  studyId: string;
  formInstanceId: string;
  itemGroupOid: string;
  itemGroupRepeatKey: number;
  itemOid: string;
  verbatim: string;
  /** null appends a "cleared" row. */
  term: (DictionaryTermRow & { dictionaryVersion: string }) | null;
  origin: "auto" | "manual";
  codingRunId?: string;
  actorId: string;
  reason?: string;
}

/**
 * The canonical coding write path, mirroring appendItemValue: appends the
 * next coding version and its audit event in one transaction, serialized
 * per occurrence so a manual coder and the auto-run driver can never
 * collide on version numbers. Corrections append — never update (0013
 * trigger enforces it).
 */
export async function appendCoding(db: Db, write: CodingWrite) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtextextended(
        ${`coding:${write.formInstanceId}:${write.itemGroupOid}:${write.itemGroupRepeatKey}:${write.itemOid}`}, 0))
    `);

    const [latest] = await tx
      .select()
      .from(codings)
      .where(
        and(
          eq(codings.formInstanceId, write.formInstanceId),
          eq(codings.itemGroupOid, write.itemGroupOid),
          eq(codings.itemGroupRepeatKey, write.itemGroupRepeatKey),
          eq(codings.itemOid, write.itemOid),
        ),
      )
      .orderBy(desc(codings.version))
      .limit(1);

    const [inserted] = await tx
      .insert(codings)
      .values({
        studyId: write.studyId,
        formInstanceId: write.formInstanceId,
        itemGroupOid: write.itemGroupOid,
        itemGroupRepeatKey: write.itemGroupRepeatKey,
        itemOid: write.itemOid,
        version: (latest?.version ?? 0) + 1,
        verbatim: write.verbatim,
        dictionaryId: write.term?.dictionaryId ?? null,
        dictionaryVersion: write.term?.dictionaryVersion ?? null,
        code: write.term?.code ?? null,
        term: write.term?.term ?? null,
        ptCode: write.term?.ptCode ?? null,
        ptTerm: write.term?.ptTerm ?? null,
        hltCode: write.term?.hltCode ?? null,
        hltTerm: write.term?.hltTerm ?? null,
        hlgtCode: write.term?.hlgtCode ?? null,
        hlgtTerm: write.term?.hlgtTerm ?? null,
        socCode: write.term?.socCode ?? null,
        socTerm: write.term?.socTerm ?? null,
        atcCode: write.term?.atcCode ?? null,
        atcText: write.term?.atcText ?? null,
        origin: write.origin,
        codingRunId: write.codingRunId ?? null,
        createdBy: write.actorId,
      })
      .returning();
    if (!inserted) throw new Error("coding insert returned no row");

    await tx.insert(auditEvents).values({
      actorId: write.actorId,
      studyId: write.studyId,
      action: write.term ? "coding.assigned" : "coding.cleared",
      entityType: "coding",
      entityId: inserted.id,
      oldValue: latest ? { code: latest.code, term: latest.term, verbatim: latest.verbatim } : null,
      newValue: {
        code: write.term?.code ?? null,
        term: write.term?.term ?? null,
        verbatim: write.verbatim,
        origin: write.origin,
      },
      reason: write.reason ?? null,
    });

    return inserted;
  });
}

// ── Manual assign / clear ──────────────────────────────────────────────────

export interface CodingOccurrence {
  studyId: string;
  formInstanceId: string;
  itemGroupOid: string;
  itemGroupRepeatKey: number;
  itemOid: string;
  actorId: string;
  reason?: string;
}

async function resolveOccurrence(db: Db, input: CodingOccurrence) {
  const context = await resolveFormContext(db, input.formInstanceId);
  if (!context || context.studyId !== input.studyId) {
    throw new CaptureError("not_found", "form instance not found");
  }
  const { targets } = await latestBuildTargets(db, input.studyId);
  const type = targets.get(input.itemOid);
  if (!type) {
    throw new CaptureError("invalid", `item ${input.itemOid} is not a coding target`);
  }
  const [current] = await db.execute<{ value: string | null }>(sql`
    SELECT value FROM item_values_current
    WHERE form_instance_id = ${input.formInstanceId}
      AND item_group_oid = ${input.itemGroupOid}
      AND item_group_repeat_key = ${input.itemGroupRepeatKey}
      AND item_oid = ${input.itemOid}
  `);
  const verbatim = current?.value ?? null;
  if (verbatim === null || verbatim === "") {
    throw new CaptureError("invalid", "the occurrence has no verbatim value to code");
  }
  return { type, verbatim };
}

export async function assignCoding(db: Db, input: CodingOccurrence & { termId: string }) {
  const { type, verbatim } = await resolveOccurrence(db, input);
  const binding = await boundDictionary(db, input.studyId, type);
  if (!binding) {
    throw new CaptureError("invalid", `study has no ${type} dictionary bound`);
  }
  const [term] = await db
    .select()
    .from(dictionaryTerms)
    .where(
      and(
        eq(dictionaryTerms.id, input.termId),
        eq(dictionaryTerms.dictionaryId, binding.dictionaryId),
      ),
    )
    .limit(1);
  if (!term) {
    throw new CaptureError("invalid", "term does not belong to the study's bound dictionary");
  }
  return appendCoding(db, {
    studyId: input.studyId,
    formInstanceId: input.formInstanceId,
    itemGroupOid: input.itemGroupOid,
    itemGroupRepeatKey: input.itemGroupRepeatKey,
    itemOid: input.itemOid,
    verbatim,
    term: { ...term, dictionaryVersion: binding.version },
    origin: "manual",
    actorId: input.actorId,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });
}

export async function clearCoding(db: Db, input: CodingOccurrence) {
  const { verbatim } = await resolveOccurrence(db, input);
  const [latest] = await db
    .select({ code: codings.code })
    .from(codings)
    .where(
      and(
        eq(codings.formInstanceId, input.formInstanceId),
        eq(codings.itemGroupOid, input.itemGroupOid),
        eq(codings.itemGroupRepeatKey, input.itemGroupRepeatKey),
        eq(codings.itemOid, input.itemOid),
      ),
    )
    .orderBy(desc(codings.version))
    .limit(1);
  if (!latest || latest.code === null) {
    throw new CaptureError("invalid", "the occurrence is not coded");
  }
  return appendCoding(db, {
    studyId: input.studyId,
    formInstanceId: input.formInstanceId,
    itemGroupOid: input.itemGroupOid,
    itemGroupRepeatKey: input.itemGroupRepeatKey,
    itemOid: input.itemOid,
    verbatim,
    term: null,
    origin: "manual",
    actorId: input.actorId,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });
}

// ── Work queue ─────────────────────────────────────────────────────────────

export type CodingStatus = "uncoded" | "stale" | "coded_auto" | "coded_manual";

export interface CodingItemRow {
  formInstanceId: string;
  itemGroupOid: string;
  itemGroupRepeatKey: number;
  itemOid: string;
  subjectKey: string;
  eventOid: string;
  formOid: string;
  verbatim: string;
  dictionaryType: DictionaryType;
  status: CodingStatus;
  coding: {
    code: string;
    term: string;
    ptTerm: string | null;
    socTerm: string | null;
    atcCode: string | null;
    atcText: string | null;
    dictionaryVersion: string | null;
    verbatim: string;
    origin: string;
    createdAt: string;
  } | null;
}

type QueueRow = {
  form_instance_id: string;
  item_group_oid: string;
  item_group_repeat_key: number;
  item_oid: string;
  subject_key: string;
  event_oid: string;
  form_oid: string;
  verbatim: string;
  c_code: string | null;
  c_term: string | null;
  c_pt_term: string | null;
  c_soc_term: string | null;
  c_atc_code: string | null;
  c_atc_text: string | null;
  c_dictionary_version: string | null;
  c_verbatim: string | null;
  c_origin: string | null;
  c_created_at: string | null;
};

/**
 * Every non-empty verbatim of a coding-target item, with its latest coding
 * (if any). Status is derived per row: a cleared latest coding reads as
 * uncoded; a coded row whose stamped verbatim no longer matches the current
 * value is stale and needs a human recode.
 */
export async function listCodingItems(
  db: Db,
  input: { studyId: string; status?: CodingStatus; dictionaryType?: DictionaryType },
): Promise<CodingItemRow[]> {
  const { targets } = await latestBuildTargets(db, input.studyId);
  const wanted = [...targets.entries()].filter(
    ([, type]) => !input.dictionaryType || type === input.dictionaryType,
  );
  if (wanted.length === 0) return [];

  const rows = await db.execute<QueueRow>(sql`
    SELECT
      cur.form_instance_id, cur.item_group_oid, cur.item_group_repeat_key, cur.item_oid,
      sub.subject_key, sei.event_oid, fi.form_oid, cur.value AS verbatim,
      c.code AS c_code, c.term AS c_term, c.pt_term AS c_pt_term, c.soc_term AS c_soc_term,
      c.atc_code AS c_atc_code, c.atc_text AS c_atc_text,
      c.dictionary_version AS c_dictionary_version, c.verbatim AS c_verbatim,
      c.origin AS c_origin, c.created_at AS c_created_at
    FROM item_values_current cur
    JOIN form_instances fi ON fi.id = cur.form_instance_id
    JOIN study_event_instances sei ON sei.id = fi.study_event_instance_id
    JOIN subjects sub ON sub.id = sei.subject_id AND sub.study_id = ${input.studyId}
    LEFT JOIN codings_current c
      ON c.form_instance_id = cur.form_instance_id
     AND c.item_group_oid = cur.item_group_oid
     AND c.item_group_repeat_key = cur.item_group_repeat_key
     AND c.item_oid = cur.item_oid
    WHERE cur.item_oid IN (${sql.join(
      wanted.map(([oid]) => sql`${oid}`),
      sql`, `,
    )})
      AND cur.value IS NOT NULL AND cur.value <> ''
    ORDER BY sub.subject_key, sei.event_oid, cur.item_group_repeat_key, cur.item_oid
  `);

  const typeByOid = new Map(wanted);
  const items: CodingItemRow[] = [];
  for (const row of rows) {
    const dictionaryType = typeByOid.get(row.item_oid);
    if (!dictionaryType) continue;
    let status: CodingStatus;
    if (row.c_code === null) {
      status = "uncoded";
    } else if (row.c_verbatim !== row.verbatim) {
      status = "stale";
    } else {
      status = row.c_origin === "auto" ? "coded_auto" : "coded_manual";
    }
    if (input.status && status !== input.status) continue;
    items.push({
      formInstanceId: row.form_instance_id,
      itemGroupOid: row.item_group_oid,
      itemGroupRepeatKey: row.item_group_repeat_key,
      itemOid: row.item_oid,
      subjectKey: row.subject_key,
      eventOid: row.event_oid,
      formOid: row.form_oid,
      verbatim: row.verbatim,
      dictionaryType,
      status,
      coding:
        row.c_code === null
          ? null
          : {
              code: row.c_code,
              term: row.c_term as string,
              ptTerm: row.c_pt_term,
              socTerm: row.c_soc_term,
              atcCode: row.c_atc_code,
              atcText: row.c_atc_text,
              dictionaryVersion: row.c_dictionary_version,
              verbatim: row.c_verbatim as string,
              origin: row.c_origin as string,
              createdAt: row.c_created_at as string,
            },
    });
  }
  return items;
}

// ── Term search ────────────────────────────────────────────────────────────

export async function searchDictionaryTerms(
  db: Db,
  input: { studyId: string; dictionaryType: DictionaryType; query: string },
) {
  const binding = await boundDictionary(db, input.studyId, input.dictionaryType);
  if (!binding) {
    throw new CaptureError("invalid", `study has no ${input.dictionaryType} dictionary bound`);
  }
  const normalized = normalizeTerm(input.query);
  if (normalized === "") return [];
  const rows = await db
    .select({
      id: dictionaryTerms.id,
      code: dictionaryTerms.code,
      term: dictionaryTerms.term,
      ptTerm: dictionaryTerms.ptTerm,
      socTerm: dictionaryTerms.socTerm,
      atcCode: dictionaryTerms.atcCode,
      atcText: dictionaryTerms.atcText,
    })
    .from(dictionaryTerms)
    .where(
      and(
        eq(dictionaryTerms.dictionaryId, binding.dictionaryId),
        sql`${dictionaryTerms.normalizedTerm} LIKE ${`%${normalized}%`}`,
      ),
    )
    .orderBy(sql`(${dictionaryTerms.normalizedTerm} = ${normalized}) DESC`, dictionaryTerms.term)
    .limit(50);
  return rows;
}

// ── Auto-coding run ────────────────────────────────────────────────────────

const RUN_OUTCOMES = [
  "coded_auto",
  "no_match",
  "skipped_ambiguous",
  "skipped_no_dictionary",
  "skipped_changed",
  "error_write_failed",
] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export interface CodingRunIssue {
  subjectKey: string;
  itemOid: string;
  verbatim: string;
  outcome: RunOutcome;
  message: string;
}

export type RunCounts = Partial<Record<RunOutcome, number>>;

class RunCollector {
  counts: RunCounts = {};
  issues: CodingRunIssue[] = [];

  add(outcome: RunOutcome, issue?: Omit<CodingRunIssue, "outcome">) {
    this.counts[outcome] = (this.counts[outcome] ?? 0) + 1;
    if (issue && outcome !== "coded_auto") {
      if (this.issues.length < MAX_RECORDED_ISSUES) this.issues.push({ ...issue, outcome });
    }
  }
}

interface RunCandidate {
  occurrence: Omit<CodingItemRow, "status" | "coding">;
  binding: { dictionaryId: string; version: string } | null;
}

export interface CodingRunPlan {
  totalOccurrences: number;
  candidates: RunCandidate[];
}

/**
 * Candidates are the currently-uncoded occurrences. Coded and stale
 * occurrences are never auto-recoded — a human confirms recodes; the run
 * only clears untouched backlog.
 */
async function analyzeCodingRun(db: Db, studyId: string): Promise<CodingRunPlan> {
  const items = await listCodingItems(db, { studyId, status: "uncoded" });
  const bindings = new Map<DictionaryType, { dictionaryId: string; version: string } | null>();
  for (const type of ["MedDRA", "WHODrug"] as const) {
    bindings.set(type, await boundDictionary(db, studyId, type));
  }
  return {
    totalOccurrences: items.length,
    candidates: items.map(({ status: _s, coding: _c, ...occurrence }) => ({
      occurrence,
      binding: bindings.get(occurrence.dictionaryType) ?? null,
    })),
  };
}

export async function startCodingRun(
  db: Db,
  input: { studyId: string; actorId: string },
): Promise<{ run: typeof codingRuns.$inferSelect; plan: CodingRunPlan }> {
  const plan = await analyzeCodingRun(db, input.studyId);

  const run = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`edc-core:coding-run:${input.studyId}`}, 0))`,
    );
    const [active] = await tx
      .select({ id: codingRuns.id })
      .from(codingRuns)
      .where(and(eq(codingRuns.studyId, input.studyId), eq(codingRuns.status, "running")))
      .limit(1);
    if (active) {
      throw new CaptureError("conflict", "an auto-coding run is already running for this study");
    }
    const [inserted] = await tx
      .insert(codingRuns)
      .values({
        studyId: input.studyId,
        startedBy: input.actorId,
        status: "running",
        totalOccurrences: plan.totalOccurrences,
      })
      .returning();
    if (!inserted) throw new Error("coding run insert returned no row");
    await tx.insert(auditEvents).values({
      actorId: input.actorId,
      studyId: input.studyId,
      action: "coding_run.started",
      entityType: "coding_run",
      entityId: inserted.id,
      newValue: { totalOccurrences: plan.totalOccurrences },
    });
    return inserted;
  });
  return { run, plan };
}

/**
 * The auto-coding driver: exact-match (normalized) lookups against the
 * bound dictionary, one appendCoding per hit, in bounded batches. Inside
 * appendCoding's advisory lock we re-check that the occurrence is still
 * uncoded and its verbatim unchanged — a coder working the queue during a
 * run wins, and the drifted occurrence is reported, not overwritten.
 */
export async function runCodingDriver(db: Db, runId: string, plan: CodingRunPlan): Promise<void> {
  const [run] = await db.select().from(codingRuns).where(eq(codingRuns.id, runId)).limit(1);
  if (!run || run.status !== "running") return;

  const collector = new RunCollector();
  let processed = 0;

  const finish = async (status: "completed" | "completed_with_errors" | "failed") => {
    await db
      .update(codingRuns)
      .set({
        status,
        processedOccurrences: processed,
        counts: collector.counts,
        issues: collector.issues,
        finishedAt: new Date(),
      })
      .where(eq(codingRuns.id, runId));
    try {
      await db.insert(auditEvents).values({
        actorId: run.startedBy,
        studyId: run.studyId,
        action: status === "failed" ? "coding_run.failed" : "coding_run.completed",
        entityType: "coding_run",
        entityId: runId,
        newValue: { status, counts: collector.counts },
      });
    } catch {
      // the run row already tells the truth; the completion audit is best-effort
    }
  };

  try {
    for (let offset = 0; offset < plan.candidates.length; offset += BATCH_SIZE) {
      const batch = plan.candidates.slice(offset, offset + BATCH_SIZE);
      for (const { occurrence, binding } of batch) {
        const issueBase = {
          subjectKey: occurrence.subjectKey,
          itemOid: occurrence.itemOid,
          verbatim: occurrence.verbatim,
        };
        try {
          if (!binding) {
            collector.add("skipped_no_dictionary", {
              ...issueBase,
              message: `study has no ${occurrence.dictionaryType} dictionary bound`,
            });
            continue;
          }
          const matches = await db
            .select()
            .from(dictionaryTerms)
            .where(
              and(
                eq(dictionaryTerms.dictionaryId, binding.dictionaryId),
                eq(dictionaryTerms.normalizedTerm, normalizeTerm(occurrence.verbatim)),
              ),
            )
            .limit(2);
          if (matches.length === 0) {
            collector.add("no_match", {
              ...issueBase,
              message: "no exact dictionary match; code manually",
            });
            continue;
          }
          if (matches.length > 1) {
            collector.add("skipped_ambiguous", {
              ...issueBase,
              message: "more than one dictionary term matches exactly; code manually",
            });
            continue;
          }
          const term = matches[0] as DictionaryTermRow;

          const wrote = await db.transaction(async (tx) => {
            const txDb = tx as unknown as Db;
            // Take the occurrence lock (reentrant for appendCoding below)
            // BEFORE re-deriving state: the queue snapshot is advisory, and
            // a coder working the queue mid-run must win, not be overridden.
            await txDb.execute(sql`
              SELECT pg_advisory_xact_lock(hashtextextended(
                ${`coding:${occurrence.formInstanceId}:${occurrence.itemGroupOid}:${occurrence.itemGroupRepeatKey}:${occurrence.itemOid}`}, 0))
            `);
            const [latest] = await txDb
              .select({ code: codings.code })
              .from(codings)
              .where(
                and(
                  eq(codings.formInstanceId, occurrence.formInstanceId),
                  eq(codings.itemGroupOid, occurrence.itemGroupOid),
                  eq(codings.itemGroupRepeatKey, occurrence.itemGroupRepeatKey),
                  eq(codings.itemOid, occurrence.itemOid),
                ),
              )
              .orderBy(desc(codings.version))
              .limit(1);
            if (latest && latest.code !== null) return false;
            const [current] = await txDb.execute<{ value: string | null }>(sql`
              SELECT value FROM item_values_current
              WHERE form_instance_id = ${occurrence.formInstanceId}
                AND item_group_oid = ${occurrence.itemGroupOid}
                AND item_group_repeat_key = ${occurrence.itemGroupRepeatKey}
                AND item_oid = ${occurrence.itemOid}
            `);
            if ((current?.value ?? null) !== occurrence.verbatim) return false;
            await appendCoding(txDb, {
              studyId: run.studyId,
              formInstanceId: occurrence.formInstanceId,
              itemGroupOid: occurrence.itemGroupOid,
              itemGroupRepeatKey: occurrence.itemGroupRepeatKey,
              itemOid: occurrence.itemOid,
              verbatim: occurrence.verbatim,
              term: { ...term, dictionaryVersion: binding.version },
              origin: "auto",
              codingRunId: runId,
              actorId: run.startedBy,
            });
            return true;
          });
          if (wrote) {
            collector.add("coded_auto");
          } else {
            collector.add("skipped_changed", {
              ...issueBase,
              message: "occurrence was coded or its verbatim changed during the run",
            });
          }
        } catch (err) {
          collector.add("error_write_failed", {
            ...issueBase,
            message: err instanceof Error ? err.message : "write failed",
          });
        } finally {
          processed += 1;
        }
      }
      await db
        .update(codingRuns)
        .set({
          processedOccurrences: processed,
          counts: collector.counts,
          issues: collector.issues,
        })
        .where(eq(codingRuns.id, runId));
    }
    const clean = Object.keys(collector.counts).every(
      (outcome) => outcome === "coded_auto" || outcome === "no_match",
    );
    await finish(clean ? "completed" : "completed_with_errors");
  } catch {
    await finish("failed");
  }
}

/**
 * The run plan travels in memory (nothing to resume from), so runs
 * interrupted by a crash or restart are swept to failed at boot.
 */
export async function sweepInterruptedCodingRuns(db: Db): Promise<number> {
  const stale = await db
    .update(codingRuns)
    .set({ status: "failed", finishedAt: new Date() })
    .where(eq(codingRuns.status, "running"))
    .returning({ id: codingRuns.id });
  return stale.length;
}
