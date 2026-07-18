import { type CompileIssue, parseUsdm, type UsdmWrapper } from "@edc-core/usdm";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { requirePermission } from "../auth/plugin.js";
import type { AuthenticatedUser } from "../auth/service.js";
import {
  protocolCompilations,
  protocolTraceability,
  protocolVersions,
  studyMetadataVersions,
} from "../db/schema/index.js";
import {
  importProtocolVersion,
  protocolSoaSummary,
  publishCompilation,
  resolveDraftItems,
} from "../services/protocols.js";
import type { StudyBuildDefinition } from "../services/study-builds.js";

const importRequestSchema = z.object({
  content: z.string().min(1),
  note: z.string().optional(),
});

const resolveRequestSchema = z.object({
  resolutions: z
    .array(
      z.object({
        itemOid: z.string().min(1),
        name: z.string().optional(),
        question: z.string().optional(),
        dataType: z.string().optional(),
        length: z.number().int().nullable().optional(),
        mandatory: z.boolean().optional(),
        codeListTerms: z
          .array(z.object({ codedValue: z.string().min(1), decode: z.string().optional() }))
          .optional(),
      }),
    )
    .min(1),
});

function studyScope(request: FastifyRequest) {
  return { studyId: (request.params as { studyId: string }).studyId };
}

export const protocolRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/studies/:studyId/protocol-versions",
    { preHandler: requirePermission("study.manage", studyScope) },
    async (request, reply) => {
      const parsed = importRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const { studyId } = request.params as { studyId: string };
      const user = request.user as AuthenticatedUser;

      const result = await importProtocolVersion(app.db, {
        studyId,
        content: parsed.data.content,
        actorId: user.id,
        ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
      });
      if (!result.ok) {
        return reply.code(400).send({ error: "USDM import failed", issues: result.issues });
      }
      return reply.code(201).send({
        id: result.id,
        version: result.version,
        compilationId: result.compilationId,
        unresolvedCount: result.unresolvedCount,
        warnings: result.issues.filter((i) => i.severity === "warning"),
      });
    },
  );

  app.get(
    "/studies/:studyId/protocol-versions",
    { preHandler: requirePermission("study.manage", studyScope) },
    async (request) => {
      const { studyId } = request.params as { studyId: string };
      return app.db
        .select({
          id: protocolVersions.id,
          version: protocolVersions.version,
          usdmVersion: protocolVersions.usdmVersion,
          note: protocolVersions.note,
          createdBy: protocolVersions.createdBy,
          createdAt: protocolVersions.createdAt,
        })
        .from(protocolVersions)
        .where(eq(protocolVersions.studyId, studyId))
        .orderBy(desc(protocolVersions.version));
    },
  );

  app.get(
    "/studies/:studyId/protocol-versions/:version",
    { preHandler: requirePermission("study.manage", studyScope) },
    async (request, reply) => {
      const { studyId, version } = request.params as { studyId: string; version: string };
      const versionNumber = Number.parseInt(version, 10);
      if (!Number.isInteger(versionNumber) || versionNumber < 1) {
        return reply.code(400).send({ error: "version must be a positive integer" });
      }
      const [row] = await app.db
        .select()
        .from(protocolVersions)
        .where(
          and(eq(protocolVersions.studyId, studyId), eq(protocolVersions.version, versionNumber)),
        )
        .limit(1);
      if (!row) return reply.code(404).send({ error: "protocol version not found" });

      const [compilation] = await app.db
        .select()
        .from(protocolCompilations)
        .where(eq(protocolCompilations.protocolVersionId, row.id))
        .limit(1);

      let soa: ReturnType<typeof protocolSoaSummary> = null;
      if (compilation) {
        let wrapper: UsdmWrapper | undefined;
        try {
          wrapper = parseUsdm(row.package);
        } catch {
          wrapper = undefined;
        }
        if (wrapper) {
          soa = protocolSoaSummary(
            wrapper,
            compilation.candidate as unknown as StudyBuildDefinition,
            compilation.warnings as unknown as CompileIssue[],
          );
        }
      }

      return {
        id: row.id,
        version: row.version,
        usdmVersion: row.usdmVersion,
        note: row.note,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
        package: row.package,
        compilation: compilation
          ? {
              id: compilation.id,
              status: compilation.status,
              unresolvedCount: compilation.unresolvedCount,
              publishedMetadataVersionId: compilation.publishedMetadataVersionId,
              candidate: compilation.candidate,
              warnings: compilation.warnings,
            }
          : null,
        soa,
      };
    },
  );

  app.patch(
    "/studies/:studyId/protocol-versions/:version/compilation",
    { preHandler: requirePermission("study.manage", studyScope) },
    async (request, reply) => {
      const parsed = resolveRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const { studyId, version } = request.params as { studyId: string; version: string };
      const versionNumber = Number.parseInt(version, 10);
      const user = request.user as AuthenticatedUser;

      const [row] = await app.db
        .select({ id: protocolVersions.id })
        .from(protocolVersions)
        .where(
          and(eq(protocolVersions.studyId, studyId), eq(protocolVersions.version, versionNumber)),
        )
        .limit(1);
      if (!row) return reply.code(404).send({ error: "protocol version not found" });

      const result = await resolveDraftItems(app.db, {
        studyId,
        protocolVersionId: row.id,
        resolutions: parsed.data.resolutions,
        actorId: user.id,
      });
      if (!result.ok) return reply.code(409).send({ error: result.error });
      return { unresolvedCount: result.unresolvedCount };
    },
  );

  app.post(
    "/studies/:studyId/protocol-versions/:version/compilation/publish",
    { preHandler: requirePermission("study.manage", studyScope) },
    async (request, reply) => {
      const { studyId, version } = request.params as { studyId: string; version: string };
      const versionNumber = Number.parseInt(version, 10);
      const user = request.user as AuthenticatedUser;

      const [row] = await app.db
        .select({ id: protocolVersions.id })
        .from(protocolVersions)
        .where(
          and(eq(protocolVersions.studyId, studyId), eq(protocolVersions.version, versionNumber)),
        )
        .limit(1);
      if (!row) return reply.code(404).send({ error: "protocol version not found" });

      const result = await publishCompilation(app.db, {
        studyId,
        protocolVersionId: row.id,
        actorId: user.id,
      });
      if (!result.ok) {
        return reply.code(409).send({ error: result.error, issues: result.issues ?? [] });
      }
      return reply
        .code(201)
        .send({ metadataVersionId: result.metadataVersionId, buildVersion: result.buildVersion });
    },
  );

  app.get(
    "/studies/:studyId/metadata-versions/:version/traceability",
    { preHandler: requirePermission("study.manage", studyScope) },
    async (request, reply) => {
      const { studyId, version } = request.params as { studyId: string; version: string };
      const versionNumber = Number.parseInt(version, 10);
      if (!Number.isInteger(versionNumber) || versionNumber < 1) {
        return reply.code(400).send({ error: "version must be a positive integer" });
      }
      const [mdv] = await app.db
        .select({ id: studyMetadataVersions.id })
        .from(studyMetadataVersions)
        .where(
          and(
            eq(studyMetadataVersions.studyId, studyId),
            eq(studyMetadataVersions.version, versionNumber),
          ),
        )
        .limit(1);
      if (!mdv) return reply.code(404).send({ error: "build version not found" });
      return app.db
        .select({
          odmOid: protocolTraceability.odmOid,
          odmType: protocolTraceability.odmType,
          usdmId: protocolTraceability.usdmId,
          usdmInstanceType: protocolTraceability.usdmInstanceType,
          relation: protocolTraceability.relation,
          protocolVersionId: protocolTraceability.protocolVersionId,
        })
        .from(protocolTraceability)
        .where(eq(protocolTraceability.metadataVersionId, mdv.id));
    },
  );
};
