import { createStudyRequestSchema, grantRoleRequestSchema } from "@edc-core/schemas";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { requirePermission, requireSystemAdmin } from "../auth/plugin.js";
import { grantRole, revokeRole } from "../auth/rbac.js";
import type { AuthenticatedUser } from "../auth/service.js";
import { auditEvents, roles, studies, userStudyRoles } from "../db/schema/index.js";

function studyScope(request: FastifyRequest) {
  return { studyId: (request.params as { studyId: string }).studyId };
}

export const studyRoutes: FastifyPluginAsync = async (app) => {
  // Membership (any unrevoked grant) is what makes a study visible.
  app.get("/studies", async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: "authentication required" });

    if (user.isSystemAdmin) {
      return app.db.select().from(studies);
    }
    return app.db
      .selectDistinct({
        id: studies.id,
        oid: studies.oid,
        name: studies.name,
        protocolName: studies.protocolName,
        status: studies.status,
        createdAt: studies.createdAt,
      })
      .from(studies)
      .innerJoin(userStudyRoles, eq(userStudyRoles.studyId, studies.id))
      .where(and(eq(userStudyRoles.userId, user.id), isNull(userStudyRoles.revokedAt)));
  });

  // Creating studies is system administration, not a clinical capability.
  app.post("/studies", { preHandler: requireSystemAdmin() }, async (request, reply) => {
    const parsed = createStudyRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const user = request.user as AuthenticatedUser;

    const study = await app.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(studies)
        .values({
          oid: parsed.data.oid,
          name: parsed.data.name,
          protocolName: parsed.data.protocolName ?? null,
        })
        .returning();
      if (!row) throw new Error("study insert returned no row");
      await tx.insert(auditEvents).values({
        actorId: user.id,
        studyId: row.id,
        action: "study.created",
        entityType: "study",
        entityId: row.id,
        newValue: parsed.data,
      });
      return row;
    });
    return reply.code(201).send(study);
  });

  app.post(
    "/studies/:studyId/roles",
    { preHandler: requirePermission("roles.grant", studyScope) },
    async (request, reply) => {
      const parsed = grantRoleRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const { studyId } = request.params as { studyId: string };
      const user = request.user as AuthenticatedUser;

      const [role] = await app.db
        .select()
        .from(roles)
        .where(eq(roles.name, parsed.data.roleName))
        .limit(1);
      if (!role) return reply.code(400).send({ error: `unknown role: ${parsed.data.roleName}` });

      const grant = await grantRole(app.db, {
        userId: parsed.data.userId,
        studyId,
        roleId: role.id,
        ...(parsed.data.siteId ? { siteId: parsed.data.siteId } : {}),
        grantedBy: user.id,
      });
      return reply.code(201).send(grant);
    },
  );

  app.delete(
    "/studies/:studyId/roles/:grantId",
    { preHandler: requirePermission("roles.grant", studyScope) },
    async (request, reply) => {
      const { grantId } = request.params as { grantId: string };
      const user = request.user as AuthenticatedUser;
      await revokeRole(app.db, grantId, user.id);
      return reply.code(204).send();
    },
  );
};
