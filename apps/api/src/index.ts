import { runMigrations } from "./db/migrate.js";
import { buildServer } from "./server.js";
import { sweepInterruptedMigrations } from "./services/amendments.js";
import { sweepInterruptedCodingRuns } from "./services/coding.js";
import { sweepInterruptedLabImports } from "./services/lab-imports.js";

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

try {
  await server.listen({ port, host });
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
