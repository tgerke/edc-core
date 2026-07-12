import { createStudyRequestSchema, grantRoleRequestSchema, oidSchema } from "@edc-core/schemas";
import { and, asc, eq, ilike, isNull, ne, notIlike, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { RTSM_AGENT_ROLE } from "../auth/api-keys.js";
import { requireAuth, requirePermission, requireSystemAdmin } from "../auth/plugin.js";
import { grantRole, isStudyMember, revokeRole } from "../auth/rbac.js";
import type { AuthenticatedUser } from "../auth/service.js";
import { auditEvents, roles, sites, studies, userStudyRoles, users } from "../db/schema/index.js";
import { requireMembership } from "./helpers.js";

const createSiteSchema = z.object({ oid: oidSchema, name: z.string().min(1) });

// RTSM service accounts are managed in the RTSM panel, not as team members.
const SERVICE_ACCOUNT_PREFIX = "svc-rtsm-%";

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

  app.get("/studies/:studyId/sites", async (request, reply) => {
    const user = request.user;
    if (!user) return reply.code(401).send({ error: "authentication required" });
    const { studyId } = request.params as { studyId: string };
    if (!user.isSystemAdmin && !(await isStudyMember(app.db, user.id, studyId))) {
      return reply.code(403).send({ error: "not a member of this study" });
    }
    return app.db.select().from(sites).where(eq(sites.studyId, studyId)).orderBy(sites.oid);
  });

  app.post(
    "/studies/:studyId/sites",
    { preHandler: requirePermission("study.manage", studyScope, { allowSystemAdmin: true }) },
    async (request, reply) => {
      const parsed = createSiteSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const { studyId } = request.params as { studyId: string };
      const user = request.user as AuthenticatedUser;

      const site = await app.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(sites)
          .values({ studyId, oid: parsed.data.oid, name: parsed.data.name })
          .returning();
        if (!row) throw new Error("site insert returned no row");
        await tx.insert(auditEvents).values({
          actorId: user.id,
          studyId,
          action: "site.created",
          entityType: "site",
          entityId: row.id,
          newValue: parsed.data,
        });
        return row;
      });
      return reply.code(201).send(site);
    },
  );

  app.post(
    "/studies/:studyId/roles",
    // allowSystemAdmin: the first grant in a new study must come from somewhere.
    { preHandler: requirePermission("roles.grant", studyScope, { allowSystemAdmin: true }) },
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

      // The partial unique index (0017) also enforces this; the pre-check
      // turns the race loser's 500 into a friendly 409.
      const siteCondition = parsed.data.siteId
        ? eq(userStudyRoles.siteId, parsed.data.siteId)
        : isNull(userStudyRoles.siteId);
      const [active] = await app.db
        .select({ id: userStudyRoles.id })
        .from(userStudyRoles)
        .where(
          and(
            eq(userStudyRoles.userId, parsed.data.userId),
            eq(userStudyRoles.studyId, studyId),
            eq(userStudyRoles.roleId, role.id),
            siteCondition,
            isNull(userStudyRoles.revokedAt),
          ),
        )
        .limit(1);
      if (active) {
        return reply.code(409).send({ error: "this role is already granted at this scope" });
      }

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
    { preHandler: requirePermission("roles.grant", studyScope, { allowSystemAdmin: true }) },
    async (request, reply) => {
      const { grantId } = request.params as { grantId: string };
      const user = request.user as AuthenticatedUser;
      await revokeRole(app.db, grantId, user.id);
      return reply.code(204).send();
    },
  );

  // Role catalog for team pickers. rtsm_agent is machine-only: it exists to
  // back API keys and must never be granted to a person.
  app.get("/roles", { preHandler: requireAuth }, async () => {
    return app.db
      .select({ name: roles.name, description: roles.description })
      .from(roles)
      .where(ne(roles.name, RTSM_AGENT_ROLE))
      .orderBy(asc(roles.name));
  });

  // Who is on this study: every member can see the team (it's their own
  // delegation context); only roles.grant holders can change it.
  app.get("/studies/:studyId/members", async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: "authentication required" });
    if (!(await requireMembership(request))) {
      return reply.code(403).send({ error: "not a member of this study" });
    }
    const { studyId } = request.params as { studyId: string };
    const grantedByUsers = alias(users, "granted_by_users");
    return app.db
      .select({
        grantId: userStudyRoles.id,
        userId: users.id,
        username: users.username,
        fullName: users.fullName,
        email: users.email,
        userStatus: users.status,
        roleName: roles.name,
        siteId: sites.id,
        siteOid: sites.oid,
        siteName: sites.name,
        grantedAt: userStudyRoles.grantedAt,
        grantedBy: grantedByUsers.username,
      })
      .from(userStudyRoles)
      .innerJoin(users, eq(userStudyRoles.userId, users.id))
      .innerJoin(roles, eq(userStudyRoles.roleId, roles.id))
      .innerJoin(grantedByUsers, eq(userStudyRoles.grantedBy, grantedByUsers.id))
      .leftJoin(sites, eq(userStudyRoles.siteId, sites.id))
      .where(
        and(
          eq(userStudyRoles.studyId, studyId),
          isNull(userStudyRoles.revokedAt),
          notIlike(users.username, SERVICE_ACCOUNT_PREFIX),
        ),
      )
      .orderBy(asc(users.fullName), asc(roles.name));
  });

  // User lookup for the grant form. Gated by roles.grant (not open to all
  // members) and study-scoped, so there is no browsable user directory;
  // returns just enough to pick the right person.
  app.get(
    "/studies/:studyId/users",
    { preHandler: requirePermission("roles.grant", studyScope, { allowSystemAdmin: true }) },
    async (request) => {
      const { query } = request.query as { query?: string };
      const term = (query ?? "").trim();
      if (term === "") return [];
      const pattern = `%${term}%`;
      return app.db
        .select({
          id: users.id,
          username: users.username,
          fullName: users.fullName,
          email: users.email,
        })
        .from(users)
        .where(
          and(
            or(
              ilike(users.username, pattern),
              ilike(users.fullName, pattern),
              ilike(users.email, pattern),
            ),
            ne(users.status, "deactivated"),
            notIlike(users.username, SERVICE_ACCOUNT_PREFIX),
          ),
        )
        .orderBy(asc(users.username))
        .limit(10);
    },
  );
};
