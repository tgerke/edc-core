import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb, databaseUrl } from "./client.js";

export async function runMigrations(url = databaseUrl()): Promise<void> {
  const { db, client } = createDb(url);
  const migrationsFolder = path.join(fileURLToPath(import.meta.url), "../../../drizzle");
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await runMigrations();
  console.log("migrations applied");
}
