import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { hasPermission } from "../auth/rbac.js";
import {
  listSnapshots,
  publishSnapshot,
  SnapshotError,
  type SnapshotManifest,
} from "../services/snapshots.js";

const publishSchema = z.object({ note: z.string().min(1).max(500).optional() });

// bigint lakeVersion → string for JSON.
function serialize<T extends { lakeVersion: bigint | null; manifest: unknown }>(row: T) {
  return {
    ...row,
    lakeVersion: row.lakeVersion === null ? null : String(row.lakeVersion),
    manifest: row.manifest as SnapshotManifest | null,
  };
}

/**
 * Point-in-time dataset publishing (E6-07). Snapshot creation is a
 * data-export capability, so it sits behind the same permission as
 * exports (`export.data`): admin + data_manager by default.
 */
export const snapshotRoutes: FastifyPluginAsync = async (app) => {
  app.post("/studies/:studyId/snapshots", async (request, reply) => {
    const { studyId } = request.params as { studyId: string };
    if (!request.user) return reply.code(401).send({ error: "authentication required" });
    if (!(await hasPermission(app.db, request.user.id, "export.data", { studyId }))) {
      return reply.code(403).send({ error: "missing permission: export.data" });
    }
    const parsed = publishSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const snapshot = await publishSnapshot(app.db, {
        studyId,
        ...(parsed.data.note ? { note: parsed.data.note } : {}),
        actorId: request.user.id,
      });
      if (!snapshot) return reply.code(500).send({ error: "publish returned no row" });
      return reply.code(201).send(serialize(snapshot));
    } catch (err) {
      if (err instanceof SnapshotError) {
        const status = err.code === "invalid" ? 409 : 500;
        return reply.code(status).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get("/studies/:studyId/snapshots", async (request, reply) => {
    const { studyId } = request.params as { studyId: string };
    if (!request.user) return reply.code(401).send({ error: "authentication required" });
    if (!(await hasPermission(app.db, request.user.id, "export.data", { studyId }))) {
      return reply.code(403).send({ error: "missing permission: export.data" });
    }
    const rows = await listSnapshots(app.db, studyId);
    return { snapshots: rows.map(serialize) };
  });
};
