import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { hasPermission } from "../auth/rbac.js";
import { executeScript, listExecutions, listScripts, saveScript } from "../services/r-workbench.js";
import { executeWorkbenchSql, WorkbenchError } from "../services/workbench.js";

const runSchema = z.object({
  snapshotId: z.uuid(),
  sql: z.string().min(1).max(100_000),
});

const runScriptSchema = z.object({
  snapshotId: z.uuid(),
  content: z.string().min(1).max(200_000),
  scriptId: z.uuid().optional(),
  scriptVersion: z.number().int().min(1).optional(),
});

const saveScriptSchema = z.object({
  name: z.string().min(1).max(120),
  language: z.enum(["r", "python", "sql"]),
  content: z.string().min(1).max(200_000),
});

const ERROR_STATUS: Record<WorkbenchError["code"], number> = {
  not_found: 404,
  invalid: 409,
  query: 400,
  timeout: 408,
  engine: 502,
};

export const workbenchRoutes: FastifyPluginAsync = async (app) => {
  app.post("/studies/:studyId/workbench/sql", async (request, reply) => {
    const { studyId } = request.params as { studyId: string };
    if (!request.user) return reply.code(401).send({ error: "authentication required" });
    if (!(await hasPermission(app.db, request.user.id, "analytics.run", { studyId }))) {
      return reply.code(403).send({ error: "missing permission: analytics.run" });
    }
    const parsed = runSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      return await executeWorkbenchSql(app.db, {
        studyId,
        snapshotId: parsed.data.snapshotId,
        sql: parsed.data.sql,
        actorId: request.user.id,
      });
    } catch (err) {
      if (err instanceof WorkbenchError) {
        return reply.code(ERROR_STATUS[err.code]).send({ error: err.message });
      }
      throw err;
    }
  });

  for (const language of ["r", "python"] as const) {
    app.post(`/studies/:studyId/workbench/${language}`, async (request, reply) => {
      const { studyId } = request.params as { studyId: string };
      if (!request.user) return reply.code(401).send({ error: "authentication required" });
      if (!(await hasPermission(app.db, request.user.id, "analytics.run", { studyId }))) {
        return reply.code(403).send({ error: "missing permission: analytics.run" });
      }
      const parsed = runScriptSchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      try {
        return await executeScript(app.db, {
          studyId,
          language,
          ...parsed.data,
          actorId: request.user.id,
        });
      } catch (err) {
        if (err instanceof WorkbenchError) {
          return reply.code(ERROR_STATUS[err.code]).send({ error: err.message });
        }
        throw err;
      }
    });
  }

  app.get("/studies/:studyId/workbench/scripts", async (request, reply) => {
    const { studyId } = request.params as { studyId: string };
    if (!request.user) return reply.code(401).send({ error: "authentication required" });
    if (!(await hasPermission(app.db, request.user.id, "analytics.run", { studyId }))) {
      return reply.code(403).send({ error: "missing permission: analytics.run" });
    }
    return { scripts: await listScripts(app.db, studyId) };
  });

  app.put("/studies/:studyId/workbench/scripts", async (request, reply) => {
    const { studyId } = request.params as { studyId: string };
    if (!request.user) return reply.code(401).send({ error: "authentication required" });
    if (!(await hasPermission(app.db, request.user.id, "analytics.run", { studyId }))) {
      return reply.code(403).send({ error: "missing permission: analytics.run" });
    }
    const parsed = saveScriptSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      return await saveScript(app.db, { studyId, ...parsed.data, actorId: request.user.id });
    } catch (err) {
      if (err instanceof WorkbenchError) {
        return reply.code(ERROR_STATUS[err.code]).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get("/studies/:studyId/workbench/executions", async (request, reply) => {
    const { studyId } = request.params as { studyId: string };
    if (!request.user) return reply.code(401).send({ error: "authentication required" });
    if (!(await hasPermission(app.db, request.user.id, "analytics.run", { studyId }))) {
      return reply.code(403).send({ error: "missing permission: analytics.run" });
    }
    return { executions: await listExecutions(app.db, studyId) };
  });
};
