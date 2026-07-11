import { and, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { requirePermission } from "../auth/plugin.js";
import { isStudyMember } from "../auth/rbac.js";
import type { AuthenticatedUser } from "../auth/service.js";
import { labImportMappings, labImportRuns } from "../db/schema/index.js";
import { CaptureError } from "../services/capture.js";
import {
  analyzeLabImport,
  createLabImportMapping,
  labImportConfigSchema,
  runLabImportDriver,
  startLabImport,
  updateLabImportMapping,
} from "../services/lab-imports.js";

// CSV files travel as JSON strings, like ODM build imports (the SPA reads
// the file client-side). The global body limit is Fastify's 1 MiB default;
// the two content-accepting routes raise it — a 10 MiB envelope is roughly
// 100k tall lab rows, plenty for a batch transfer.
const CSV_BODY_LIMIT = 10 * 1024 * 1024;

const mappingCreateSchema = z.object({
  name: z.string().min(1).max(200),
  config: labImportConfigSchema,
});

const mappingUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  config: labImportConfigSchema.optional(),
});

const importRequestSchema = z.object({
  mappingId: z.uuid(),
  content: z.string().min(1),
  fileName: z.string().max(300).optional(),
});

function studyScope(request: FastifyRequest) {
  return { studyId: (request.params as { studyId: string }).studyId };
}

async function requireMembership(request: FastifyRequest): Promise<boolean> {
  const user = request.user as AuthenticatedUser;
  const { studyId } = request.params as { studyId: string };
  return user.isSystemAdmin || (await isStudyMember(request.server.db, user.id, studyId));
}

function sendCaptureError(
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  err: CaptureError,
) {
  const status = { conflict: 409, not_found: 404, invalid: 400 }[err.code];
  return reply.code(status).send({ error: err.message });
}

export const labImportRoutes: FastifyPluginAsync = async (app) => {
  app.get("/studies/:studyId/lab-import/mappings", async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: "authentication required" });
    if (!(await requireMembership(request))) {
      return reply.code(403).send({ error: "not a member of this study" });
    }
    const { studyId } = request.params as { studyId: string };
    return app.db
      .select()
      .from(labImportMappings)
      .where(eq(labImportMappings.studyId, studyId))
      .orderBy(labImportMappings.name);
  });

  app.post(
    "/studies/:studyId/lab-import/mappings",
    { preHandler: requirePermission("data.import", studyScope) },
    async (request, reply) => {
      const parsed = mappingCreateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const { studyId } = request.params as { studyId: string };
      const user = request.user as AuthenticatedUser;
      try {
        const mapping = await createLabImportMapping(app.db, {
          studyId,
          name: parsed.data.name,
          config: parsed.data.config,
          actorId: user.id,
        });
        return reply.code(201).send(mapping);
      } catch (err) {
        if (err instanceof CaptureError) return sendCaptureError(reply, err);
        throw err;
      }
    },
  );

  app.put(
    "/studies/:studyId/lab-import/mappings/:mappingId",
    { preHandler: requirePermission("data.import", studyScope) },
    async (request, reply) => {
      const parsed = mappingUpdateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const { studyId, mappingId } = request.params as { studyId: string; mappingId: string };
      const user = request.user as AuthenticatedUser;
      try {
        return await updateLabImportMapping(app.db, {
          studyId,
          mappingId,
          ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
          ...(parsed.data.config !== undefined ? { config: parsed.data.config } : {}),
          actorId: user.id,
        });
      } catch (err) {
        if (err instanceof CaptureError) return sendCaptureError(reply, err);
        throw err;
      }
    },
  );

  app.post(
    "/studies/:studyId/lab-import/validate",
    { preHandler: requirePermission("data.import", studyScope), bodyLimit: CSV_BODY_LIMIT },
    async (request, reply) => {
      const parsed = importRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const { studyId } = request.params as { studyId: string };
      const user = request.user as AuthenticatedUser;
      try {
        const plan = await analyzeLabImport(app.db, {
          studyId,
          mappingId: parsed.data.mappingId,
          content: parsed.data.content,
          actorId: user.id,
        });
        return plan.preview;
      } catch (err) {
        if (err instanceof CaptureError) return sendCaptureError(reply, err);
        throw err;
      }
    },
  );

  app.post(
    "/studies/:studyId/lab-import/runs",
    { preHandler: requirePermission("data.import", studyScope), bodyLimit: CSV_BODY_LIMIT },
    async (request, reply) => {
      const parsed = importRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const { studyId } = request.params as { studyId: string };
      const user = request.user as AuthenticatedUser;
      try {
        const { run, plan } = await startLabImport(app.db, {
          studyId,
          mappingId: parsed.data.mappingId,
          content: parsed.data.content,
          actorId: user.id,
          ...(parsed.data.fileName !== undefined ? { fileName: parsed.data.fileName } : {}),
        });
        // Fire-and-forget: the run row tracks progress; failures are recorded
        // on the row by the driver's own catch.
        void runLabImportDriver(app.db, run.id, plan).catch((err) => {
          request.log.error({ err, runId: run.id }, "lab import driver crashed");
        });
        return reply.code(202).send({ runId: run.id, totalRows: run.totalRows });
      } catch (err) {
        if (err instanceof CaptureError) return sendCaptureError(reply, err);
        throw err;
      }
    },
  );

  app.get("/studies/:studyId/lab-import/runs", async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: "authentication required" });
    if (!(await requireMembership(request))) {
      return reply.code(403).send({ error: "not a member of this study" });
    }
    const { studyId } = request.params as { studyId: string };
    return app.db
      .select()
      .from(labImportRuns)
      .where(eq(labImportRuns.studyId, studyId))
      .orderBy(desc(labImportRuns.createdAt));
  });

  app.get("/studies/:studyId/lab-import/runs/:runId", async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: "authentication required" });
    if (!(await requireMembership(request))) {
      return reply.code(403).send({ error: "not a member of this study" });
    }
    const { studyId, runId } = request.params as { studyId: string; runId: string };
    const [run] = await app.db
      .select()
      .from(labImportRuns)
      .where(and(eq(labImportRuns.id, runId), eq(labImportRuns.studyId, studyId)))
      .limit(1);
    if (!run) return reply.code(404).send({ error: "lab import run not found" });
    return run;
  });
};
