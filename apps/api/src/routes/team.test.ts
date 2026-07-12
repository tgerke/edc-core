import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password.js";
import { grantRole } from "../auth/rbac.js";
import { createDb, databaseUrl } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { auditEvents, roles, sites, studies, users } from "../db/schema/index.js";
import { buildServer } from "../server.js";

const { db, client } = createDb();
let dbAvailable = false;
try {
  await client`SELECT 1`;
  dbAvailable = true;
} catch {
  if (process.env.CI) throw new Error(`CI requires a reachable database at ${databaseUrl()}`);
  console.warn(`⚠ Skipping team tests: no database at ${databaseUrl()}.`);
}

const PASSWORD = "correct-Horse-battery-7";

describe.skipIf(!dbAvailable)("study team management (integration)", () => {
  let server: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const fx = {
    studyId: "",
    siteAId: "",
    adminToken: "",
    adminId: "",
    monitorToken: "",
    outsiderToken: "",
    targetId: "",
    targetUsername: "",
  };

  function inject(
    token: string,
    opts: { method: "GET" | "POST" | "DELETE"; url: string; payload?: object },
  ) {
    return server.inject({ ...opts, headers: { authorization: `Bearer ${token}` } });
  }

  function grant(payload: { userId: string; roleName: string; siteId?: string }) {
    return inject(fx.adminToken, {
      method: "POST",
      url: `/studies/${fx.studyId}/roles`,
      payload,
    });
  }

  async function members() {
    const res = await inject(fx.adminToken, {
      method: "GET",
      url: `/studies/${fx.studyId}/members`,
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  beforeAll(async () => {
    await runMigrations();
    server = await buildServer({ db });
    await server.ready();

    const [study] = await db
      .insert(studies)
      .values({ oid: `ST.TEAM.${suffix}`, name: "Team Study" })
      .returning();
    if (!study) throw new Error("fixture failed");
    fx.studyId = study.id;
    const [siteA] = await db
      .insert(sites)
      .values({ studyId: study.id, oid: "SITE.A", name: "Site A" })
      .returning();
    if (!siteA) throw new Error("fixture failed");
    fx.siteAId = siteA.id;

    const mkUser = async (username: string, roleName: string | null) => {
      const [user] = await db
        .insert(users)
        .values({
          username,
          email: `${username}@example.com`,
          fullName: username,
          passwordHash: await hashPassword(PASSWORD),
        })
        .returning();
      if (!user) throw new Error("fixture failed");
      if (roleName) {
        const [role] = await db.select().from(roles).where(eq(roles.name, roleName));
        if (!role) throw new Error("fixture failed");
        await grantRole(db, {
          userId: user.id,
          studyId: study.id,
          roleId: role.id,
          grantedBy: user.id,
        });
      }
      const token = (
        await server.inject({
          method: "POST",
          url: "/auth/login",
          payload: { username, password: PASSWORD },
        })
      ).json().token;
      return { id: user.id, token };
    };

    const admin = await mkUser(`team-admin-${suffix}`, "admin");
    const monitor = await mkUser(`team-monitor-${suffix}`, "monitor");
    const outsider = await mkUser(`team-outsider-${suffix}`, null);
    const target = await mkUser(`team-target-${suffix}`, null);
    fx.adminId = admin.id;
    fx.adminToken = admin.token;
    fx.monitorToken = monitor.token;
    fx.outsiderToken = outsider.token;
    fx.targetId = target.id;
    fx.targetUsername = `team-target-${suffix}`;
  });

  afterAll(async () => {
    await server.close();
    await client.end();
  });

  it("the role catalog is available to any signed-in user and hides rtsm_agent", async () => {
    const res = await inject(fx.outsiderToken, { method: "GET", url: "/roles" });
    expect(res.statusCode).toBe(200);
    const names = res.json().map((r: { name: string }) => r.name);
    expect(names).toContain("admin");
    expect(names).toContain("monitor");
    expect(names).not.toContain("rtsm_agent");
  });

  it("members are visible to members only and exclude service accounts", async () => {
    const outsider = await inject(fx.outsiderToken, {
      method: "GET",
      url: `/studies/${fx.studyId}/members`,
    });
    expect(outsider.statusCode).toBe(403);

    const asMonitor = await inject(fx.monitorToken, {
      method: "GET",
      url: `/studies/${fx.studyId}/members`,
    });
    expect(asMonitor.statusCode).toBe(200);
    const usernames = asMonitor.json().map((m: { username: string }) => m.username);
    expect(usernames).toContain(`team-admin-${suffix}`);
    expect(usernames).toContain(`team-monitor-${suffix}`);
    expect(usernames.some((u: string) => u.startsWith("svc-rtsm-"))).toBe(false);
  });

  it("user search requires roles.grant, matches broadly, excludes deactivated", async () => {
    const forbidden = await inject(fx.monitorToken, {
      method: "GET",
      url: `/studies/${fx.studyId}/users?query=team-target`,
    });
    expect(forbidden.statusCode).toBe(403);

    const found = await inject(fx.adminToken, {
      method: "GET",
      url: `/studies/${fx.studyId}/users?query=team-target-${suffix}`,
    });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toHaveLength(1);
    expect(found.json()[0].id).toBe(fx.targetId);
    // Match by full name and email fragments too.
    const byEmail = await inject(fx.adminToken, {
      method: "GET",
      url: `/studies/${fx.studyId}/users?query=team-target-${suffix}@example`,
    });
    expect(byEmail.json()).toHaveLength(1);

    const empty = await inject(fx.adminToken, {
      method: "GET",
      url: `/studies/${fx.studyId}/users`,
    });
    expect(empty.json()).toEqual([]);

    await db.update(users).set({ status: "deactivated" }).where(eq(users.id, fx.targetId));
    try {
      const gone = await inject(fx.adminToken, {
        method: "GET",
        url: `/studies/${fx.studyId}/users?query=team-target-${suffix}`,
      });
      expect(gone.json()).toEqual([]);
    } finally {
      await db.update(users).set({ status: "active" }).where(eq(users.id, fx.targetId));
    }
  });

  it("grants appear in the members list with their scope, audited", async () => {
    const siteScoped = await grant({
      userId: fx.targetId,
      roleName: "data_entry",
      siteId: fx.siteAId,
    });
    expect(siteScoped.statusCode).toBe(201);

    const team = await members();
    const entry = team.find(
      (m: { username: string; roleName: string }) =>
        m.username === fx.targetUsername && m.roleName === "data_entry",
    );
    expect(entry.siteOid).toBe("SITE.A");
    expect(entry.grantedBy).toBe(`team-admin-${suffix}`);

    const trail = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(and(eq(auditEvents.studyId, fx.studyId), eq(auditEvents.action, "rbac.role_granted")));
    expect(trail.length).toBeGreaterThan(0);

    // Monitors can see the team but not change it.
    const denied = await inject(fx.monitorToken, {
      method: "POST",
      url: `/studies/${fx.studyId}/roles`,
      payload: { userId: fx.targetId, roleName: "monitor" },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("an identical active grant is refused with 409", async () => {
    const dup = await grant({ userId: fx.targetId, roleName: "data_entry", siteId: fx.siteAId });
    expect(dup.statusCode).toBe(409);
    // A different scope is fine: same role study-wide is a distinct grant.
    const studyWide = await grant({ userId: fx.targetId, roleName: "data_entry" });
    expect(studyWide.statusCode).toBe(201);
  });

  it("revoke then re-grant of the same combination works (0017 regression)", async () => {
    const team = await members();
    const entry = team.find(
      (m: { username: string; roleName: string; siteOid: string | null }) =>
        m.username === fx.targetUsername && m.roleName === "data_entry" && m.siteOid === "SITE.A",
    );
    expect(entry).toBeDefined();

    const revoked = await inject(fx.adminToken, {
      method: "DELETE",
      url: `/studies/${fx.studyId}/roles/${entry.grantId}`,
    });
    expect(revoked.statusCode).toBe(204);

    const after = await members();
    expect(
      after.some((m: { grantId: string }) => m.grantId === entry.grantId),
      "revoked grant must leave the members list",
    ).toBe(false);

    // Before 0017 this hit the unique index (23505) and 500ed.
    const regrant = await grant({
      userId: fx.targetId,
      roleName: "data_entry",
      siteId: fx.siteAId,
    });
    expect(regrant.statusCode).toBe(201);
    expect(regrant.json().id).not.toBe(entry.grantId);
  });
});
