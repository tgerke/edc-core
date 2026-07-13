import { DEFAULT_DATABASE_URL } from "../db/client.js";

/**
 * Integration tests run against a dedicated database so `pnpm test` never
 * pollutes the shared dev database (per-study DuckLake catalog schemas and
 * test fixtures used to accumulate there). The name is derived from
 * DATABASE_URL by appending `_test`, so CI's service container works
 * unchanged; TEST_DATABASE_URL overrides the derivation entirely.
 */
export function testDatabaseUrl(): string {
  const explicit = process.env.TEST_DATABASE_URL;
  if (explicit) return explicit;
  const url = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}_test`;
  return url.toString();
}

export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

/** Same server, but connected to the `postgres` maintenance database. */
export function maintenanceUrl(url: string): string {
  const admin = new URL(url);
  admin.pathname = "/postgres";
  return admin.toString();
}
