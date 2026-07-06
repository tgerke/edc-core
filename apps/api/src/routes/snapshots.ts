import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { hasPermission } from "../auth/rbac.js";
import { auditEvents } from "../db/schema/index.js";
import { ExportError, exportSnapshotTable } from "../services/exports.js";
import {
  getSnapshot,
  listSnapshots,
  publishSnapshot,
  SnapshotError,
  type SnapshotManifest,
} from "../services/snapshots.js";

const publishSchema = z.object({ note: z.string().min(1).max(500).optional() });

const exportSchema = z.object({
  table: z.string().min(1),
  format: z.enum(["csv", "parquet", "dataset-json"]),
});

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

  // Inspection copies in open formats (P11-06, SC-02). Reads are pinned to
  // the snapshot's lake version, so an export re-run later is byte-identical.
  app.get("/snapshots/:snapshotId/export", async (request, reply) => {
    const { snapshotId } = request.params as { snapshotId: string };
    if (!request.user) return reply.code(401).send({ error: "authentication required" });
    const snapshot = await getSnapshot(app.db, snapshotId);
    if (!snapshot) return reply.code(404).send({ error: "snapshot not found" });
    if (
      !(await hasPermission(app.db, request.user.id, "export.data", {
        studyId: snapshot.studyId,
      }))
    ) {
      return reply.code(403).send({ error: "missing permission: export.data" });
    }
    const parsed = exportSchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const result = await exportSnapshotTable(app.db, { snapshotId, ...parsed.data });
      await app.db.insert(auditEvents).values({
        actorId: request.user.id,
        studyId: snapshot.studyId,
        action: "snapshot.exported",
        entityType: "snapshot",
        entityId: snapshotId,
        newValue: {
          table: result.table,
          format: parsed.data.format,
          lakeVersion: result.lakeVersion,
        },
      });
      return reply
        .header("content-type", result.contentType)
        .header("content-disposition", `attachment; filename="${result.filename}"`)
        .send(result.body);
    } catch (err) {
      if (err instanceof ExportError) {
        return reply.code(err.code === "not_found" ? 404 : 409).send({ error: err.message });
      }
      throw err;
    }
  });
};
