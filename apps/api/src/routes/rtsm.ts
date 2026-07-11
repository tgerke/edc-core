import { desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ensureRtsmServiceAccount, mintApiKey, revokeApiKey } from "../auth/api-keys.js";
import { requirePermission } from "../auth/plugin.js";
import type { AuthenticatedUser } from "../auth/service.js";
import { apiKeys } from "../db/schema/index.js";
import { studyScope } from "./helpers.js";

const keyCreateSchema = z.object({
  label: z.string().min(1).max(200),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
});

export const rtsmRoutes: FastifyPluginAsync = async (app) => {
  // Key management is study configuration, not a clinical capability —
  // study.manage, like build imports.
  app.post(
    "/studies/:studyId/rtsm/keys",
    { preHandler: requirePermission("study.manage", studyScope) },
    async (request, reply) => {
      const parsed = keyCreateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const { studyId } = request.params as { studyId: string };
      const user = request.user as AuthenticatedUser;
      const account = await ensureRtsmServiceAccount(app.db, { studyId, actorId: user.id });
      const minted = await mintApiKey(app.db, {
        studyId,
        userId: account.userId,
        label: parsed.data.label,
        createdBy: user.id,
        ...(parsed.data.expiresAt !== undefined
          ? { expiresAt: new Date(parsed.data.expiresAt) }
          : {}),
      });
      // The only response that ever carries the raw token.
      return reply.code(201).send(minted);
    },
  );

  app.get(
    "/studies/:studyId/rtsm/keys",
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
        .where(eq(apiKeys.studyId, studyId))
        .orderBy(desc(apiKeys.createdAt));
    },
  );

  app.post(
    "/studies/:studyId/rtsm/keys/:keyId/revoke",
    { preHandler: requirePermission("study.manage", studyScope) },
    async (request, reply) => {
      const { studyId, keyId } = request.params as { studyId: string; keyId: string };
      const user = request.user as AuthenticatedUser;
      const revoked = await revokeApiKey(app.db, { studyId, keyId, actorId: user.id });
      if (!revoked) return reply.code(404).send({ error: "API key not found or already revoked" });
      return { ok: true };
    },
  );
};
