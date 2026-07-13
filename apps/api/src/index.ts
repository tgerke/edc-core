import { runMigrations } from "./db/migrate.js";
import { buildServer } from "./server.js";
import { sweepInterruptedMigrations } from "./services/amendments.js";
import { sweepInterruptedCodingRuns } from "./services/coding.js";
import { sweepInterruptedLabImports } from "./services/lab-imports.js";
import { migrateAllLakeCatalogs } from "./services/lake.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

await runMigrations();
const server = await buildServer();

// Amendment runs are in-process; one left `running` by a restart cannot
// resume. Mark it failed (re-running is safe and idempotent).
const swept = await sweepInterruptedMigrations(server.db);
if (swept > 0) server.log.warn({ swept }, "marked interrupted migration runs as failed");
const sweptImports = await sweepInterruptedLabImports(server.db);
if (sweptImports > 0) {
  server.log.warn({ swept: sweptImports }, "marked interrupted lab import runs as failed");
}
const sweptCoding = await sweepInterruptedCodingRuns(server.db);
if (sweptCoding > 0) {
  server.log.warn({ swept: sweptCoding }, "marked interrupted coding runs as failed");
}

// Catalogs written by an older DuckLake spec are upgraded in place before
// traffic; READ_ONLY attaches (workbench, engine sidecars, exports) cannot migrate
// and would fail on stale catalogs.
const lakes = await migrateAllLakeCatalogs(server.db);
if (lakes.migrated.length > 0) {
  server.log.info({ catalogs: lakes.migrated.length }, "lake catalogs checked/migrated");
}
for (const f of lakes.failed) {
  server.log.error({ schema: f.schema, error: f.error }, "lake catalog migration failed");
}

try {
  await server.listen({ port, host });
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
