import { and, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ensurePmoServiceAccount, mintApiKey, revokeApiKey } from "../auth/api-keys.js";
import { requirePermission } from "../auth/plugin.js";
import type { AuthenticatedUser } from "../auth/service.js";
import { apiKeys } from "../db/schema/index.js";
import {
  IntegrationError,
  listStudyFormInstances,
  listStudyVisits,
} from "../services/integration.js";
import { requireMemberOrPmoKey, studyScope } from "./helpers.js";

const keyCreateSchema = z.object({
  label: z.string().min(1).max(200),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
});

// The PMO read surface (ADR-0017): key management mirrors the RTSM panel
// (study configuration → study.manage), and the two listings the sibling
// PMO consumer needs beyond the ones members already have. A value that
// cannot honestly cross the surface (a non-ISO visit date, designated items
// that disagree) is a 422 naming the datum, never a guess.
export const integrationRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/studies/:studyId/pmo/keys",
    { preHandler: requirePermission("study.manage", studyScope) },
    async (request, reply) => {
      const parsed = keyCreateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const { studyId } = request.params as { studyId: string };
      const user = request.user as AuthenticatedUser;
      const account = await ensurePmoServiceAccount(app.db, { studyId, actorId: user.id });
      const minted = await mintApiKey(app.db, {
        studyId,
        userId: account.userId,
        label: parsed.data.label,
        createdBy: user.id,
        scope: "pmo_read",
        ...(parsed.data.expiresAt !== undefined
          ? { expiresAt: new Date(parsed.data.expiresAt) }
          : {}),
      });
      // The only response that ever carries the raw token.
      return reply.code(201).send(minted);
    },
  );

  app.get(
    "/studies/:studyId/pmo/keys",
    { preHandler: requirePermission("study.manage", studyScope) },
    async (request) => {
      const { studyId } = request.params as { studyId: string };
      return app.db
        .select({
          id: apiKeys.id,
          label: apiKeys.label,
          tokenPrefix: apiKeys.tokenPrefix,
          createdAt: apiKeys.createdAt,
          expiresAt: apiKeys.expiresAt,
          lastUsedAt: apiKeys.lastUsedAt,
          revokedAt: apiKeys.revokedAt,
        })
        .from(apiKeys)
        .where(and(eq(apiKeys.studyId, studyId), eq(apiKeys.scope, "pmo_read")))
        .orderBy(desc(apiKeys.createdAt));
    },
  );

  app.post(
    "/studies/:studyId/pmo/keys/:keyId/revoke",
    { preHandler: requirePermission("study.manage", studyScope) },
    async (request, reply) => {
      const { studyId, keyId } = request.params as { studyId: string; keyId: string };
      const user = request.user as AuthenticatedUser;
      const revoked = await revokeApiKey(app.db, { studyId, keyId, actorId: user.id });
      if (!revoked) return reply.code(404).send({ error: "API key not found or already revoked" });
      return { ok: true };
    },
  );

  app.get("/studies/:studyId/visits", async (request, reply) => {
    if (!(await requireMemberOrPmoKey(request, reply))) return;
    const { studyId } = request.params as { studyId: string };
    try {
      return await listStudyVisits(app.db, studyId);
    } catch (err) {
      if (err instanceof IntegrationError) return reply.code(422).send({ error: err.message });
      throw err;
    }
  });

  app.get("/studies/:studyId/form-instances", async (request, reply) => {
    if (!(await requireMemberOrPmoKey(request, reply))) return;
    const { studyId } = request.params as { studyId: string };
    return listStudyFormInstances(app.db, studyId);
  });
};
