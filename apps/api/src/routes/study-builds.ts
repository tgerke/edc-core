import { desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { requirePermission } from "../auth/plugin.js";
import { isStudyMember } from "../auth/rbac.js";
import type { AuthenticatedUser } from "../auth/service.js";
import { studyMetadataVersions } from "../db/schema/index.js";
import { exportStudyBuild, importStudyBuild } from "../services/study-builds.js";

const importRequestSchema = z.object({
  content: z.string().min(1),
  note: z.string().optional(),
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
};
