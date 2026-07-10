import {
  type ItemDef,
  listForms,
  type MetaDataVersion,
  type ResolvedGroup,
  type ResolvedItem,
  resolveGroup,
} from "@edc-core/odm";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { auditEvents, snapshots, studies, users } from "../db/schema/index.js";
import { blindedItemOids } from "./blinding.js";
import { latestMetadataVersion } from "./capture.js";
import { ident, lakeRef, lit, sqlName, withLakeWriter } from "./lake.js";

export class SnapshotError extends Error {
  constructor(
    public readonly code: "invalid" | "failed",
    message: string,
  ) {
    super(message);
  }
}

export interface SnapshotColumn {
  column: string;
  itemOid: string;
  dataType: string;
  label?: string;
}

export interface SnapshotTable {
  table: string;
  kind: "core" | "dataset";
  itemGroupOid?: string;
  label?: string;
  rows: number;
  columns?: SnapshotColumn[];
}

export interface SnapshotManifest {
  schema: string;
  metadataVersion: number;
  tables: SnapshotTable[];
  /** Blinded items (edc:Blinded) structurally excluded from every table. */
  excludedBlindedItems?: string[];
}

// ODM dataType → DuckDB column type. Values are stored as text in Postgres;
// the publish pivots and TRY_CASTs them so analysts get typed columns.
const DUCK_TYPE: Record<string, string> = {
  integer: "BIGINT",
  float: "DOUBLE",
  double: "DOUBLE",
  decimal: "DOUBLE",
  boolean: "BOOLEAN",
  date: "DATE",
  datetime: "TIMESTAMP",
  time: "TIME",
};

// Key columns every dataset table starts with; item columns may not shadow them.
const KEY_COLUMNS = [
  "subject_key",
  "site_oid",
  "event_oid",
  "event_repeat_key",
  "form_oid",
  "form_repeat_key",
  "form_status",
  "item_group_repeat_key",
];

interface DatasetSpec {
  table: string;
  itemGroupOid: string;
  label?: string;
  columns: SnapshotColumn[];
}

/**
 * One lake table per ItemGroup that directly holds items — the CDISC dataset
 * grain (item groups ≈ domains), which also matches how item values are keyed
 * in Postgres and how Dataset-JSON exports are shaped. A group referenced by
 * several forms yields a single dataset; form_oid is a key column.
 *
 * Blinded items are excluded here, at the source: their columns never exist
 * in the lake, so the SQL workbench, the R engine, exports, and archives are
 * blinded by construction (ADR-0009).
 */
export function collectDatasets(mdv: MetaDataVersion): DatasetSpec[] {
  const byGroup = new Map<string, ItemDef[]>();
  const labels = new Map<string, string>();
  const walk = (group: ResolvedGroup) => {
    const items = group.children
      .filter((c): c is ResolvedItem => c.kind === "item")
      .map((c) => c.def)
      .filter((def) => !def.blinded);
    if (items.length > 0 && !byGroup.has(group.def.oid)) {
      byGroup.set(group.def.oid, items);
      labels.set(group.def.oid, group.def.name);
    }
    for (const child of group.children) if (child.kind === "group") walk(child);
  };
  for (const form of listForms(mdv)) {
    const tree = resolveGroup(mdv, form.oid);
    if (tree) walk(tree);
  }

  const usedTables = new Set<string>();
  const specs: DatasetSpec[] = [];
  for (const [groupOid, items] of byGroup) {
    let table = sqlName(groupOid);
    for (let n = 2; usedTables.has(table) || table === "subjects" || table === "queries"; n++) {
      table = `${sqlName(groupOid)}_${n}`;
    }
    usedTables.add(table);

    const usedColumns = new Set(KEY_COLUMNS);
    const columns: SnapshotColumn[] = [];
    for (const item of items) {
      let column = sqlName(item.oid);
      for (let n = 2; usedColumns.has(column); n++) column = `${sqlName(item.oid)}_${n}`;
      usedColumns.add(column);
      columns.push({ column, itemOid: item.oid, dataType: item.dataType, label: item.name });
    }
    const label = labels.get(groupOid);
    specs.push({ table, itemGroupOid: groupOid, columns, ...(label ? { label } : {}) });
  }
  return specs;
}

function subjectsSql(studyId: string): string {
  return `CREATE OR REPLACE TABLE lake.subjects AS
    SELECT s.subject_key, st.oid AS site_oid, st.name AS site_name, s.status, s.created_at
    FROM src.public.subjects s
    JOIN src.public.sites st ON st.id = s.site_id
    WHERE s.study_id = ${lit(studyId)}
    ORDER BY s.subject_key`;
}

function queriesSql(studyId: string): string {
  return `CREATE OR REPLACE TABLE lake.queries AS
    SELECT sub.subject_key, sei.event_oid, fi.form_oid, q.item_group_oid, q.item_oid,
           q.origin, q.check_oid, q.status, q.created_at AS opened_at, q.closed_at
    FROM src.public.queries q
    JOIN src.public.form_instances fi ON fi.id = q.form_instance_id
    JOIN src.public.study_event_instances sei ON sei.id = fi.study_event_instance_id
    JOIN src.public.subjects sub ON sub.id = sei.subject_id
    WHERE q.study_id = ${lit(studyId)}
    ORDER BY q.created_at`;
}

function datasetSql(studyId: string, ds: DatasetSpec): string {
  const itemColumns = ds.columns.map((col) => {
    const raw = `MAX(v.value) FILTER (WHERE v.item_oid = ${lit(col.itemOid)})`;
    const duckType = DUCK_TYPE[col.dataType.toLowerCase()];
    const expr = duckType ? `TRY_CAST(${raw} AS ${duckType})` : raw;
    return `${expr} AS ${ident(col.column)}`;
  });
  // Latest version per value cell = the current value (same rule as the
  // item_values_current view, restated here because the postgres scanner
  // reads base tables).
  return `CREATE OR REPLACE TABLE lake.${ident(ds.table)} AS
    SELECT sub.subject_key, st.oid AS site_oid,
           sei.event_oid, sei.repeat_key AS event_repeat_key,
           fi.form_oid, fi.repeat_key AS form_repeat_key, fi.status AS form_status,
           v.item_group_repeat_key,
           ${itemColumns.join(",\n           ")}
    FROM (
      SELECT ivv.*, row_number() OVER (
        PARTITION BY form_instance_id, item_group_oid, item_group_repeat_key, item_oid
        ORDER BY version DESC
      ) AS rn
      FROM src.public.item_value_versions ivv
    ) v
    JOIN src.public.form_instances fi ON fi.id = v.form_instance_id
    JOIN src.public.study_event_instances sei ON sei.id = fi.study_event_instance_id
    JOIN src.public.subjects sub ON sub.id = sei.subject_id
    JOIN src.public.sites st ON st.id = sub.site_id
    WHERE v.rn = 1 AND sub.study_id = ${lit(studyId)} AND v.item_group_oid = ${lit(ds.itemGroupOid)}
    GROUP BY ALL
    ORDER BY sub.subject_key, sei.event_oid, event_repeat_key, fi.form_oid, form_repeat_key,
             v.item_group_repeat_key`;
}

export interface PublishInput {
  studyId: string;
  note?: string;
  actorId: string;
}

/**
 * Publish a point-in-time dataset for one study (E6-07): rewrite the study's
 * lake tables in a single DuckLake transaction and pin the resulting lake
 * snapshot version. Reads against `AT (VERSION => lakeVersion)` are immutable
 * forever; later publishes only add new versions.
 */
export async function publishSnapshot(db: Db, input: PublishInput) {
  const [study] = await db.select().from(studies).where(eq(studies.id, input.studyId));
  if (!study) throw new SnapshotError("invalid", "study not found");
  const mdv = await latestMetadataVersion(db, input.studyId);
  if (!mdv) throw new SnapshotError("invalid", "study has no published build to snapshot");
  const definition = mdv.definition as { metaDataVersion: MetaDataVersion };
  const datasets = collectDatasets(definition.metaDataVersion);
  // Per-study lake: catalog schema + data subdirectory (see lake.ts).
  const schemaName = `ducklake_${sqlName(study.oid)}`;

  const [row] = await db
    .insert(snapshots)
    .values({
      studyId: input.studyId,
      note: input.note ?? null,
      schemaName,
      createdBy: input.actorId,
    })
    .returning();
  if (!row) throw new SnapshotError("failed", "snapshot insert returned no row");

  try {
    const { lakeVersion, manifest } = await withLakeWriter(lakeRef(schemaName), async (conn) => {
      await conn.run("BEGIN");
      await conn.run(subjectsSql(input.studyId));
      await conn.run(queriesSql(input.studyId));
      for (const ds of datasets) await conn.run(datasetSql(input.studyId, ds));
      await conn.run("COMMIT");

      const versionResult = await conn.runAndReadAll(
        "SELECT max(snapshot_id) AS v FROM ducklake_snapshots('lake')",
      );
      const lakeVersion = versionResult.getRowObjects()[0]?.v as bigint;

      const tables: SnapshotTable[] = [];
      const countRows = async (table: string) => {
        const result = await conn.runAndReadAll(`SELECT count(*) AS n FROM lake.${ident(table)}`);
        return Number(result.getRowObjects()[0]?.n ?? 0);
      };
      tables.push({ table: "subjects", kind: "core", rows: await countRows("subjects") });
      tables.push({ table: "queries", kind: "core", rows: await countRows("queries") });
      for (const ds of datasets) {
        tables.push({
          table: ds.table,
          kind: "dataset",
          itemGroupOid: ds.itemGroupOid,
          ...(ds.label ? { label: ds.label } : {}),
          rows: await countRows(ds.table),
          columns: ds.columns,
        });
      }
      const excludedBlindedItems = [...blindedItemOids(definition.metaDataVersion)].sort();
      const manifest: SnapshotManifest = {
        schema: schemaName,
        metadataVersion: mdv.version,
        tables,
        ...(excludedBlindedItems.length > 0 ? { excludedBlindedItems } : {}),
      };
      return { lakeVersion, manifest };
    });

    return await db.transaction(async (tx) => {
      const [published] = await tx
        .update(snapshots)
        .set({ status: "published", lakeVersion, manifest, publishedAt: new Date() })
        .where(eq(snapshots.id, row.id))
        .returning();
      await tx.insert(auditEvents).values({
        actorId: input.actorId,
        studyId: input.studyId,
        action: "snapshot.published",
        entityType: "snapshot",
        entityId: row.id,
        newValue: {
          schema: schemaName,
          lakeVersion: String(lakeVersion),
          metadataVersion: mdv.version,
          tables: manifest.tables.map((t) => `${t.table} (${t.rows})`),
        },
      });
      return published;
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(snapshots)
      .set({ status: "failed", error: message })
      .where(eq(snapshots.id, row.id));
    throw new SnapshotError("failed", message);
  }
}

export async function listSnapshots(db: Db, studyId: string) {
  return db
    .select({
      id: snapshots.id,
      note: snapshots.note,
      status: snapshots.status,
      schemaName: snapshots.schemaName,
      lakeVersion: snapshots.lakeVersion,
      manifest: snapshots.manifest,
      error: snapshots.error,
      createdBy: users.username,
      createdAt: snapshots.createdAt,
      publishedAt: snapshots.publishedAt,
    })
    .from(snapshots)
    .innerJoin(users, eq(snapshots.createdBy, users.id))
    .where(eq(snapshots.studyId, studyId))
    .orderBy(desc(snapshots.createdAt));
}

export async function getSnapshot(db: Db, snapshotId: string) {
  const [row] = await db.select().from(snapshots).where(eq(snapshots.id, snapshotId));
  return row;
}
