import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, databaseUrl } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { auditEvents, roles, sessions, sites, studies, users } from "../db/schema/index.js";
import { buildServer } from "../server.js";
import type { AuthConfig } from "./config.js";
import { hashPassword } from "./password.js";
import { grantRole, hasPermission, revokeRole } from "./rbac.js";

const { db, client } = createDb();
let dbAvailable = false;
try {
  await client`SELECT 1`;
  dbAvailable = true;
} catch {
  if (process.env.CI) throw new Error(`CI requires a reachable database at ${databaseUrl()}`);
  console.warn(
    `⚠ Skipping auth integration tests: no database at ${databaseUrl()}. ` +
      "Start one with: podman compose -f infra/compose.yaml up -d postgres",
  );
}

const authConfig: AuthConfig = {
  passwordMinLength: 12,
  maxFailedLogins: 3,
  lockoutMinutes: 15,
  sessionIdleMinutes: 30,
  sessionAbsoluteHours: 8,
};

const PASSWORD = "correct-Horse-battery-7";

describe.skipIf(!dbAvailable)("auth + rbac (integration)", () => {
  let server: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const fx = { aliceId: "", bobId: "", adminId: "", studyAId: "", studyBId: "", siteA1Id: "" };

  async function makeUser(name: string, isSystemAdmin = false): Promise<string> {
    const [user] = await db
      .insert(users)
      .values({
        username: `${name}-${suffix}`,
        email: `${name}-${suffix}@example.com`,
        fullName: name,
        passwordHash: await hashPassword(PASSWORD),
        isSystemAdmin,
      })
      .returning();
    if (!user) throw new Error("user fixture failed");
    return user.id;
  }

  async function login(name: string, password = PASSWORD) {
    return server.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: `${name}-${suffix}`, password },
    });
  }

  beforeAll(async () => {
    await runMigrations();
    server = await buildServer({ db, authConfig });
    await server.ready();

    fx.aliceId = await makeUser("alice");
    fx.bobId = await makeUser("bob");
    fx.adminId = await makeUser("root", true);
    const [studyA] = await db
      .insert(studies)
      .values({ oid: `ST.A.${suffix}`, name: "Study A" })
      .returning();
    const [studyB] = await db
      .insert(studies)
      .values({ oid: `ST.B.${suffix}`, name: "Study B" })
      .returning();
    if (!studyA || !studyB) throw new Error("study fixture failed");
    fx.studyAId = studyA.id;
    fx.studyBId = studyB.id;
    const [siteA1] = await db
      .insert(sites)
      .values({ studyId: studyA.id, oid: "SITE.A1", name: "Site A1" })
      .returning();
    if (!siteA1) throw new Error("site fixture failed");
    fx.siteA1Id = siteA1.id;
  });

  afterAll(async () => {
    await server.close();
    await client.end();
  });

  describe("login and sessions", () => {
    it("logs in with valid credentials and serves /auth/me", async () => {
      const res = await login("alice");
      expect(res.statusCode).toBe(200);
      const { token } = res.json();

      const me = await server.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json().username).toBe(`alice-${suffix}`);
    });

    it("rejects bad credentials without revealing which part failed", async () => {
      const res = await login("alice", "wrong-password-1!");
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("invalid_credentials");
    });

    it("locks the account after repeated failures and audits the lockout", async () => {
      for (let i = 0; i < authConfig.maxFailedLogins; i++) {
        await login("bob", "wrong-password-1!");
      }
      const locked = await login("bob"); // correct password, but locked now
      expect(locked.statusCode).toBe(401);
      expect(locked.json().error).toBe("locked");

      const events = await db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.entityId, fx.bobId), eq(auditEvents.action, "auth.lockout")));
      expect(events).toHaveLength(1);
    });

    it("expires idle sessions", async () => {
      const res = await login("alice");
      const { token } = res.json();

      // Age the session past the idle window (sessions are operational
      // state, not clinical data — direct update is fine).
      const stale = new Date(Date.now() - (authConfig.sessionIdleMinutes + 1) * 60_000);
      await db.update(sessions).set({ lastSeenAt: stale }).where(eq(sessions.userId, fx.aliceId));

      const me = await server.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(me.statusCode).toBe(401);
    });

    it("revokes the session on logout", async () => {
      const { token } = (await login("alice")).json();
      const out = await server.inject({
        method: "POST",
        url: "/auth/logout",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(out.statusCode).toBe(200);

      const me = await server.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(me.statusCode).toBe(401);
    });
  });

  describe("rbac scoping", () => {
    it("grants are study-scoped", async () => {
      const [dataEntry] = await db.select().from(roles).where(eq(roles.name, "data_entry"));
      if (!dataEntry) throw new Error("seeded role missing");

      await grantRole(db, {
        userId: fx.aliceId,
        studyId: fx.studyAId,
        roleId: dataEntry.id,
        grantedBy: fx.adminId,
      });

      expect(await hasPermission(db, fx.aliceId, "data.enter", { studyId: fx.studyAId })).toBe(
        true,
      );
      expect(await hasPermission(db, fx.aliceId, "data.enter", { studyId: fx.studyBId })).toBe(
        false,
      );
      // Role does not carry permissions it wasn't seeded with.
      expect(await hasPermission(db, fx.aliceId, "data.sign", { studyId: fx.studyAId })).toBe(
        false,
      );
    });

    it("site-scoped grants do not authorize other sites", async () => {
      const [investigator] = await db.select().from(roles).where(eq(roles.name, "investigator"));
      if (!investigator) throw new Error("seeded role missing");

      await grantRole(db, {
        userId: fx.bobId,
        studyId: fx.studyAId,
        roleId: investigator.id,
        siteId: fx.siteA1Id,
        grantedBy: fx.adminId,
      });

      expect(
        await hasPermission(db, fx.bobId, "data.sign", {
          studyId: fx.studyAId,
          siteId: fx.siteA1Id,
        }),
      ).toBe(true);
      expect(
        await hasPermission(db, fx.bobId, "data.sign", {
          studyId: fx.studyAId,
          siteId: randomUUID(),
        }),
      ).toBe(false);
      // A site-scoped grant is not a study-wide grant.
      expect(await hasPermission(db, fx.bobId, "data.sign", { studyId: fx.studyAId })).toBe(false);
    });

    it("revocation removes the permission and is audited", async () => {
      const [monitor] = await db.select().from(roles).where(eq(roles.name, "monitor"));
      if (!monitor) throw new Error("seeded role missing");

      const grant = await grantRole(db, {
        userId: fx.aliceId,
        studyId: fx.studyBId,
        roleId: monitor.id,
        grantedBy: fx.adminId,
      });
      expect(await hasPermission(db, fx.aliceId, "data.verify", { studyId: fx.studyBId })).toBe(
        true,
      );

      await revokeRole(db, grant.id, fx.adminId);
      expect(await hasPermission(db, fx.aliceId, "data.verify", { studyId: fx.studyBId })).toBe(
        false,
      );

      const trail = await db
        .select()
        .from(auditEvents)
        .where(
          and(eq(auditEvents.entityId, grant.id), eq(auditEvents.action, "rbac.role_revoked")),
        );
      expect(trail).toHaveLength(1);
    });
  });

  describe("route guards", () => {
    it("permission-guarded routes return 401 unauthenticated and 403 without the permission", async () => {
      const unauthenticated = await server.inject({
        method: "POST",
        url: `/studies/${fx.studyAId}/roles`,
        payload: { userId: fx.bobId, roleName: "monitor" },
      });
      expect(unauthenticated.statusCode).toBe(401);

      const { token } = (await login("alice")).json(); // alice lacks roles.grant
      const forbidden = await server.inject({
        method: "POST",
        url: `/studies/${fx.studyAId}/roles`,
        payload: { userId: fx.bobId, roleName: "monitor" },
        headers: { authorization: `Bearer ${token}` },
      });
      expect(forbidden.statusCode).toBe(403);
    });

    it("system admin can make the first role grant in a new study", async () => {
      const { token } = (await login("root")).json();
      const res = await server.inject({
        method: "POST",
        url: `/studies/${fx.studyBId}/roles`,
        payload: { userId: fx.bobId, roleName: "read_only" },
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(201);
    });

    it("system admin can create studies; non-admins cannot", async () => {
      const { token: rootToken } = (await login("root")).json();
      const created = await server.inject({
        method: "POST",
        url: "/studies",
        payload: { oid: `ST.NEW.${suffix}`, name: "Created via API" },
        headers: { authorization: `Bearer ${rootToken}` },
      });
      expect(created.statusCode).toBe(201);

      const { token: aliceToken } = (await login("alice")).json();
      const denied = await server.inject({
        method: "POST",
        url: "/studies",
        payload: { oid: `ST.DENIED.${suffix}`, name: "Should fail" },
        headers: { authorization: `Bearer ${aliceToken}` },
      });
      expect(denied.statusCode).toBe(403);
    });

    it("GET /studies lists only studies where the user holds a grant", async () => {
      const { token } = (await login("alice")).json();
      const res = await server.inject({
        method: "GET",
        url: "/studies",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const ids = res.json().map((s: { id: string }) => s.id);
      expect(ids).toContain(fx.studyAId); // data_entry grant from earlier test
      expect(ids).not.toContain(fx.studyBId); // monitor grant was revoked
    });
  });
});
