import { and, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requirePermission } from "../auth/plugin.js";
import type { AuthenticatedUser } from "../auth/service.js";
import { codingRuns } from "../db/schema/index.js";
import { CaptureError } from "../services/capture.js";
import {
  assignCoding,
  clearCoding,
  getCodingSettings,
  listCodingItems,
  runCodingDriver,
  searchDictionaryTerms,
  setDictionaryBinding,
  startCodingRun,
} from "../services/coding.js";
import { requireMembership, sendCaptureError, studyScope } from "./helpers.js";

const bindingSchema = z.object({
  dictionaryType: z.enum(["MedDRA", "WHODrug"]),
  dictionaryId: z.uuid().nullable(),
});

const occurrenceSchema = z.object({
  formInstanceId: z.uuid(),
  itemGroupOid: z.string().min(1),
  itemGroupRepeatKey: z.number().int().min(1).default(1),
  itemOid: z.string().min(1),
  reason: z.string().max(1000).optional(),
});

const assignSchema = occurrenceSchema.extend({ termId: z.uuid() });

const listQuerySchema = z.object({
  status: z.enum(["uncoded", "stale", "coded_auto", "coded_manual"]).optional(),
  type: z.enum(["MedDRA", "WHODrug"]).optional(),
});

const searchQuerySchema = z.object({
  type: z.enum(["MedDRA", "WHODrug"]),
  q: z.string().min(1).max(200),
});

export const codingRoutes: FastifyPluginAsync = async (app) => {
  app.get("/studies/:studyId/coding/settings", async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: "authentication required" });
    if (!(await requireMembership(request))) {
      return reply.code(403).send({ error: "not a member of this study" });
    }
    const { studyId } = request.params as { studyId: string };
    return getCodingSettings(app.db, studyId);
  });

  app.put(
    "/studies/:studyId/coding/settings",
    { preHandler: requirePermission("study.manage", studyScope) },
    async (request, reply) => {
      const parsed = bindingSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const { studyId } = request.params as { studyId: string };
      const user = request.user as AuthenticatedUser;
      try {
        await setDictionaryBinding(app.db, {
          studyId,
          dictionaryType: parsed.data.dictionaryType,
          dictionaryId: parsed.data.dictionaryId,
          actorId: user.id,
        });
        return getCodingSettings(app.db, studyId);
      } catch (err) {
        if (err instanceof CaptureError) return sendCaptureError(reply, err);
        throw err;
      }
    },
  );

  // Membership-gated like the queries dashboard: the work queue carries
  // verbatims and codes that members already see on forms; mutations are
  // what data.code gates.
  app.get("/studies/:studyId/coding/items", async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: "authentication required" });
    if (!(await requireMembership(request))) {
      return reply.code(403).send({ error: "not a member of this study" });
    }
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { studyId } = request.params as { studyId: string };
    try {
      return await listCodingItems(app.db, {
        studyId,
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
        ...(parsed.data.type !== undefined ? { dictionaryType: parsed.data.type } : {}),
      });
    } catch (err) {
      if (err instanceof CaptureError) return sendCaptureError(reply, err);
      throw err;
    }
  });

  app.get(
    "/studies/:studyId/coding/search",
    { preHandler: requirePermission("data.code", studyScope) },
    async (request, reply) => {
      const parsed = searchQuerySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const { studyId } = request.params as { studyId: string };
      try {
        return await searchDictionaryTerms(app.db, {
          studyId,
          dictionaryType: parsed.data.type,
          query: parsed.data.q,
        });
      } catch (err) {
        if (err instanceof CaptureError) return sendCaptureError(reply, err);
        throw err;
      }
    },
  );

  app.post(
    "/studies/:studyId/coding/assign",
    { preHandler: requirePermission("data.code", studyScope) },
    async (request, reply) => {
      const parsed = assignSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const { studyId } = request.params as { studyId: string };
      const user = request.user as AuthenticatedUser;
      try {
        return await assignCoding(app.db, {
          studyId,
          formInstanceId: parsed.data.formInstanceId,
          itemGroupOid: parsed.data.itemGroupOid,
          itemGroupRepeatKey: parsed.data.itemGroupRepeatKey,
          itemOid: parsed.data.itemOid,
          termId: parsed.data.termId,
          actorId: user.id,
          ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
        });
      } catch (err) {
        if (err instanceof CaptureError) return sendCaptureError(reply, err);
        throw err;
      }
    },
  );

  app.post(
    "/studies/:studyId/coding/clear",
    { preHandler: requirePermission("data.code", studyScope) },
    async (request, reply) => {
      const parsed = occurrenceSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const { studyId } = request.params as { studyId: string };
      const user = request.user as AuthenticatedUser;
      try {
        return await clearCoding(app.db, {
          studyId,
          formInstanceId: parsed.data.formInstanceId,
          itemGroupOid: parsed.data.itemGroupOid,
          itemGroupRepeatKey: parsed.data.itemGroupRepeatKey,
          itemOid: parsed.data.itemOid,
          actorId: user.id,
          ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
        });
      } catch (err) {
        if (err instanceof CaptureError) return sendCaptureError(reply, err);
        throw err;
      }
    },
  );

  app.post(
    "/studies/:studyId/coding/runs",
    { preHandler: requirePermission("data.code", studyScope) },
    async (request, reply) => {
      const { studyId } = request.params as { studyId: string };
      const user = request.user as AuthenticatedUser;
      try {
        const { run, plan } = await startCodingRun(app.db, { studyId, actorId: user.id });
        // Fire-and-forget: the run row tracks progress; failures are recorded
        // on the row by the driver's own catch.
        void runCodingDriver(app.db, run.id, plan).catch((err) => {
          request.log.error({ err, runId: run.id }, "coding run driver crashed");
        });
        return reply.code(202).send({ runId: run.id, totalOccurrences: run.totalOccurrences });
      } catch (err) {
        if (err instanceof CaptureError) return sendCaptureError(reply, err);
        throw err;
      }
    },
  );

  app.get("/studies/:studyId/coding/runs", async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: "authentication required" });
    if (!(await requireMembership(request))) {
      return reply.code(403).send({ error: "not a member of this study" });
    }
    const { studyId } = request.params as { studyId: string };
    return app.db
      .select()
      .from(codingRuns)
      .where(eq(codingRuns.studyId, studyId))
      .orderBy(desc(codingRuns.createdAt));
  });

  app.get("/studies/:studyId/coding/runs/:runId", async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: "authentication required" });
    if (!(await requireMembership(request))) {
      return reply.code(403).send({ error: "not a member of this study" });
    }
    const { studyId, runId } = request.params as { studyId: string; runId: string };
    const [run] = await app.db
      .select()
      .from(codingRuns)
      .where(and(eq(codingRuns.id, runId), eq(codingRuns.studyId, studyId)))
      .limit(1);
    if (!run) return reply.code(404).send({ error: "coding run not found" });
    return run;
  });
};
