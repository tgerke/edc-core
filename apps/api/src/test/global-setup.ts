import { rmSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { runMigrations } from "../db/migrate.js";
import { databaseName, maintenanceUrl, testDatabaseUrl } from "./database.js";

export const TEST_LAKE_DATA_PATH = "data/lake-test";

/**
 * Recreate the test database and lake directory before each vitest run.
 * Individual test files still probe reachability and skip locally when no
 * server is up, so a missing server is only fatal on CI.
 */
export default async function setup(): Promise<void> {
  const url = testDatabaseUrl();
  const name = databaseName(url);
  if (!name.endsWith("_test")) {
    throw new Error(`Refusing to drop "${name}": the test database name must end in "_test".`);
  }

  const admin = postgres(maintenanceUrl(url), { onnotice: () => {}, max: 1 });
  try {
    await admin`SELECT 1`;
  } catch {
    await admin.end();
    if (process.env.CI) throw new Error(`CI requires a reachable database server at ${url}`);
    console.warn(`⚠ No database server at ${url}; integration tests will be skipped.`);
    return;
  }
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  rmSync(path.resolve(TEST_LAKE_DATA_PATH), { recursive: true, force: true });
  await runMigrations(url);
}
