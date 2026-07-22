import { eq } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Permission } from "../auth/permissions.js";
import { effectivePermissions, hasPermission, isStudyMember } from "../auth/rbac.js";
import type { AuthenticatedUser } from "../auth/service.js";
import { queries } from "../db/schema/index.js";
import { type FormContext, resolveFormContext } from "../services/capture.js";
import {
  answerQuery,
  closeQuery,
  listFormQueries,
  listStudyQueries,
  openManualQuery,
  QueryError,
  reopenQuery,
} from "../services/queries.js";
import { createQueryBatch } from "../services/query-batch.js";

const openSchema = z.object({
  itemGroupOid: z.string().min(1).optional(),
  itemGroupRepeatKey: z.number().int().positive().optional(),
  itemOid: z.string().min(1).optional(),
  body: z.string().min(1),
});
const messageSchema = z.object({ body: z.string().min(1) });
const closeSchema = z.object({ body: z.string().min(1).optional() });
const listSchema = z.object({ status: z.enum(["open", "answered", "closed"]).optional() });

const batchTargetSchema = z.object({
  subjectKey: z.string().min(1),
  formOid: z.string().min(1),
  eventOid: z.string().min(1).optional(),
  eventRepeatKey: z.number().int().positive().optional(),
  formRepeatKey: z.number().int().positive().optional(),
  itemGroupOid: z.string().min(1).optional(),
  itemGroupRepeatKey: z.number().int().positive().optional(),
  itemOid: z.string().min(1).optional(),
  snapshotValue: z.string().nullable().optional(),
  message: z.string().min(1).optional(),
});
const batchSchema = z.object({
  dryRun: z.boolean().default(false),
  force: z.boolean().default(false),
  message: z.string().min(1),
  executionId: z.uuid().optional(),
  targets: z.array(batchTargetSchema).min(1).max(500),
});

function sendQueryError(reply: FastifyReply, err: unknown) {
  if (err instanceof QueryError) {
    const status = { not_found: 404, invalid: 409 }[err.code];
    return reply.code(status).send({ error: err.message });
  }
  throw err;
}

export const queryRoutes: FastifyPluginAsync = async (app) => {
  async function guard(
    request: FastifyRequest,
    reply: FastifyReply,
    permission: Permission,
    scope: { studyId: string; siteId?: string },
  ): Promise<AuthenticatedUser | null> {
    if (!request.user) {
      await reply.code(401).send({ error: "authentication required" });
      return null;
    }
    if (!(await hasPermission(app.db, request.user.id, permission, scope))) {
      await reply.code(403).send({ error: `missing permission: ${permission}` });
      return null;
    }
    return request.user;
  }

  async function formContextOr404(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FormContext | null> {
    const { formInstanceId } = request.params as { formInstanceId: string };
    const context = await resolveFormContext(app.db, formInstanceId);
    if (!context) {
      await reply.code(404).send({ error: "form not found" });
      return null;
    }
    return context;
  }

  app.get("/forms/:formInstanceId/queries", async (request, reply) => {
    const context = await formContextOr404(request, reply);
    if (!context) return;
    if (!request.user) return reply.code(401).send({ error: "authentication required" });
    if (
      !request.user.isSystemAdmin &&
      !(await isStudyMember(app.db, request.user.id, context.studyId))
    ) {
      return reply.code(403).send({ error: "not a member of this study" });
    }
    return listFormQueries(app.db, context.formInstanceId);
  });

  app.post("/forms/:formInstanceId/queries", async (request, reply) => {
    const context = await formContextOr404(request, reply);
    if (!context) return;
    const parsed = openSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const user = await guard(request, reply, "query.manage", {
      studyId: context.studyId,
      siteId: context.siteId,
    });
    if (!user) return;
    const query = await openManualQuery(app.db, {
      studyId: context.studyId,
      formInstanceId: context.formInstanceId,
      body: parsed.data.body,
      actorId: user.id,
      context: {
        siteId: context.siteId,
        subjectKey: context.subjectKey,
        formOid: context.formOid,
      },
      ...(parsed.data.itemGroupOid ? { itemGroupOid: parsed.data.itemGroupOid } : {}),
      ...(parsed.data.itemGroupRepeatKey
        ? { itemGroupRepeatKey: parsed.data.itemGroupRepeatKey }
        : {}),
      ...(parsed.data.itemOid ? { itemOid: parsed.data.itemOid } : {}),
    });
    return reply.code(201).send(query);
  });

  // Lifecycle actions share a shape: resolve the query's form for site-scoped
  // permission checks, run the transition, map QueryError to HTTP.
  function lifecycleAction(
    permission: Permission,
    run: (
      queryId: string,
      body: string | undefined,
      actorId: string,
      context: FormContext,
    ) => Promise<unknown>,
    bodySchema: z.ZodType<{ body?: string | undefined }>,
  ) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const { queryId } = request.params as { queryId: string };
      const parsed = bodySchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      try {
        const [row] = await app.db
          .select({ formInstanceId: queries.formInstanceId })
          .from(queries)
          .where(eq(queries.id, queryId))
          .limit(1);
        if (!row) return reply.code(404).send({ error: "query not found" });
        const context = await resolveFormContext(app.db, row.formInstanceId);
        if (!context) return reply.code(404).send({ error: "form not found" });
        const user = await guard(request, reply, permission, {
          studyId: context.studyId,
          siteId: context.siteId,
        });
        if (!user) return;
        const updated = await run(queryId, parsed.data.body, user.id, context);
        return reply.send(updated);
      } catch (err) {
        return sendQueryError(reply, err);
      }
    };
  }

  app.post(
    "/queries/:queryId/answer",
    lifecycleAction(
      "query.answer",
      (queryId, body, actorId, context) =>
        answerQuery(app.db, {
          queryId,
          body: body as string,
          actorId,
          context: {
            siteId: context.siteId,
            subjectKey: context.subjectKey,
            formOid: context.formOid,
          },
        }),
      messageSchema,
    ),
  );
  app.post(
    "/queries/:queryId/reopen",
    lifecycleAction(
      "query.manage",
      (queryId, body, actorId) => reopenQuery(app.db, { queryId, body: body as string, actorId }),
      messageSchema,
    ),
  );
  app.post(
    "/queries/:queryId/close",
    lifecycleAction(
      "query.manage",
      (queryId, body, actorId) =>
        closeQuery(app.db, { queryId, actorId, ...(body ? { body } : {}) }),
      closeSchema,
    ),
  );

  // Listing rows → manual queries in bulk (ADR-0015). query.manage is
  // checked per target's site inside the service: a site-scoped data
  // manager gets site_forbidden skips for other sites, not a 403.
  app.post("/studies/:studyId/queries/batch", async (request, reply) => {
    const { studyId } = request.params as { studyId: string };
    if (!request.user) return reply.code(401).send({ error: "authentication required" });
    if (!request.user.isSystemAdmin && !(await isStudyMember(app.db, request.user.id, studyId))) {
      return reply.code(403).send({ error: "not a member of this study" });
    }
    const parsed = batchSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const result = await createQueryBatch(app.db, {
        studyId,
        actorId: request.user.id,
        message: parsed.data.message,
        targets: parsed.data.targets,
        dryRun: parsed.data.dryRun,
        force: parsed.data.force,
        ...(parsed.data.executionId ? { executionId: parsed.data.executionId } : {}),
      });
      return reply.code(parsed.data.dryRun ? 200 : 201).send(result);
    } catch (err) {
      return sendQueryError(reply, err);
    }
  });

  app.get("/studies/:studyId/queries", async (request, reply) => {
    const { studyId } = request.params as { studyId: string };
    const parsed = listSchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    if (!request.user) return reply.code(401).send({ error: "authentication required" });
    if (!request.user.isSystemAdmin && !(await isStudyMember(app.db, request.user.id, studyId))) {
      return reply.code(403).send({ error: "not a member of this study" });
    }
    return listStudyQueries(
      app.db,
      studyId,
      parsed.data.status ? { status: parsed.data.status } : undefined,
    );
  });

  // Advisory permission listing for UI gating (buttons, not enforcement).
  app.get("/studies/:studyId/permissions", async (request, reply) => {
    const { studyId } = request.params as { studyId: string };
    const { siteId } = request.query as { siteId?: string };
    if (!request.user) return reply.code(401).send({ error: "authentication required" });
    const permissions = await effectivePermissions(app.db, request.user.id, {
      studyId,
      ...(siteId ? { siteId } : {}),
    });
    return { permissions };
  });
};
