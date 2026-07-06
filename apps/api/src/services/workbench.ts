import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { auditEvents, snapshots } from "../db/schema/index.js";
import { ident, lakeRef, lit, withLakeReader } from "./lake.js";
import type { SnapshotManifest } from "./snapshots.js";

export class WorkbenchError extends Error {
  constructor(
    public readonly code: "not_found" | "invalid" | "query" | "timeout",
    message: string,
  ) {
    super(message);
  }
}

export const MAX_RESULT_ROWS = 5_000;
const QUERY_TIMEOUT_MS = 30_000;

export interface WorkbenchResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
  lakeVersion: string;
}

function jsonValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint")
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : String(value);
  if (typeof value === "object") return String(value); // DuckDB date/timestamp/etc. values
  return value;
}

/**
 * Execute analyst SQL against one study's snapshot (the self-service
 * analytics surface). Containment, in layers:
 *
 * 1. only this study's lake is attached, READ_ONLY — other studies are
 *    unreachable and the system of record is never attached at all;
 * 2. every manifest table is exposed as a view pinned to the snapshot's
 *    lake version, so results are reproducible by construction;
 * 3. the DuckDB session is locked down: filesystem access limited to this
 *    study's Parquet directory, external access (ATTACH/COPY TO/extension
 *    install) disabled, configuration frozen, then a row cap and an
 *    interrupt-based timeout.
 *
 * This is an *operational* analytics tool, not a validated statistical
 * compute environment; executions are audited (E6-04) with the SQL text.
 */
export async function executeWorkbenchSql(
  db: Db,
  input: { studyId: string; snapshotId: string; sql: string; actorId: string },
): Promise<WorkbenchResult> {
  const [snapshot] = await db.select().from(snapshots).where(eq(snapshots.id, input.snapshotId));
  if (!snapshot || snapshot.studyId !== input.studyId) {
    throw new WorkbenchError("not_found", "snapshot not found in this study");
  }
  if (snapshot.status !== "published" || snapshot.lakeVersion === null) {
    throw new WorkbenchError("invalid", `snapshot is ${snapshot.status}, not published`);
  }
  const manifest = snapshot.manifest as SnapshotManifest;
  const lakeVersion = String(snapshot.lakeVersion);
  const ref = lakeRef(manifest.schema);

  const started = Date.now();
  const result = await withLakeReader(ref, async (conn) => {
    for (const table of manifest.tables) {
      await conn.run(
        `CREATE VIEW ${ident(table.table)} AS ` +
          `SELECT * FROM lake.main.${ident(table.table)} AT (VERSION => ${lakeVersion})`,
      );
    }
    await conn.run(`SET allowed_directories=[${lit(ref.dataDir)}]`);
    await conn.run("SET enable_external_access=false");
    await conn.run("SET lock_configuration=true");

    const timer = setTimeout(() => conn.interrupt(), QUERY_TIMEOUT_MS);
    try {
      const reader = await conn.runAndReadUntil(input.sql, MAX_RESULT_ROWS + 1);
      const rows = reader.getRows();
      return {
        columns: reader.columnNames(),
        rows: rows.slice(0, MAX_RESULT_ROWS).map((row) => row.map(jsonValue)),
        truncated: rows.length > MAX_RESULT_ROWS,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes("interrupt")) {
        throw new WorkbenchError("timeout", `query cancelled after ${QUERY_TIMEOUT_MS / 1000}s`);
      }
      throw new WorkbenchError("query", message);
    } finally {
      clearTimeout(timer);
    }
  });
  const elapsedMs = Date.now() - started;

  // E6-04: what ran, against which immutable dataset, by whom.
  await db.insert(auditEvents).values({
    actorId: input.actorId,
    studyId: input.studyId,
    action: "workbench.executed",
    entityType: "snapshot",
    entityId: input.snapshotId,
    newValue: {
      language: "sql",
      sql: input.sql.length > 2000 ? `${input.sql.slice(0, 2000)}…` : input.sql,
      lakeVersion,
      rowCount: result.rows.length,
      elapsedMs,
    },
  });

  return {
    columns: result.columns,
    rows: result.rows,
    rowCount: result.rows.length,
    truncated: result.truncated,
    elapsedMs,
    lakeVersion,
  };
}
