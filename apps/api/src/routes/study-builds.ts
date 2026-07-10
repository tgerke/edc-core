import { and, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { requirePermission } from "../auth/plugin.js";
import { isStudyMember } from "../auth/rbac.js";
import type { AuthenticatedUser } from "../auth/service.js";
import { migrationRuns, studyMetadataVersions } from "../db/schema/index.js";
import {
  analyzeMigration,
  diffBuilds,
  runMigrationDriver,
  startMigration,
} from "../services/amendments.js";
import { CaptureError } from "../services/capture.js";
import { exportStudyBuild, importStudyBuild } from "../services/study-builds.js";

const importRequestSchema = z.object({
  content: z.string().min(1),
  note: z.string().optional(),
});

const migrationRequestSchema = z.object({
  targetVersion: z.number().int().positive(),
});

function studyScope(request: FastifyRequest) {
  return { studyId: (request.params as { studyId: string }).studyId };
}

async function requireMembership(request: FastifyRequest): Promise<boolean> {
  const user = request.user as AuthenticatedUser;
  const { studyId } = request.params as { studyId: string };
  return user.isSystemAdmin || (await isStudyMember(request.server.db, user.id, studyId));
}

export const studyBuildRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/studies/:studyId/metadata-versions",
    { preHandler: requirePermission("study.manage", studyScope) },
    async (request, reply) => {
      const parsed = importRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const { studyId } = request.params as { studyId: string };
      const user = request.user as AuthenticatedUser;

      const result = await importStudyBuild(app.db, {
        studyId,
        content: parsed.data.content,
        actorId: user.id,
        ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
      });
      if (!result.ok) {
        return reply.code(400).send({ error: "ODM import failed", issues: result.issues });
      }
      return reply
        .code(201)
        .send({ id: result.id, version: result.version, warnings: result.warnings });
    },
  );

  app.get("/studies/:studyId/metadata-versions", async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: "authentication required" });
    if (!(await requireMembership(request))) {
      return reply.code(403).send({ error: "not a member of this study" });
    }
    const { studyId } = request.params as { studyId: string };
    return app.db
      .select({
        id: studyMetadataVersions.id,
        version: studyMetadataVersions.version,
        note: studyMetadataVersions.note,
        createdBy: studyMetadataVersions.createdBy,
        createdAt: studyMetadataVersions.createdAt,
      })
      .from(studyMetadataVersions)
      .where(eq(studyMetadataVersions.studyId, studyId))
      .orderBy(desc(studyMetadataVersions.version));
  });

  app.get("/studies/:studyId/metadata-versions/:version/odm", async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: "authentication required" });
    if (!(await requireMembership(request))) {
      return reply.code(403).send({ error: "not a member of this study" });
    }
    const { studyId, version } = request.params as { studyId: string; version: string };
    const { serialization = "xml" } = request.query as { serialization?: string };
    if (serialization !== "xml" && serialization !== "json") {
      return reply.code(400).send({ error: "serialization must be xml or json" });
    }
    const versionNumber = Number.parseInt(version, 10);
    if (!Number.isInteger(versionNumber) || versionNumber < 1) {
      return reply.code(400).send({ error: "version must be a positive integer" });
    }

    const content = await exportStudyBuild(app.db, {
      studyId,
      version: versionNumber,
      serialization,
    });
    if (content === null) return reply.code(404).send({ error: "metadata version not found" });

    return reply
      .header(
        "content-type",
        serialization === "xml" ? "application/xml; charset=utf-8" : "application/json",
      )
      .header(
        "content-disposition",
        `attachment; filename="study-v${versionNumber}.${serialization}"`,
      )
      .send(content);
  });

  // ── Amendment migration ────────────────────────────────────────────────
  // Governed by study.manage: whoever publishes builds runs migrations.

  app.get("/studies/:studyId/builds/diff", async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: "authentication required" });
    if (!(await requireMembership(request))) {
      return reply.code(403).send({ error: "not a member of this study" });
    }
    const { studyId } = request.params as { studyId: string };
    const { from, to } = request.query as { from?: string; to?: string };
    const fromVersion = Number.parseInt(from ?? "", 10);
    const toVersion = Number.parseInt(to ?? "", 10);
    if (!Number.isInteger(fromVersion) || !Number.isInteger(toVersion)) {
      return reply.code(400).send({ error: "from and to must be build version numbers" });
    }
    const diff = await diffBuilds(app.db, studyId, fromVersion, toVersion);
    if (!diff) return reply.code(404).send({ error: "build version not found" });
    return { fromVersion, toVersion, diff };
  });

  app.post(
    "/studies/:studyId/migrations/analyze",
    { preHandler: requirePermission("study.manage", studyScope) },
    async (request, reply) => {
      const parsed = migrationRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const { studyId } = request.params as { studyId: string };
      try {
        return await analyzeMigration(app.db, studyId, parsed.data.targetVersion);
      } catch (err) {
        if (err instanceof CaptureError && err.code === "not_found") {
          return reply.code(404).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.post(
    "/studies/:studyId/migrations",
    { preHandler: requirePermission("study.manage", studyScope) },
    async (request, reply) => {
      const parsed = migrationRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const { studyId } = request.params as { studyId: string };
      const user = request.user as AuthenticatedUser;
      try {
        const run = await startMigration(app.db, {
          studyId,
          targetVersion: parsed.data.targetVersion,
          actorId: user.id,
        });
        // Fire-and-forget: the run row tracks progress; failures are recorded
        // on the row by the driver's own catch.
        void runMigrationDriver(app.db, run.id).catch((err) => {
          request.log.error({ err, runId: run.id }, "migration driver crashed");
        });
        return reply.code(202).send({ runId: run.id, totalForms: run.totalForms });
      } catch (err) {
        if (err instanceof CaptureError) {
          const status = { conflict: 409, not_found: 404, invalid: 400 }[err.code];
          return reply.code(status).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.get("/studies/:studyId/migrations", async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: "authentication required" });
    if (!(await requireMembership(request))) {
      return reply.code(403).send({ error: "not a member of this study" });
    }
    const { studyId } = request.params as { studyId: string };
    return app.db
      .select()
      .from(migrationRuns)
      .where(eq(migrationRuns.studyId, studyId))
      .orderBy(desc(migrationRuns.createdAt));
  });

  app.get("/studies/:studyId/migrations/:runId", async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: "authentication required" });
    if (!(await requireMembership(request))) {
      return reply.code(403).send({ error: "not a member of this study" });
    }
    const { studyId, runId } = request.params as { studyId: string; runId: string };
    const [run] = await app.db
      .select()
      .from(migrationRuns)
      .where(and(eq(migrationRuns.id, runId), eq(migrationRuns.studyId, studyId)))
      .limit(1);
    if (!run) return reply.code(404).send({ error: "migration run not found" });
    return run;
  });
};
