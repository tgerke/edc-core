import { healthResponseSchema } from "@edc-core/schemas";
import Fastify, { type FastifyInstance } from "fastify";
import type { AuthConfig } from "./auth/config.js";
import { authPlugin } from "./auth/plugin.js";
import { createDb, type Db } from "./db/client.js";
import { captureRoutes } from "./routes/capture.js";
import { queryRoutes } from "./routes/queries.js";
import { studyRoutes } from "./routes/studies.js";
import { studyBuildRoutes } from "./routes/study-builds.js";

export const API_VERSION = "0.0.1";

export interface BuildServerOptions {
  db?: Db;
  authConfig?: AuthConfig;
}

export async function buildServer(opts: BuildServerOptions = {}): Promise<FastifyInstance> {
  const server = Fastify({ logger: true });

  let db = opts.db;
  if (!db) {
    const created = createDb();
    db = created.db;
    server.addHook("onClose", async () => {
      await created.client.end();
    });
  }

  await server.register(authPlugin, {
    db,
    ...(opts.authConfig ? { config: opts.authConfig } : {}),
  });
  await server.register(studyRoutes);
  await server.register(studyBuildRoutes);
  await server.register(captureRoutes);
  await server.register(queryRoutes);

  server.get("/health", async () => {
    return healthResponseSchema.parse({
      status: "ok",
      service: "edc-core-api",
      version: API_VERSION,
      time: new Date().toISOString(),
    });
  });

  return server;
}
