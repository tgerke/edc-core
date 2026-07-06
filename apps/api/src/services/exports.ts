import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { snapshots, studies } from "../db/schema/index.js";
import { API_VERSION } from "../server.js";
import { ident, lit, withLakeReader } from "./lake.js";
import type { SnapshotManifest, SnapshotTable } from "./snapshots.js";

export class ExportError extends Error {
  constructor(
    public readonly code: "not_found" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

export type ExportFormat = "csv" | "parquet" | "dataset-json";

export interface ExportResult {
  filename: string;
  contentType: string;
  body: string | Buffer;
  studyId: string;
  table: string;
  lakeVersion: string;
}

// Key columns shared by every dataset table (see services/snapshots.ts).
const KEY_COLUMN_TYPES: Record<string, string> = {
  subject_key: "string",
  site_oid: "string",
  site_name: "string",
  status: "string",
  created_at: "datetime",
  event_oid: "string",
  event_repeat_key: "integer",
  form_oid: "string",
  form_repeat_key: "integer",
  form_status: "string",
  item_group_oid: "string",
  item_oid: "string",
  origin: "string",
  check_oid: "string",
  opened_at: "datetime",
  closed_at: "datetime",
  item_group_repeat_key: "integer",
};

// ODM dataType → Dataset-JSON v1.1 column dataType.
function datasetJsonType(odmType: string): string {
  const t = odmType.toLowerCase();
  if (t === "text") return "string";
  if (["integer", "float", "double", "decimal", "boolean", "date", "datetime", "time"].includes(t))
    return t;
  return "string";
}

function jsonValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint")
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : String(value);
  if (typeof value === "object") return String(value); // DuckDB date/timestamp values
  return value;
}

async function loadPublishedSnapshot(db: Db, snapshotId: string) {
  const [snapshot] = await db.select().from(snapshots).where(eq(snapshots.id, snapshotId));
  if (!snapshot) throw new ExportError("not_found", "snapshot not found");
  if (snapshot.status !== "published" || snapshot.lakeVersion === null) {
    throw new ExportError("invalid", `snapshot is ${snapshot.status}, not published`);
  }
  return snapshot;
}

/**
 * Export one snapshot table in an open format (P11-06, SC-02). Every export
 * reads `AT (VERSION => lakeVersion)`, so re-running an export months later —
 * after any number of newer snapshots — produces byte-identical data.
 */
export async function exportSnapshotTable(
  db: Db,
  input: { snapshotId: string; table: string; format: ExportFormat },
): Promise<ExportResult> {
  const snapshot = await loadPublishedSnapshot(db, input.snapshotId);
  const manifest = snapshot.manifest as SnapshotManifest;
  const entry = manifest.tables.find((t) => t.table === input.table);
  // Only manifest-listed names ever reach SQL — no caller-controlled identifiers.
  if (!entry) throw new ExportError("not_found", `table ${input.table} is not in this snapshot`);

  const lakeVersion = String(snapshot.lakeVersion);
  const source = `FROM lake.${ident(manifest.schema)}.${ident(entry.table)} AT (VERSION => ${lakeVersion})`;
  const base = `${entry.table}-snapshot-v${lakeVersion}`;

  if (input.format === "dataset-json") {
    if (entry.kind !== "dataset" || !entry.itemGroupOid) {
      throw new ExportError("invalid", "Dataset-JSON export is only defined for dataset tables");
    }
    const [study] = await db.select().from(studies).where(eq(studies.id, snapshot.studyId));
    const rows = await withLakeReader(async (conn) => {
      const result = await conn.runAndReadAll(`SELECT * ${source}`);
      return { columns: result.columnNames(), rows: result.getRows() };
    });
    const itemTypes = new Map((entry.columns ?? []).map((c) => [c.column, c]));
    const columns = [
      {
        itemOID: "ITEMGROUPDATASEQ",
        name: "ITEMGROUPDATASEQ",
        label: "Record Identifier",
        dataType: "integer",
      },
      ...rows.columns.map((name) => {
        const item = itemTypes.get(name);
        return {
          itemOID: item?.itemOid ?? `EDC.${name.toUpperCase()}`,
          name,
          label: item?.label ?? name,
          dataType: item ? datasetJsonType(item.dataType) : (KEY_COLUMN_TYPES[name] ?? "string"),
        };
      }),
    ];
    const body = JSON.stringify(
      {
        datasetJSONCreationDateTime: new Date().toISOString(),
        datasetJSONVersion: "1.1.0",
        fileOID: `${manifest.schema}.${entry.table}.v${lakeVersion}`,
        originator: study?.name ?? "edc-core",
        sourceSystem: { name: "edc-core", version: API_VERSION },
        studyOID: study?.oid ?? snapshot.studyId,
        metaDataVersionOID: `MDV.${manifest.metadataVersion}`,
        itemGroupOID: entry.itemGroupOid,
        records: rows.rows.length,
        name: entry.table,
        label: entry.label ?? entry.table,
        columns,
        rows: rows.rows.map((row, i) => [i + 1, ...row.map(jsonValue)]),
      },
      null,
      2,
    );
    return {
      filename: `${base}.json`,
      contentType: "application/json; charset=utf-8",
      body,
      studyId: snapshot.studyId,
      table: entry.table,
      lakeVersion,
    };
  }

  // CSV and Parquet are written by DuckDB itself via COPY TO.
  const ext = input.format === "csv" ? "csv" : "parquet";
  const tmp = path.join(os.tmpdir(), `edc-export-${randomUUID()}.${ext}`);
  try {
    await withLakeReader(async (conn) => {
      const options = input.format === "csv" ? "(HEADER, DELIMITER ',')" : "(FORMAT PARQUET)";
      await conn.run(`COPY (SELECT * ${source}) TO ${lit(tmp)} ${options}`);
    });
    const body = await readFile(tmp);
    return {
      filename: `${base}.${ext}`,
      contentType:
        input.format === "csv" ? "text/csv; charset=utf-8" : "application/vnd.apache.parquet",
      body: input.format === "csv" ? body.toString("utf8") : body,
      studyId: snapshot.studyId,
      table: entry.table,
      lakeVersion,
    };
  } finally {
    await rm(tmp, { force: true });
  }
}

export function listExportableTables(manifest: SnapshotManifest): SnapshotTable[] {
  return manifest.tables;
}
