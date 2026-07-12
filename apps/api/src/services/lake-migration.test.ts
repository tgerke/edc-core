import { randomUUID } from "node:crypto";
import { cpSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, databaseUrl } from "../db/client.js";
import { lakeRef, migrateAllLakeCatalogs, withLakeReader } from "./lake.js";

/**
 * The fixture is a pg_dump of a real DuckLake spec-0.3 catalog (plus its one
 * parquet file), written by @duckdb/node-api 1.4.5-r.1 before the 1.5 bump —
 * the old engine is the only thing that can produce one, so it lives as a
 * dump, not as code. It contains two rows in `fixture_items`.
 */
const fixtureDir = path.join(fileURLToPath(import.meta.url), "../__fixtures__");

const { db, client } = createDb();
let dbAvailable = false;
try {
  await client`SELECT 1`;
  dbAvailable = true;
} catch {
  if (process.env.CI) throw new Error(`CI requires a reachable database at ${databaseUrl()}`);
  console.warn(`⚠ Skipping lake migration tests: no database at ${databaseUrl()}.`);
}

// First attach in a fresh environment downloads DuckDB extensions.
const LAKE_TIMEOUT = 120_000;

describe.skipIf(!dbAvailable)("DuckLake catalog migration (integration)", () => {
  const schema = `ducklake_spec03_${randomUUID().slice(0, 8)}`;
  const ref = lakeRef(schema);

  beforeAll(async () => {
    const dump = readFileSync(path.join(fixtureDir, "spec03-catalog.sql"), "utf8")
      .replaceAll("__LAKE_SCHEMA__", schema)
      .replaceAll("__LAKE_DATA_DIR__", ref.dataDir);
    await client.unsafe(dump);
    cpSync(path.join(fixtureDir, "spec03-lake-data"), ref.dataDir, { recursive: true });
  });

  afterAll(async () => {
    await client.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    rmSync(ref.dataDir, { recursive: true, force: true });
    await client.end();
  });

  it(
    "cannot read a spec-0.3 catalog before migration",
    async () => {
      await expect(
        withLakeReader(ref, async (conn) => {
          await conn.runAndReadAll("SELECT count(*) FROM lake.main.fixture_items");
        }),
      ).rejects.toThrow(/version|migrat/i);
    },
    LAKE_TIMEOUT,
  );

  it(
    "boot sweep migrates the catalog in place and data survives",
    async () => {
      const result = await migrateAllLakeCatalogs(db);
      expect(result.migrated).toContain(schema);
      expect(result.failed.map((f) => f.schema)).not.toContain(schema);

      const [meta] = await client.unsafe(
        `SELECT value FROM "${schema}".ducklake_metadata WHERE key = 'version'`,
      );
      expect(meta?.value).not.toBe("0.3");

      const rows = await withLakeReader(ref, async (conn) => {
        const reader = await conn.runAndReadAll(
          "SELECT subject_key, value FROM lake.main.fixture_items ORDER BY subject_key",
        );
        return reader.getRows();
      });
      expect(rows).toEqual([
        ["SUBJ-001", 42],
        ["SUBJ-002", 7],
      ]);
    },
    LAKE_TIMEOUT,
  );

  it(
    "migration is idempotent on a current catalog",
    async () => {
      const again = await migrateAllLakeCatalogs(db);
      expect(again.migrated).toContain(schema);
      expect(again.failed.map((f) => f.schema)).not.toContain(schema);
    },
    LAKE_TIMEOUT,
  );
});
