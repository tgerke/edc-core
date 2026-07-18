import { seedVariantDefinition, siteFormVariantDefinitionSchema } from "@edc-core/odm";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { requirePermission } from "../auth/plugin.js";
import type { AuthenticatedUser } from "../auth/service.js";
import { siteFormVariants, siteFormVariantVersions, sites } from "../db/schema/index.js";
import { latestMetadataVersion } from "../services/capture.js";
import {
  createVariant,
  effectiveFormsForEvent,
  SiteFormError,
  saveVariantVersion,
  transitionVariantVersion,
  validateVariantAgainstBuild,
} from "../services/site-forms.js";
import type { StudyBuildDefinition } from "../services/study-builds.js";

const createRequestSchema = z.object({
  name: z.string().min(1),
  /** Omit to seed from the standard layout of the given events. */
  definition: z.unknown().optional(),
  seedEventOids: z.array(z.string().min(1)).optional(),
});

const saveRequestSchema = z.object({
  definition: z.unknown(),
});

const decisionRequestSchema = z.object({
  note: z.string().optional(),
});

function studyScope(request: FastifyRequest) {
  return { studyId: (request.params as { studyId: string }).studyId };
}

function siteScope(request: FastifyRequest) {
  const params = request.params as { studyId: string; siteId: string };
  return { studyId: params.studyId, siteId: params.siteId };
}

function siteFormErrorResponse(err: unknown): { code: number; message: string } | null {
  if (err instanceof SiteFormError) {
    const code = err.code === "not_found" ? 404 : err.code === "invalid" ? 400 : 409;
    return { code, message: err.message };
  }
  return null;
}

export const siteFormRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/studies/:studyId/sites/:siteId/form-variants",
    { preHandler: requirePermission("site.forms.manage", siteScope) },
    async (request) => {
      const { studyId, siteId } = request.params as { studyId: string; siteId: string };
      const variants = await app.db
        .select()
        .from(siteFormVariants)
        .where(and(eq(siteFormVariants.studyId, studyId), eq(siteFormVariants.siteId, siteId)));
      if (variants.length === 0) return [];
      const versions = await app.db
        .select()
        .from(siteFormVariantVersions)
        .where(
          inArray(
            siteFormVariantVersions.variantId,
            variants.map((v) => v.id),
          ),
        )
        .orderBy(desc(siteFormVariantVersions.version));
      return variants.map((variant) => ({
        ...variant,
        versions: versions
          .filter((v) => v.variantId === variant.id)
          .map(({ definition: _definition, ...summary }) => summary),
        latest: versions.find((v) => v.variantId === variant.id) ?? null,
      }));
    },
  );

  app.post(
    "/studies/:studyId/sites/:siteId/form-variants",
    { preHandler: requirePermission("site.forms.manage", siteScope) },
    async (request, reply) => {
      const parsed = createRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const { studyId, siteId } = request.params as { studyId: string; siteId: string };
      const user = request.user as AuthenticatedUser;

      const [site] = await app.db
        .select({ id: sites.id })
        .from(sites)
        .where(and(eq(sites.id, siteId), eq(sites.studyId, studyId)))
        .limit(1);
      if (!site) return reply.code(404).send({ error: "site not found in study" });

      const mdv = await latestMetadataVersion(app.db, studyId);
      if (!mdv) return reply.code(409).send({ error: "study has no published build" });

      let definition = parsed.data.definition;
      if (definition === undefined) {
        const eventOids =
          parsed.data.seedEventOids ??
          (mdv.definition as unknown as StudyBuildDefinition).metaDataVersion.studyEventDefs.map(
            (e) => e.oid,
          );
        definition = seedVariantDefinition(
          (mdv.definition as unknown as StudyBuildDefinition).metaDataVersion,
          eventOids,
        );
      }

      try {
        const result = await createVariant(app.db, {
          studyId,
          siteId,
          name: parsed.data.name,
          metadataVersionId: mdv.id,
          definition,
          actorId: user.id,
        });
        return reply.code(201).send({
          variantId: result.variant.id,
          versionId: result.version.id,
          version: result.version.version,
          definition: result.version.definition,
          issues: result.issues,
        });
      } catch (err) {
        const handled = siteFormErrorResponse(err);
        if (handled) return reply.code(handled.code).send({ error: handled.message });
        throw err;
      }
    },
  );

  app.post(
    "/studies/:studyId/sites/:siteId/form-variants/:variantId/versions",
    { preHandler: requirePermission("site.forms.manage", siteScope) },
    async (request, reply) => {
      const parsed = saveRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const { studyId, variantId } = request.params as { studyId: string; variantId: string };
      const user = request.user as AuthenticatedUser;

      const mdv = await latestMetadataVersion(app.db, studyId);
      if (!mdv) return reply.code(409).send({ error: "study has no published build" });

      try {
        const result = await saveVariantVersion(app.db, {
          studyId,
          variantId,
          metadataVersionId: mdv.id,
          definition: parsed.data.definition,
          actorId: user.id,
        });
        return reply.code(201).send({
          versionId: result.version.id,
          version: result.version.version,
          issues: result.issues,
        });
      } catch (err) {
        const handled = siteFormErrorResponse(err);
        if (handled) return reply.code(handled.code).send({ error: handled.message });
        throw err;
      }
    },
  );

  // Site-side transition.
  app.post(
    "/studies/:studyId/sites/:siteId/form-variants/versions/:versionId/submit",
    { preHandler: requirePermission("site.forms.manage", siteScope) },
    async (request, reply) => {
      const { studyId, versionId } = request.params as { studyId: string; versionId: string };
      const user = request.user as AuthenticatedUser;
      try {
        const updated = await transitionVariantVersion(app.db, {
          studyId,
          versionId,
          action: "submit",
          actorId: user.id,
        });
        return { status: updated.status };
      } catch (err) {
        const handled = siteFormErrorResponse(err);
        if (handled) return reply.code(handled.code).send({ error: handled.message });
        throw err;
      }
    },
  );

  // Sponsor-side queue and decisions.
  app.get(
    "/studies/:studyId/form-variant-approvals",
    { preHandler: requirePermission("study.manage", studyScope) },
    async (request) => {
      const { studyId } = request.params as { studyId: string };
      return app.db
        .select({
          versionId: siteFormVariantVersions.id,
          variantId: siteFormVariants.id,
          name: siteFormVariants.name,
          siteId: siteFormVariants.siteId,
          version: siteFormVariantVersions.version,
          status: siteFormVariantVersions.status,
          submittedAt: siteFormVariantVersions.submittedAt,
          definition: siteFormVariantVersions.definition,
          metadataVersionId: siteFormVariantVersions.metadataVersionId,
        })
        .from(siteFormVariantVersions)
        .innerJoin(siteFormVariants, eq(siteFormVariantVersions.variantId, siteFormVariants.id))
        .where(
          and(
            eq(siteFormVariants.studyId, studyId),
            eq(siteFormVariantVersions.status, "submitted"),
          ),
        )
        .orderBy(desc(siteFormVariantVersions.submittedAt));
    },
  );

  for (const action of ["approve", "request-changes", "retire"] as const) {
    app.post(
      `/studies/:studyId/form-variants/versions/:versionId/${action}`,
      { preHandler: requirePermission("study.manage", studyScope) },
      async (request, reply) => {
        const parsed = decisionRequestSchema.safeParse(request.body ?? {});
        if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
        const { studyId, versionId } = request.params as { studyId: string; versionId: string };
        const user = request.user as AuthenticatedUser;
        try {
          const updated = await transitionVariantVersion(app.db, {
            studyId,
            versionId,
            action: action === "request-changes" ? "request_changes" : action,
            ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
            actorId: user.id,
          });
          return { status: updated.status };
        } catch (err) {
          const handled = siteFormErrorResponse(err);
          if (handled) return reply.code(handled.code).send({ error: handled.message });
          throw err;
        }
      },
    );
  }

  // What capture should render for a site at an event (variant or standard).
  app.get(
    "/studies/:studyId/sites/:siteId/effective-forms",
    { preHandler: requirePermission("data.enter", siteScope) },
    async (request, reply) => {
      const { studyId, siteId } = request.params as { studyId: string; siteId: string };
      const { eventOid } = request.query as { eventOid?: string };
      if (!eventOid) return reply.code(400).send({ error: "eventOid query parameter required" });
      const mdv = await latestMetadataVersion(app.db, studyId);
      if (!mdv) return reply.code(409).send({ error: "study has no published build" });
      return effectiveFormsForEvent(app.db, {
        studyId,
        siteId,
        metadataVersionId: mdv.id,
        eventOid,
      });
    },
  );

  // Dry-run validation for the editor's live coverage panel.
  app.post(
    "/studies/:studyId/sites/:siteId/form-variants/validate",
    { preHandler: requirePermission("site.forms.manage", siteScope) },
    async (request, reply) => {
      const parsed = saveRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const { studyId } = request.params as { studyId: string };
      const mdv = await latestMetadataVersion(app.db, studyId);
      if (!mdv) return reply.code(409).send({ error: "study has no published build" });
      const definition = siteFormVariantDefinitionSchema.safeParse(parsed.data.definition);
      if (!definition.success) return reply.code(400).send({ error: definition.error.message });
      const issues = await validateVariantAgainstBuild(app.db, mdv.id, definition.data);
      return { issues };
    },
  );
};
