import { listForms, type MetaDataVersion } from "@edc-core/odm";
import {
  buildSubjectContext,
  evaluateFormState,
  extractFormDependencies,
  extractItemDependencies,
  type ItemValueRow,
  JSONATA_CONTEXT,
  type SubjectContext,
  type SubjectFormInstanceRows,
} from "@edc-core/rules";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  auditEvents,
  formInstances,
  queries,
  studyEventInstances,
  studyMetadataVersions,
} from "../db/schema/index.js";
import type { FormContext } from "./capture.js";
import { resolveFormContext } from "./capture.js";
import type { StudyBuildDefinition } from "./study-builds.js";

export interface CheckFinding {
  checkOid: string;
  message: string;
  /** null = form-level; a number = a specific repeating-group occurrence. */
  repeatKey: number | null;
}

/**
 * Cross-form dependency index for one immutable build (ADR-0015), memoized
 * per metadataVersionId: which forms each check reads, inverted to which
 * checks re-evaluate when a form changes, and which forms can host each
 * check's query (forms containing items its expression references —
 * over-approximate: guarded expressions simply don't fire elsewhere).
 * Builds with no cross-form checks resolve to null and cost nothing.
 */
interface CrossFormIndex {
  /** Union of form OIDs referenced by any check. */
  referencedForms: Set<string>;
  /** Written form OID → checks whose expressions read it. */
  dependentChecks: Map<string, Set<string>>;
  /** checkOid → candidate host forms for re-evaluation. */
  hostForms: Map<string, Set<string>>;
}

const crossFormIndexCache = new Map<string, CrossFormIndex | null>();

function crossFormIndex(metadataVersionId: string, mdv: MetaDataVersion): CrossFormIndex | null {
  const cached = crossFormIndexCache.get(metadataVersionId);
  if (cached !== undefined) return cached;

  const deps = extractFormDependencies(mdv);
  const referencedForms = new Set<string>();
  for (const forms of deps.values()) for (const oid of forms) referencedForms.add(oid);
  if (referencedForms.size === 0) {
    crossFormIndexCache.set(metadataVersionId, null);
    return null;
  }

  const groupsByOid = new Map(mdv.itemGroupDefs.map((g) => [g.oid, g]));
  const itemsReachableFrom = (rootOid: string): Set<string> => {
    const found = new Set<string>();
    const seen = new Set<string>();
    const queue = [rootOid];
    while (queue.length > 0) {
      const current = queue.pop();
      if (current === undefined || seen.has(current)) continue;
      seen.add(current);
      const group = groupsByOid.get(current);
      if (!group) continue;
      for (const ref of group.itemRefs) found.add(ref.itemOid);
      for (const ref of group.itemGroupRefs) queue.push(ref.itemGroupOid);
    }
    return found;
  };
  const itemsByForm = new Map(listForms(mdv).map((f) => [f.oid, itemsReachableFrom(f.oid)]));
  const allItemOids = mdv.itemDefs.map((i) => i.oid);
  const expressions = new Map(
    mdv.conditionDefs.map((c) => [
      c.oid,
      c.formalExpressions.find((e) => e.context === JSONATA_CONTEXT)?.code ?? "",
    ]),
  );

  const dependentChecks = new Map<string, Set<string>>();
  const hostForms = new Map<string, Set<string>>();
  for (const [checkOid, forms] of deps) {
    if (forms.size === 0) continue;
    for (const formOid of forms) {
      let set = dependentChecks.get(formOid);
      if (!set) {
        set = new Set();
        dependentChecks.set(formOid, set);
      }
      set.add(checkOid);
    }
    const referencedItems = new Set(
      extractItemDependencies(expressions.get(checkOid) ?? "", allItemOids),
    );
    const hosts = new Set<string>();
    for (const [formOid, items] of itemsByForm) {
      if ([...referencedItems].some((oid) => items.has(oid))) hosts.add(formOid);
    }
    hostForms.set(checkOid, hosts);
  }

  const index = { referencedForms, dependentChecks, hostForms };
  crossFormIndexCache.set(metadataVersionId, index);
  return index;
}

/** All live values of the subject's instances of the given forms, one query,
 *  shaped for buildSubjectContext. Instances with no values still appear. */
async function loadSubjectRows(
  db: Db,
  subjectId: string,
  formOids: string[],
): Promise<SubjectFormInstanceRows[]> {
  if (formOids.length === 0) return [];
  const rows = await db.execute<{
    form_instance_id: string;
    form_oid: string;
    event_oid: string;
    event_repeat_key: number;
    form_repeat_key: number;
    item_group_oid: string | null;
    item_group_repeat_key: number | null;
    item_oid: string | null;
    value: string | null;
  }>(
    sql`SELECT fi.id AS form_instance_id, fi.form_oid, sei.event_oid,
               sei.repeat_key AS event_repeat_key, fi.repeat_key AS form_repeat_key,
               v.item_group_oid, v.item_group_repeat_key, v.item_oid, v.value
        FROM form_instances fi
        JOIN study_event_instances sei ON fi.study_event_instance_id = sei.id
        LEFT JOIN item_values_current v ON v.form_instance_id = fi.id
        WHERE sei.subject_id = ${subjectId}
          AND fi.form_oid IN (${sql.join(
            formOids.map((oid) => sql`${oid}`),
            sql`, `,
          )})`,
  );
  const byInstance = new Map<string, SubjectFormInstanceRows>();
  for (const row of rows) {
    let instance = byInstance.get(row.form_instance_id);
    if (!instance) {
      instance = {
        formOid: row.form_oid,
        eventOid: row.event_oid,
        eventRepeatKey: row.event_repeat_key,
        formRepeatKey: row.form_repeat_key,
        rows: [],
      };
      byInstance.set(row.form_instance_id, instance);
    }
    if (row.item_oid !== null && row.item_group_oid !== null) {
      instance.rows.push({
        itemGroupOid: row.item_group_oid,
        itemGroupRepeatKey: row.item_group_repeat_key ?? 1,
        itemOid: row.item_oid,
        value: row.value,
      });
    }
  }
  return [...byInstance.values()];
}

/**
 * Evaluates the form's edit checks against its current values and reconciles
 * system queries: one open query per firing check, auto-closed when the data
 * problem is resolved. Runs after every accepted item write (E6-08 groundwork;
 * the manual query lifecycle lands in Phase 4).
 *
 * Skip-aware (ADR-0014): checks run with not-collected fields nulled out,
 * and a stored value persisting in a skipped field raises its own system
 * query under a synthetic SKIP.<condition>.<item> check OID, auto-closed
 * when the site clears the value or the controlling answer changes back.
 */
export async function evaluateFormChecks(
  db: Db,
  context: FormContext,
  actorId: string,
): Promise<CheckFinding[]> {
  const [mdvRow] = await db
    .select({ definition: studyMetadataVersions.definition })
    .from(studyMetadataVersions)
    .where(eq(studyMetadataVersions.id, context.metadataVersionId))
    .limit(1);
  if (!mdvRow) return [];
  const mdv = (mdvRow.definition as unknown as StudyBuildDefinition).metaDataVersion;

  // Latest value per (item, occurrence); the rules engine attributes each
  // finding either to the form or to a repeating-group occurrence.
  const valueRows = await db.execute<{
    item_group_oid: string;
    item_group_repeat_key: number;
    item_oid: string;
    value: string | null;
  }>(
    sql`SELECT item_group_oid, item_group_repeat_key, item_oid, value
        FROM item_values_current
        WHERE form_instance_id = ${context.formInstanceId}`,
  );
  const rows: ItemValueRow[] = valueRows.map((row) => ({
    itemGroupOid: row.item_group_oid,
    itemGroupRepeatKey: row.item_group_repeat_key,
    itemOid: row.item_oid,
    value: row.value,
  }));

  // Cross-form bindings (ADR-0015): only when this build has checks that
  // read other forms — everyone else skips the subject-scope load entirely.
  const index = crossFormIndex(context.metadataVersionId, mdv);
  let subjectContext: SubjectContext | undefined;
  if (index) {
    const instances = await loadSubjectRows(db, context.subjectId, [...index.referencedForms]);
    subjectContext = buildSubjectContext(mdv, instances);
  }

  const state = await evaluateFormState(mdv, rows, subjectContext);
  const occurrenceFindings = [
    ...state.findings,
    ...state.residuals.map((residual) => ({
      checkOid: residual.checkOid,
      message: residual.message,
      repeatKey: residual.repeatKey,
    })),
  ];

  // "Active" includes answered: a site's answer must not let a still-failing
  // check open a duplicate query for the same problem. One query per
  // (check, occurrence); form-level findings carry a null repeat key.
  const activeSystemQueries = await db
    .select()
    .from(queries)
    .where(
      and(
        eq(queries.formInstanceId, context.formInstanceId),
        eq(queries.origin, "system"),
        inArray(queries.status, ["open", "answered"]),
        isNotNull(queries.checkOid),
      ),
    );
  const dedupeKey = (checkOid: string, repeatKey: number | null) =>
    `${checkOid}:${repeatKey ?? ""}`;
  const openByKey = new Map(
    activeSystemQueries.map((q) => [dedupeKey(q.checkOid as string, q.itemGroupRepeatKey), q]),
  );

  const findings: CheckFinding[] = [];
  const firedKeys = new Set<string>();
  for (const finding of occurrenceFindings) {
    findings.push({
      checkOid: finding.checkOid,
      message: finding.message,
      repeatKey: finding.repeatKey,
    });
    const key = dedupeKey(finding.checkOid, finding.repeatKey);
    firedKeys.add(key);
    if (!openByKey.has(key)) {
      await db.transaction(async (tx) => {
        const [query] = await tx
          .insert(queries)
          .values({
            studyId: context.studyId,
            formInstanceId: context.formInstanceId,
            origin: "system",
            checkOid: finding.checkOid,
            itemGroupRepeatKey: finding.repeatKey,
            openedBy: actorId,
          })
          .returning();
        if (!query) throw new Error("query insert returned no row");
        await tx.insert(auditEvents).values({
          actorId,
          studyId: context.studyId,
          action: "query.opened",
          entityType: "query",
          entityId: query.id,
          newValue: {
            origin: "system",
            checkOid: finding.checkOid,
            repeatKey: finding.repeatKey,
            message: finding.message,
          },
        });
      });
    }
  }

  for (const [key, open] of openByKey) {
    if (firedKeys.has(key)) continue;
    await db.transaction(async (tx) => {
      await tx
        .update(queries)
        .set({ status: "closed", closedAt: new Date() })
        .where(eq(queries.id, open.id));
      await tx.insert(auditEvents).values({
        actorId,
        studyId: context.studyId,
        action: "query.closed",
        entityType: "query",
        entityId: open.id,
        newValue: { reason: "auto-resolved by data change", checkOid: open.checkOid },
      });
    });
  }
  return findings;
}

/**
 * A write to one form may fire or resolve checks homed on the subject's
 * OTHER forms (ADR-0015). Re-evaluates the subject's live instances of every
 * form that can host a check reading the written form; the standard
 * reconciliation in evaluateFormChecks then opens and auto-closes across
 * forms with today's mechanics. No-op for builds without cross-form checks.
 *
 * A home-form instance that does not exist yet evaluates nothing — the
 * check first fires on that form's first write, once it has an instance.
 */
export async function evaluateCrossFormChecks(
  db: Db,
  context: FormContext,
  actorId: string,
): Promise<void> {
  const [mdvRow] = await db
    .select({ definition: studyMetadataVersions.definition })
    .from(studyMetadataVersions)
    .where(eq(studyMetadataVersions.id, context.metadataVersionId))
    .limit(1);
  if (!mdvRow) return;
  const mdv = (mdvRow.definition as unknown as StudyBuildDefinition).metaDataVersion;
  const index = crossFormIndex(context.metadataVersionId, mdv);
  const dependents = index?.dependentChecks.get(context.formOid);
  if (!index || !dependents || dependents.size === 0) return;

  const hostFormOids = new Set<string>();
  for (const checkOid of dependents) {
    for (const formOid of index.hostForms.get(checkOid) ?? []) hostFormOids.add(formOid);
  }
  if (hostFormOids.size === 0) return;

  const instances = await db
    .select({ id: formInstances.id })
    .from(formInstances)
    .innerJoin(studyEventInstances, eq(formInstances.studyEventInstanceId, studyEventInstances.id))
    .where(
      and(
        eq(studyEventInstances.subjectId, context.subjectId),
        inArray(formInstances.formOid, [...hostFormOids]),
      ),
    );
  for (const instance of instances) {
    // The written form's own instance was just evaluated by the pipeline.
    if (instance.id === context.formInstanceId) continue;
    const other = await resolveFormContext(db, instance.id);
    if (other) await evaluateFormChecks(db, other, actorId);
  }
}
