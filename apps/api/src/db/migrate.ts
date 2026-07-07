import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb, databaseUrl } from "./client.js";

export async function runMigrations(url = databaseUrl()): Promise<void> {
  const { db, client } = createDb(url);
  const migrationsFolder = path.join(fileURLToPath(import.meta.url), "../../../drizzle");
  try {
    // Serialize concurrent migrators (e.g. parallel integration-test files on
    // a fresh database): CREATE SCHEMA/TABLE IF NOT EXISTS still races on the
    // catalog's unique indexes. Session-level lock; released with the client.
    await db.execute(sql`SELECT pg_advisory_lock(hashtextextended('edc-core:migrate', 0))`);
    await migrate(db, { migrationsFolder });
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await runMigrations();
  console.log("migrations applied");
}
