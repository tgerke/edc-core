import { runMigrations } from "./db/migrate.js";
import { buildServer } from "./server.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

await runMigrations();
const server = await buildServer();

try {
  await server.listen({ port, host });
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
