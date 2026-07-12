import { healthResponseSchema } from "@edc-core/schemas";
import Fastify, { type FastifyInstance } from "fastify";
import type { AuthConfig } from "./auth/config.js";
import { authPlugin } from "./auth/plugin.js";
import { createDb, type Db } from "./db/client.js";
import { accessLogRoutes } from "./routes/access-log.js";
import { adminUserRoutes } from "./routes/admin-users.js";
import { auditRoutes } from "./routes/audit.js";
import { captureRoutes } from "./routes/capture.js";
import { codingRoutes } from "./routes/coding.js";
import { dictionaryRoutes } from "./routes/dictionaries.js";
import { labImportRoutes } from "./routes/lab-imports.js";
import { notificationRoutes } from "./routes/notifications.js";
import { queryRoutes } from "./routes/queries.js";
import { rtsmRoutes } from "./routes/rtsm.js";
import { securityAnomalyRoutes } from "./routes/security-anomalies.js";
import { snapshotRoutes } from "./routes/snapshots.js";
import { studyRoutes } from "./routes/studies.js";
import { studyBuildRoutes } from "./routes/study-builds.js";
import { workbenchRoutes } from "./routes/workbench.js";
import { registerScheduler } from "./worker/scheduler.js";

export const API_VERSION = "0.3.0";

/**
 * EDC_TRUST_PROXY: which upstream proxies may assert the client address via
 * X-Forwarded-For. Deliberately opt-in — with no proxy in front, honoring the
 * header would let any client forge the IP that lands in the access log,
 * session records, and auth.session_ip_changed audit events. Unset → trust
 * nothing; "1"/"true" → trust all hops (single proxy you control); an
 * integer → hop count; anything else → Fastify address/CIDR list.
 */
export function parseTrustProxy(raw: string | undefined): boolean | number | string {
  if (!raw) return false;
  if (raw === "1" || raw === "true") return true;
  const hops = Number(raw);
  if (Number.isInteger(hops) && hops > 0) return hops;
  return raw;
}

export interface BuildServerOptions {
  db?: Db;
  authConfig?: AuthConfig;
  trustProxy?: boolean | number | string;
}

export async function buildServer(opts: BuildServerOptions = {}): Promise<FastifyInstance> {
  const server = Fastify({
    logger: true,
    trustProxy: opts.trustProxy ?? parseTrustProxy(process.env.EDC_TRUST_PROXY),
  });

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
  await server.register(adminUserRoutes);
  await server.register(accessLogRoutes);
  await server.register(securityAnomalyRoutes);
  await server.register(studyRoutes);
  await server.register(studyBuildRoutes);
  await server.register(labImportRoutes);
  await server.register(rtsmRoutes);
  await server.register(dictionaryRoutes);
  await server.register(codingRoutes);
  await server.register(captureRoutes);
  await server.register(queryRoutes);
  await server.register(auditRoutes);
  await server.register(snapshotRoutes);
  await server.register(workbenchRoutes);
  await server.register(notificationRoutes);
  registerScheduler(server);

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
