import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_KEY_PREFIX, mintApiKey, RTSM_AGENT_ROLE, requireRtsmKey } from "../auth/api-keys.js";
import { hashPassword } from "../auth/password.js";
import { authPlugin } from "../auth/plugin.js";
import { grantRole } from "../auth/rbac.js";
import { createDb, databaseUrl } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { auditEvents, roles, studies, userStudyRoles, users } from "../db/schema/index.js";
import { buildServer } from "../server.js";

const { db, client } = createDb();
let dbAvailable = false;
try {
  await client`SELECT 1`;
  dbAvailable = true;
} catch {
  if (process.env.CI) throw new Error(`CI requires a reachable database at ${databaseUrl()}`);
  console.warn(`⚠ Skipping RTSM API key tests: no database at ${databaseUrl()}.`);
}

const PASSWORD = "correct-Horse-battery-7";

describe.skipIf(!dbAvailable)("RTSM API keys (integration)", () => {
  let server: FastifyInstance;
  // Minimal instance exposing a requireRtsmKey-guarded route, since PR-stage
  // key management ships before the intake routes that will consume the guard.
  let probe: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const fx = {
    studyId: "",
    otherStudyId: "",
    adminToken: "",
    adminId: "",
    entryToken: "",
  };

  function inject(token: string, opts: { method: "GET" | "POST"; url: string; payload?: object }) {
    return server.inject({ ...opts, headers: { authorization: `Bearer ${token}` } });
  }

  async function serviceAccount() {
    const [account] = await db
      .select()
      .from(users)
      .where(eq(users.username, `svc-rtsm-${fx.studyId}`))
      .limit(1);
    return account ?? null;
  }

  beforeAll(async () => {
    await runMigrations();
    server = await buildServer({ db });
    await server.ready();

    probe = Fastify();
    await probe.register(authPlugin, { db });
    probe.post("/studies/:studyId/rtsm/probe", { preHandler: requireRtsmKey }, async (request) => ({
      principal: request.servicePrincipal,
    }));
    await probe.ready();

    const [study] = await db
      .insert(studies)
      .values({ oid: `ST.RTSM.${suffix}`, name: "RTSM Key Study" })
      .returning();
    const [otherStudy] = await db
      .insert(studies)
      .values({ oid: `ST.RTSM2.${suffix}`, name: "Other Study" })
      .returning();
    if (!study || !otherStudy) throw new Error("fixture failed");
    fx.studyId = study.id;
    fx.otherStudyId = otherStudy.id;

    const mkUser = async (username: string, roleName: string) => {
      const [user] = await db
        .insert(users)
        .values({
          username,
          email: `${username}@example.com`,
          fullName: username,
          passwordHash: await hashPassword(PASSWORD),
        })
        .returning();
      const [role] = await db.select().from(roles).where(eq(roles.name, roleName));
      if (!user || !role) throw new Error("fixture failed");
      await grantRole(db, {
        userId: user.id,
        studyId: study.id,
        roleId: role.id,
        grantedBy: user.id,
      });
      const token = (
        await server.inject({
          method: "POST",
          url: "/auth/login",
          payload: { username, password: PASSWORD },
        })
      ).json().token;
      return { id: user.id, token };
    };

    const admin = await mkUser(`rtsm-admin-${suffix}`, "admin");
    const entry = await mkUser(`rtsm-entry-${suffix}`, "data_entry");
    fx.adminId = admin.id;
    fx.adminToken = admin.token;
    fx.entryToken = entry.token;
  });

  afterAll(async () => {
    await probe.close();
    await server.close();
    await client.end();
  });

  it("key management requires study.manage", async () => {
    const forbidden = await inject(fx.entryToken, {
      method: "POST",
      url: `/studies/${fx.studyId}/rtsm/keys`,
      payload: { label: "Vendor X" },
    });
    expect(forbidden.statusCode).toBe(403);

    const list = await inject(fx.entryToken, {
      method: "GET",
      url: `/studies/${fx.studyId}/rtsm/keys`,
    });
    expect(list.statusCode).toBe(403);
  });

  it("mints a show-once token and provisions the service account with rtsm_agent", async () => {
    const res = await inject(fx.adminToken, {
      method: "POST",
      url: `/studies/${fx.studyId}/rtsm/keys`,
      payload: { label: "Vendor X production" },
    });
    expect(res.statusCode).toBe(201);
    const minted = res.json();
    expect(minted.token.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(minted.token.startsWith(minted.tokenPrefix)).toBe(true);
    expect(minted.tokenPrefix.length).toBeLessThan(minted.token.length);

    const account = await serviceAccount();
    expect(account).not.toBeNull();
    expect(account?.passwordHash).toBeNull();

    // Study-wide, unrevoked rtsm_agent grant on the service account.
    const grants = await db
      .select({ id: userStudyRoles.id })
      .from(userStudyRoles)
      .innerJoin(roles, eq(userStudyRoles.roleId, roles.id))
      .where(
        and(
          eq(userStudyRoles.userId, account?.id ?? ""),
          eq(userStudyRoles.studyId, fx.studyId),
          eq(roles.name, RTSM_AGENT_ROLE),
          isNull(userStudyRoles.siteId),
          isNull(userStudyRoles.revokedAt),
        ),
      );
    expect(grants).toHaveLength(1);

    for (const action of ["rtsm.service_account_created", "rtsm.key_created"]) {
      const rows = await db
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(and(eq(auditEvents.studyId, fx.studyId), eq(auditEvents.action, action)));
      expect(rows.length, action).toBeGreaterThan(0);
    }

    // A second key reuses the same service account.
    const again = await inject(fx.adminToken, {
      method: "POST",
      url: `/studies/${fx.studyId}/rtsm/keys`,
      payload: { label: "Vendor X staging" },
    });
    expect(again.statusCode).toBe(201);
    const accounts = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, `svc-rtsm-${fx.studyId}`));
    expect(accounts).toHaveLength(1);
  });

  it("listing never exposes the secret", async () => {
    const res = await inject(fx.adminToken, {
      method: "GET",
      url: `/studies/${fx.studyId}/rtsm/keys`,
    });
    expect(res.statusCode).toBe(200);
    const keys = res.json();
    expect(keys.length).toBeGreaterThanOrEqual(2);
    for (const key of keys) {
      expect(key.token).toBeUndefined();
      expect(key.tokenHash).toBeUndefined();
      expect(key.tokenPrefix.startsWith(API_KEY_PREFIX)).toBe(true);
    }
  });

  it("the guard accepts a valid key only for its own study", async () => {
    const minted = (
      await inject(fx.adminToken, {
        method: "POST",
        url: `/studies/${fx.studyId}/rtsm/keys`,
        payload: { label: "guard test" },
      })
    ).json();

    const ok = await probe.inject({
      method: "POST",
      url: `/studies/${fx.studyId}/rtsm/probe`,
      headers: { authorization: `Bearer ${minted.token}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().principal.studyId).toBe(fx.studyId);

    const crossStudy = await probe.inject({
      method: "POST",
      url: `/studies/${fx.otherStudyId}/rtsm/probe`,
      headers: { authorization: `Bearer ${minted.token}` },
    });
    expect(crossStudy.statusCode).toBe(403);

    const garbage = await probe.inject({
      method: "POST",
      url: `/studies/${fx.studyId}/rtsm/probe`,
      headers: { authorization: `Bearer ${API_KEY_PREFIX}not-a-real-key` },
    });
    expect(garbage.statusCode).toBe(401);

    // A human session token is not an API key.
    const session = await probe.inject({
      method: "POST",
      url: `/studies/${fx.studyId}/rtsm/probe`,
      headers: { authorization: `Bearer ${fx.adminToken}` },
    });
    expect(session.statusCode).toBe(401);
  });

  it("an API key never acts as a session", async () => {
    const minted = (
      await inject(fx.adminToken, {
        method: "POST",
        url: `/studies/${fx.studyId}/rtsm/keys`,
        payload: { label: "session test" },
      })
    ).json();

    const me = await inject(minted.token, { method: "GET", url: "/auth/me" });
    expect(me.statusCode).toBe(401);

    const list = await inject(minted.token, {
      method: "GET",
      url: `/studies/${fx.studyId}/rtsm/keys`,
    });
    expect(list.statusCode).toBe(401);
  });

  it("revocation, expiry, and deactivation invalidate keys", async () => {
    const minted = (
      await inject(fx.adminToken, {
        method: "POST",
        url: `/studies/${fx.studyId}/rtsm/keys`,
        payload: { label: "revoke me" },
      })
    ).json();

    const revoke = await inject(fx.adminToken, {
      method: "POST",
      url: `/studies/${fx.studyId}/rtsm/keys/${minted.id}/revoke`,
    });
    expect(revoke.statusCode).toBe(200);
    const revokeAgain = await inject(fx.adminToken, {
      method: "POST",
      url: `/studies/${fx.studyId}/rtsm/keys/${minted.id}/revoke`,
    });
    expect(revokeAgain.statusCode).toBe(404);

    const revoked = await probe.inject({
      method: "POST",
      url: `/studies/${fx.studyId}/rtsm/probe`,
      headers: { authorization: `Bearer ${minted.token}` },
    });
    expect(revoked.statusCode).toBe(401);

    const audit = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "rtsm.key_revoked"), eq(auditEvents.entityId, minted.id)));
    expect(audit).toHaveLength(1);

    const account = await serviceAccount();
    if (!account) throw new Error("service account missing");
    const expired = await mintApiKey(db, {
      studyId: fx.studyId,
      userId: account.id,
      label: "already expired",
      createdBy: fx.adminId,
      expiresAt: new Date(Date.now() - 1000),
    });
    const expiredRes = await probe.inject({
      method: "POST",
      url: `/studies/${fx.studyId}/rtsm/probe`,
      headers: { authorization: `Bearer ${expired.token}` },
    });
    expect(expiredRes.statusCode).toBe(401);

    // Deactivating the service account kills every key it backs.
    const live = (
      await inject(fx.adminToken, {
        method: "POST",
        url: `/studies/${fx.studyId}/rtsm/keys`,
        payload: { label: "deactivation test" },
      })
    ).json();
    await db.update(users).set({ status: "deactivated" }).where(eq(users.id, account.id));
    try {
      const dead = await probe.inject({
        method: "POST",
        url: `/studies/${fx.studyId}/rtsm/probe`,
        headers: { authorization: `Bearer ${live.token}` },
      });
      expect(dead.statusCode).toBe(401);
    } finally {
      await db.update(users).set({ status: "active" }).where(eq(users.id, account.id));
    }
  });
});
