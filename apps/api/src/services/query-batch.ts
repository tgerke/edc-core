import { randomUUID } from "node:crypto";
import type { MetaDataVersion, ResolvedGroup, ResolvedItem } from "@edc-core/odm";
import { resolveGroup } from "@edc-core/odm";
import { and, eq, inArray, sql } from "drizzle-orm";
import { hasPermission } from "../auth/rbac.js";
import type { Db } from "../db/client.js";
import {
  formInstances,
  queries,
  snapshots,
  studyEventInstances,
  studyMetadataVersions,
  subjects,
  workbenchExecutions,
} from "../db/schema/index.js";
import { notifyPermissionHolders } from "./notifications.js";
import { openManualQuery, QueryError, type QueryProvenance } from "./queries.js";
import type { StudyBuildDefinition } from "./study-builds.js";

/**
 * Batch query creation from workbench listing rows (ADR-0015). The sandbox
 * reads snapshots; this bridge runs in the API against live capture, so
 * every target is re-resolved and re-validated before a query is written.
 * Rows that no longer match live data are skipped and reported, never
 * silently queried.
 */
export interface BatchTarget {
  subjectKey: string;
  formOid: string;
  eventOid?: string | undefined;
  eventRepeatKey?: number | undefined;
  formRepeatKey?: number | undefined;
  itemGroupOid?: string | undefined;
  itemGroupRepeatKey?: number | undefined;
  itemOid?: string | undefined;
  /** The listing's value for this data point; mismatch with live capture
   * skips the row (value_changed) unless force is set. */
  snapshotValue?: string | null | undefined;
  message?: string | undefined;
}

export type BatchSkipReason =
  | "subject_not_found"
  | "event_not_found"
  | "form_not_found"
  | "ambiguous_target"
  | "unknown_item"
  | "duplicate_open_query"
  | "value_changed"
  | "site_forbidden"
  | "form_locked";

export interface BatchRowResult {
  index: number;
  outcome: "created" | "would_create" | "skipped";
  queryId?: string;
  formInstanceId?: string;
  reason?: BatchSkipReason;
}

export interface BatchResult {
  batchId: string;
  results: BatchRowResult[];
  created: number;
  skipped: number;
}

interface ResolvedTarget {
  formInstanceId: string;
  status: string;
  metadataVersionId: string;
}

/** Flatten a form's render tree into its group OIDs and (group, item) pairs. */
function collectFormShape(tree: ResolvedGroup): {
  groupOids: Set<string>;
  itemsByGroup: Map<string, Set<string>>;
  allItems: Set<string>;
} {
  const groupOids = new Set<string>();
  const itemsByGroup = new Map<string, Set<string>>();
  const allItems = new Set<string>();
  const walk = (group: ResolvedGroup) => {
    groupOids.add(group.def.oid);
    for (const child of group.children) {
      if (child.kind === "item") {
        const item = child as ResolvedItem;
        allItems.add(item.def.oid);
        const bucket = itemsByGroup.get(group.def.oid) ?? new Set<string>();
        bucket.add(item.def.oid);
        itemsByGroup.set(group.def.oid, bucket);
      } else {
        walk(child as ResolvedGroup);
      }
    }
  };
  walk(tree);
  return { groupOids, itemsByGroup, allItems };
}

export async function createQueryBatch(
  db: Db,
  input: {
    studyId: string;
    actorId: string;
    message: string;
    targets: BatchTarget[];
    dryRun: boolean;
    force?: boolean;
    executionId?: string;
  },
): Promise<BatchResult> {
  const batchId = randomUUID();

  // Provenance: the execution must exist in this study; its script version
  // and snapshot pin travel onto every query the batch opens.
  let provenance: QueryProvenance = { batchId };
  if (input.executionId) {
    const [execution] = await db
      .select()
      .from(workbenchExecutions)
      .where(eq(workbenchExecutions.id, input.executionId))
      .limit(1);
    if (!execution || execution.studyId !== input.studyId) {
      throw new QueryError("not_found", "workbench execution not found in this study");
    }
    const [snapshot] = await db
      .select({ lakeVersion: snapshots.lakeVersion })
      .from(snapshots)
      .where(eq(snapshots.id, execution.snapshotId))
      .limit(1);
    provenance = {
      batchId,
      sourceExecutionId: execution.id,
      snapshotId: execution.snapshotId,
      ...(snapshot?.lakeVersion != null ? { lakeVersion: String(snapshot.lakeVersion) } : {}),
      ...(execution.scriptId ? { scriptId: execution.scriptId } : {}),
      ...(execution.scriptVersion != null ? { scriptVersion: execution.scriptVersion } : {}),
    };
  }

  // Per-request memos: site permission checks and pinned-build shapes.
  const sitePermission = new Map<string, boolean>();
  const canManageSite = async (siteId: string) => {
    let allowed = sitePermission.get(siteId);
    if (allowed === undefined) {
      allowed = await hasPermission(db, input.actorId, "query.manage", {
        studyId: input.studyId,
        siteId,
      });
      sitePermission.set(siteId, allowed);
    }
    return allowed;
  };
  const mdvCache = new Map<string, MetaDataVersion | null>();
  const loadMdv = async (metadataVersionId: string) => {
    if (!mdvCache.has(metadataVersionId)) {
      const [row] = await db
        .select({ definition: studyMetadataVersions.definition })
        .from(studyMetadataVersions)
        .where(eq(studyMetadataVersions.id, metadataVersionId))
        .limit(1);
      mdvCache.set(
        metadataVersionId,
        row ? (row.definition as unknown as StudyBuildDefinition).metaDataVersion : null,
      );
    }
    return mdvCache.get(metadataVersionId) ?? null;
  };

  const results: BatchRowResult[] = [];
  const createdBySite = new Map<string, number>();

  for (const [index, target] of input.targets.entries()) {
    const skip = (reason: BatchSkipReason, extra?: Partial<BatchRowResult>) => {
      results.push({ index, outcome: "skipped", reason, ...extra });
    };

    const [subject] = await db
      .select({ id: subjects.id, siteId: subjects.siteId })
      .from(subjects)
      .where(and(eq(subjects.studyId, input.studyId), eq(subjects.subjectKey, target.subjectKey)))
      .limit(1);
    if (!subject) {
      skip("subject_not_found");
      continue;
    }
    if (!(await canManageSite(subject.siteId))) {
      skip("site_forbidden");
      continue;
    }

    const resolved = await resolveTargetForm(db, subject.id, target);
    if (typeof resolved === "string") {
      skip(resolved);
      continue;
    }
    if (resolved.status === "locked") {
      skip("form_locked", { formInstanceId: resolved.formInstanceId });
      continue;
    }

    // Structural validation against the instance's pinned build.
    if (target.itemGroupOid || target.itemOid) {
      const mdv = await loadMdv(resolved.metadataVersionId);
      const tree = mdv ? resolveGroup(mdv, target.formOid) : null;
      if (!tree) {
        skip("unknown_item", { formInstanceId: resolved.formInstanceId });
        continue;
      }
      const shape = collectFormShape(tree);
      const groupOk = !target.itemGroupOid || shape.groupOids.has(target.itemGroupOid);
      const itemOk =
        !target.itemOid ||
        (target.itemGroupOid
          ? (shape.itemsByGroup.get(target.itemGroupOid)?.has(target.itemOid) ?? false)
          : shape.allItems.has(target.itemOid));
      if (!groupOk || !itemOk) {
        skip("unknown_item", { formInstanceId: resolved.formInstanceId });
        continue;
      }
    }

    // Stale-row detection: the listing came from a snapshot; live capture
    // may have moved on. Values are compared, never echoed (blinding).
    if (target.snapshotValue !== undefined && target.itemOid && !input.force) {
      const stale = await snapshotValueChanged(db, resolved.formInstanceId, target);
      if (stale !== "match") {
        skip(stale, { formInstanceId: resolved.formInstanceId });
        continue;
      }
    }

    // Dedup mirrors checks.ts: open or answered on the same target tuple —
    // any origin — means the problem is already being worked.
    const [existing] = await db
      .select({ id: queries.id })
      .from(queries)
      .where(
        and(
          eq(queries.formInstanceId, resolved.formInstanceId),
          inArray(queries.status, ["open", "answered"]),
          target.itemGroupOid
            ? eq(queries.itemGroupOid, target.itemGroupOid)
            : sql`${queries.itemGroupOid} IS NULL`,
          target.itemGroupRepeatKey
            ? eq(queries.itemGroupRepeatKey, target.itemGroupRepeatKey)
            : sql`${queries.itemGroupRepeatKey} IS NULL`,
          target.itemOid ? eq(queries.itemOid, target.itemOid) : sql`${queries.itemOid} IS NULL`,
        ),
      )
      .limit(1);
    if (existing) {
      skip("duplicate_open_query", {
        queryId: existing.id,
        formInstanceId: resolved.formInstanceId,
      });
      continue;
    }

    if (input.dryRun) {
      results.push({
        index,
        outcome: "would_create",
        formInstanceId: resolved.formInstanceId,
      });
      continue;
    }

    const query = await openManualQuery(db, {
      studyId: input.studyId,
      formInstanceId: resolved.formInstanceId,
      body: target.message ?? input.message,
      actorId: input.actorId,
      provenance,
      ...(target.itemGroupOid ? { itemGroupOid: target.itemGroupOid } : {}),
      ...(target.itemGroupRepeatKey ? { itemGroupRepeatKey: target.itemGroupRepeatKey } : {}),
      ...(target.itemOid ? { itemOid: target.itemOid } : {}),
    });
    results.push({
      index,
      outcome: "created",
      queryId: query.id,
      formInstanceId: resolved.formInstanceId,
    });
    createdBySite.set(subject.siteId, (createdBySite.get(subject.siteId) ?? 0) + 1);
  }

  // One aggregate notification per affected site — a 200-row batch must not
  // fan out 200 bells (openManualQuery skips notify when context is absent).
  for (const [siteId, count] of createdBySite) {
    await notifyPermissionHolders(db, {
      permission: "query.answer",
      scope: { studyId: input.studyId, siteId },
      excludeUserId: input.actorId,
      notification: {
        studyId: input.studyId,
        type: "query.opened",
        title: `${count} new ${count === 1 ? "query" : "queries"} from data review`,
        body: input.message.slice(0, 140),
        payload: { batchId, count },
      },
    });
  }

  const created = results.filter((r) => r.outcome === "created").length;
  return {
    batchId,
    results,
    created,
    skipped: results.filter((r) => r.outcome === "skipped").length,
  };
}

/** Walk subjectKey → event instance → form instance through the unique
 * indexes; an omitted eventOid resolves only when exactly one instance of
 * the form exists for the subject. */
async function resolveTargetForm(
  db: Db,
  subjectId: string,
  target: BatchTarget,
): Promise<ResolvedTarget | BatchSkipReason> {
  if (target.eventOid) {
    const [event] = await db
      .select({ id: studyEventInstances.id })
      .from(studyEventInstances)
      .where(
        and(
          eq(studyEventInstances.subjectId, subjectId),
          eq(studyEventInstances.eventOid, target.eventOid),
          eq(studyEventInstances.repeatKey, target.eventRepeatKey ?? 1),
        ),
      )
      .limit(1);
    if (!event) return "event_not_found";
    const [form] = await db
      .select({
        formInstanceId: formInstances.id,
        status: formInstances.status,
        metadataVersionId: formInstances.metadataVersionId,
      })
      .from(formInstances)
      .where(
        and(
          eq(formInstances.studyEventInstanceId, event.id),
          eq(formInstances.formOid, target.formOid),
          eq(formInstances.repeatKey, target.formRepeatKey ?? 1),
        ),
      )
      .limit(1);
    if (!form) return "form_not_found";
    return form;
  }

  const matches = await db
    .select({
      formInstanceId: formInstances.id,
      status: formInstances.status,
      metadataVersionId: formInstances.metadataVersionId,
    })
    .from(formInstances)
    .innerJoin(studyEventInstances, eq(formInstances.studyEventInstanceId, studyEventInstances.id))
    .where(
      and(
        eq(studyEventInstances.subjectId, subjectId),
        eq(formInstances.formOid, target.formOid),
        ...(target.formRepeatKey ? [eq(formInstances.repeatKey, target.formRepeatKey)] : []),
      ),
    )
    .limit(2);
  if (matches.length === 0) return "form_not_found";
  const [match] = matches;
  if (matches.length > 1 || !match) return "ambiguous_target";
  return match;
}

/** Compare the listing's value with live capture for the target occurrence.
 * "match" lets the row through; anything else is the skip reason. */
async function snapshotValueChanged(
  db: Db,
  formInstanceId: string,
  target: BatchTarget,
): Promise<"match" | "value_changed" | "ambiguous_target"> {
  const conditions = [sql`form_instance_id = ${formInstanceId}`, sql`item_oid = ${target.itemOid}`];
  if (target.itemGroupOid) conditions.push(sql`item_group_oid = ${target.itemGroupOid}`);
  if (target.itemGroupRepeatKey)
    conditions.push(sql`item_group_repeat_key = ${target.itemGroupRepeatKey}`);
  const rows = await db.execute<{ value: string | null }>(
    sql`SELECT value FROM item_values_current WHERE ${sql.join(conditions, sql` AND `)}`,
  );
  if (rows.length > 1) return "ambiguous_target";
  const current = rows.length === 0 ? null : (rows[0]?.value ?? null);
  const expected = target.snapshotValue ?? null;
  return current === expected ? "match" : "value_changed";
}
