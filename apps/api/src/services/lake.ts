import { mkdirSync } from "node:fs";
import path from "node:path";
import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { databaseUrl } from "../db/client.js";

/**
 * DuckLake access for the analytics layer (ADR: Postgres doubles as the
 * DuckLake catalog, so the "lake" is Parquet files under LAKE_DATA_PATH plus
 * catalog tables in the `ducklake` schema of the transactional database —
 * no extra server). DuckDB runs embedded in this process.
 */

export function lakeDataPath(): string {
  return path.resolve(process.env.LAKE_DATA_PATH ?? "data/lake");
}

/** Quote a DuckDB identifier. */
export function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Quote a DuckDB string literal. */
export function lit(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Turn an ODM OID into a stable snake_case SQL name (FO.DEMOGRAPHICS → fo_demographics). */
export function sqlName(oid: string): string {
  const base = oid
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (base.length === 0) return "unnamed";
  return /^[0-9]/.test(base) ? `t_${base}` : base;
}

async function connectLake(readOnly: boolean): Promise<{
  instance: DuckDBInstance;
  conn: DuckDBConnection;
}> {
  mkdirSync(lakeDataPath(), { recursive: true });
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  await conn.run("INSTALL ducklake; INSTALL postgres; LOAD ducklake; LOAD postgres;");
  await conn.run(
    `ATTACH ${lit(`ducklake:postgres:${databaseUrl()}`)} AS lake ` +
      `(DATA_PATH ${lit(lakeDataPath())}, METADATA_SCHEMA 'ducklake'${readOnly ? ", READ_ONLY" : ""})`,
  );
  return { instance, conn };
}

// Publishes are serialized so DuckLake snapshot versions stay strictly
// ordered relative to our `snapshots` bookkeeping rows.
let writerQueue: Promise<unknown> = Promise.resolve();

/**
 * Run `fn` with a writable lake plus the transactional Postgres attached
 * read-only as `src` (for publishing FROM system-of-record INTO the lake).
 */
export async function withLakeWriter<T>(fn: (conn: DuckDBConnection) => Promise<T>): Promise<T> {
  const run = writerQueue.then(async () => {
    const { instance, conn } = await connectLake(false);
    try {
      await conn.run(`ATTACH ${lit(databaseUrl())} AS src (TYPE postgres, READ_ONLY)`);
      return await fn(conn);
    } finally {
      conn.closeSync();
      instance.closeSync();
    }
  });
  writerQueue = run.catch(() => {});
  return run;
}

/**
 * Run `fn` with the lake attached read-only — the isolation boundary for
 * analyst-facing reads (workbench, exports): whatever runs here cannot touch
 * the system of record or mutate the lake.
 */
export async function withLakeReader<T>(fn: (conn: DuckDBConnection) => Promise<T>): Promise<T> {
  const { instance, conn } = await connectLake(true);
  try {
    return await fn(conn);
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}
