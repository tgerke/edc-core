import { desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  ensureRtsmServiceAccount,
  mintApiKey,
  requireRtsmKey,
  revokeApiKey,
} from "../auth/api-keys.js";
import { requirePermission } from "../auth/plugin.js";
import type { AuthenticatedUser } from "../auth/service.js";
import { apiKeys, rtsmConfigs } from "../db/schema/index.js";
import { CaptureError } from "../services/capture.js";
import {
  applyAssignment,
  listRtsmEvents,
  rtsmAssignmentSchema,
  rtsmConfigSchema,
  upsertRtsmConfig,
} from "../services/rtsm.js";
import { requireMembership, sendCaptureError, studyScope } from "./helpers.js";

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

  // Intake wiring is study configuration, like keys. GET returns null until
  // a config exists so the panel can distinguish "not set up" from an error.
  app.get(
    "/studies/:studyId/rtsm/config",
    { preHandler: requirePermission("study.manage", studyScope) },
    async (request) => {
      const { studyId } = request.params as { studyId: string };
      const [config] = await app.db
        .select()
        .from(rtsmConfigs)
        .where(eq(rtsmConfigs.studyId, studyId))
        .limit(1);
      return config ?? null;
    },
  );

  app.put(
    "/studies/:studyId/rtsm/config",
    { preHandler: requirePermission("study.manage", studyScope) },
    async (request, reply) => {
      const parsed = rtsmConfigSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const { studyId } = request.params as { studyId: string };
      const user = request.user as AuthenticatedUser;
      try {
        return await upsertRtsmConfig(app.db, {
          studyId,
          config: parsed.data,
          actorId: user.id,
        });
      } catch (err) {
        if (err instanceof CaptureError) return sendCaptureError(reply, err);
        throw err;
      }
    },
  );

  // The one route an API key can reach. Outcomes map to statuses the RTSM
  // can branch on; the response never echoes the arm.
  app.post(
    "/studies/:studyId/rtsm/assignments",
    { preHandler: requireRtsmKey },
    async (request, reply) => {
      const parsed = rtsmAssignmentSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const { studyId } = request.params as { studyId: string };
      const principal = request.servicePrincipal;
      if (!principal) return reply.code(401).send({ error: "API key required" });
      const result = await applyAssignment(app.db, {
        studyId,
        apiKeyId: principal.apiKeyId,
        serviceUserId: principal.userId,
        assignment: parsed.data,
      });
      const status = { applied: 201, duplicate: 200, conflict: 409, rejected: 422 }[result.outcome];
      return reply
        .code(status)
        .send({ outcome: result.outcome, reason: result.reason, eventId: result.eventId });
    },
  );

  app.get("/studies/:studyId/rtsm/events", async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: "authentication required" });
    if (!(await requireMembership(request))) {
      return reply.code(403).send({ error: "not a member of this study" });
    }
    const { studyId } = request.params as { studyId: string };
    const user = request.user as AuthenticatedUser;
    return listRtsmEvents(app.db, { studyId, viewerId: user.id });
  });
};
