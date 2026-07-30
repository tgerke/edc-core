import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export const DEFAULT_DATABASE_URL = "postgres://edc:edc-dev-only@localhost:5432/edc";

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
}

// Migrations run as the role that owns the tables; the runtime role
// (edc_app, migration 0024) cannot alter the append-only triggers. Falls
// back to DATABASE_URL for single-role setups (tests, local scripts).
export function migrateDatabaseUrl(): string {
  return process.env.MIGRATE_DATABASE_URL ?? databaseUrl();
}

export function createDb(url = databaseUrl()) {
  const client = postgres(url, { onnotice: () => {} });
  return { db: drizzle(client, { schema }), client };
}

export type Db = ReturnType<typeof createDb>["db"];
