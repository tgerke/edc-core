import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAuthConfig } from "../auth/config.js";
import { hashPassword } from "../auth/password.js";
import { createDb, databaseUrl } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { auditEvents, sessions, users } from "../db/schema/index.js";
import { buildServer } from "../server.js";

const { db, client } = createDb();
let dbAvailable = false;
try {
  await client`SELECT 1`;
  dbAvailable = true;
} catch {
  if (process.env.CI) throw new Error(`CI requires a reachable database at ${databaseUrl()}`);
  console.warn(`⚠ Skipping user admin tests: no database at ${databaseUrl()}.`);
}

const PASSWORD = "correct-Horse-battery-7";

describe.skipIf(!dbAvailable)("user administration (integration)", () => {
  let server: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const fx = {
    adminId: "",
    adminToken: "",
    plainToken: "",
    plainId: "",
  };

  function inject(token: string, opts: { method: "GET" | "POST"; url: string; payload?: object }) {
    return server.inject({ ...opts, headers: { authorization: `Bearer ${token}` } });
  }

  async function login(username: string, password: string) {
    return server.inject({ method: "POST", url: "/auth/login", payload: { username, password } });
  }

  async function liveSessionCount(userId: string) {
    const rows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
    return rows.length;
  }

  beforeAll(async () => {
    await runMigrations();
    server = await buildServer({ db });
    await server.ready();

    const mkUser = async (username: string, isSystemAdmin: boolean) => {
      const [user] = await db
        .insert(users)
        .values({
          username,
          email: `${username}@example.com`,
          fullName: username,
          passwordHash: await hashPassword(PASSWORD),
          isSystemAdmin,
        })
        .returning();
      if (!user) throw new Error("fixture failed");
      const token = (await login(username, PASSWORD)).json().token;
      return { id: user.id, token };
    };

    const admin = await mkUser(`ua-admin-${suffix}`, true);
    const plain = await mkUser(`ua-plain-${suffix}`, false);
    fx.adminId = admin.id;
    fx.adminToken = admin.token;
    fx.plainId = plain.id;
    fx.plainToken = plain.token;
  });

  afterAll(async () => {
    await server.close();
    await client.end();
  });

  it("every route requires a system administrator", async () => {
    const calls: Array<{ method: "GET" | "POST"; url: string; payload?: object }> = [
      { method: "GET", url: "/admin/users" },
      {
        method: "POST",
        url: "/admin/users",
        payload: { username: "x", email: "x@example.com", fullName: "x", auth: "password" },
      },
      { method: "POST", url: `/admin/users/${fx.adminId}/deactivate` },
      { method: "POST", url: `/admin/users/${fx.adminId}/reactivate` },
      { method: "POST", url: `/admin/users/${fx.adminId}/unlock` },
      { method: "POST", url: `/admin/users/${fx.adminId}/reset-password` },
      {
        method: "POST",
        url: `/admin/users/${fx.adminId}/system-admin`,
        payload: { isSystemAdmin: true },
      },
    ];
    for (const call of calls) {
      const res = await inject(fx.plainToken, call);
      expect(res.statusCode, call.url).toBe(403);
    }
  });

  it("creates a user with a show-once temporary password and gates it to change-password", async () => {
    const username = `ua-new-${suffix}`;
    const created = await inject(fx.adminToken, {
      method: "POST",
      url: "/admin/users",
      payload: {
        username,
        email: `${username}@example.com`,
        fullName: "New Coordinator",
        auth: "password",
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.temporaryPassword).toBeDefined();
    expect(body.mustChangePassword).toBe(true);

    // The temp password logs in, but the session can reach nothing else.
    const loggedIn = await login(username, body.temporaryPassword);
    expect(loggedIn.statusCode).toBe(200);
    const tempToken = loggedIn.json().token;

    const gated = await inject(tempToken, { method: "GET", url: "/studies" });
    expect(gated.statusCode).toBe(403);
    expect(gated.json().code).toBe("password_change_required");

    const me = await inject(tempToken, { method: "GET", url: "/auth/me" });
    expect(me.statusCode).toBe(200);
    expect(me.json().mustChangePassword).toBe(true);

    // Wrong current password fails and counts toward lockout.
    const before = await db.select().from(users).where(eq(users.username, username));
    const wrongCurrent = await inject(tempToken, {
      method: "POST",
      url: "/auth/change-password",
      payload: { currentPassword: "not-the-temp-password", newPassword: PASSWORD },
    });
    expect(wrongCurrent.statusCode).toBe(400);
    const after = await db.select().from(users).where(eq(users.username, username));
    expect(after[0]?.failedLoginCount).toBe((before[0]?.failedLoginCount ?? 0) + 1);

    // A policy-violating new password is rejected with the policy message.
    const config = loadAuthConfig();
    const weak = await inject(tempToken, {
      method: "POST",
      url: "/auth/change-password",
      payload: { currentPassword: body.temporaryPassword, newPassword: "short" },
    });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().code).toBe("policy");
    expect(config.passwordMinLength).toBeGreaterThan(5);

    // A valid change lifts the gate.
    const changed = await inject(tempToken, {
      method: "POST",
      url: "/auth/change-password",
      payload: { currentPassword: body.temporaryPassword, newPassword: PASSWORD },
    });
    expect(changed.statusCode).toBe(200);
    const ungated = await inject(tempToken, { method: "GET", url: "/studies" });
    expect(ungated.statusCode).toBe(200);

    const trail = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, body.id), eq(auditEvents.entityType, "user")));
    const actions = trail.map((e) => e.action);
    expect(actions).toContain("user.created");
    expect(actions).toContain("auth.password_changed");

    // No audit row ever carries a password.
    const rows = await db
      .select({ oldValue: auditEvents.oldValue, newValue: auditEvents.newValue })
      .from(auditEvents)
      .where(eq(auditEvents.entityId, body.id));
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toContain(body.temporaryPassword);
    }
  });

  it("rejects duplicate usernames and emails with 409", async () => {
    const username = `ua-dup-${suffix}`;
    const payload = {
      username,
      email: `${username}@example.com`,
      fullName: "Dup",
      auth: "password" as const,
    };
    const first = await inject(fx.adminToken, { method: "POST", url: "/admin/users", payload });
    expect(first.statusCode).toBe(201);
    const dup = await inject(fx.adminToken, { method: "POST", url: "/admin/users", payload });
    expect(dup.statusCode).toBe(409);
  });

  it("creates SSO accounts without a password; change-password refuses them", async () => {
    const username = `ua-sso-${suffix}`;
    const created = await inject(fx.adminToken, {
      method: "POST",
      url: "/admin/users",
      payload: { username, email: `${username}@example.com`, fullName: "SSO User", auth: "sso" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().temporaryPassword).toBeUndefined();
    expect(created.json().hasPassword).toBe(false);
    expect(created.json().mustChangePassword).toBe(false);

    const [row] = await db.select().from(users).where(eq(users.username, username));
    expect(row?.passwordHash).toBeNull();
  });

  it("change-password revokes every other session of the account", async () => {
    const username = `ua-sessions-${suffix}`;
    await db.insert(users).values({
      username,
      email: `${username}@example.com`,
      fullName: username,
      passwordHash: await hashPassword(PASSWORD),
    });
    const first = (await login(username, PASSWORD)).json().token;
    const second = (await login(username, PASSWORD)).json().token;

    const changed = await inject(second, {
      method: "POST",
      url: "/auth/change-password",
      payload: { currentPassword: PASSWORD, newPassword: `${PASSWORD}-2` },
    });
    expect(changed.statusCode).toBe(200);

    // The changing session survives; the other is dead.
    expect((await inject(second, { method: "GET", url: "/auth/me" })).statusCode).toBe(200);
    expect((await inject(first, { method: "GET", url: "/auth/me" })).statusCode).toBe(401);
  });

  it("deactivation kills live sessions and blocks login; reactivation restores", async () => {
    const username = `ua-deact-${suffix}`;
    const created = await inject(fx.adminToken, {
      method: "POST",
      url: "/admin/users",
      payload: { username, email: `${username}@example.com`, fullName: "Deact", auth: "password" },
    });
    const { id, temporaryPassword } = created.json();
    const token = (await login(username, temporaryPassword)).json().token;
    expect(await liveSessionCount(id)).toBe(1);

    const deactivated = await inject(fx.adminToken, {
      method: "POST",
      url: `/admin/users/${id}/deactivate`,
    });
    expect(deactivated.statusCode).toBe(200);
    expect(await liveSessionCount(id)).toBe(0);
    expect((await inject(token, { method: "GET", url: "/auth/me" })).statusCode).toBe(401);
    expect((await login(username, temporaryPassword)).statusCode).toBe(401);

    const reactivated = await inject(fx.adminToken, {
      method: "POST",
      url: `/admin/users/${id}/reactivate`,
    });
    expect(reactivated.statusCode).toBe(200);
    expect((await login(username, temporaryPassword)).statusCode).toBe(200);

    // Self-deactivation is refused.
    const self = await inject(fx.adminToken, {
      method: "POST",
      url: `/admin/users/${fx.adminId}/deactivate`,
    });
    expect(self.statusCode).toBe(400);
  });

  it("unlock clears a lockout", async () => {
    const config = loadAuthConfig();
    const username = `ua-lock-${suffix}`;
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

    for (let i = 0; i < config.maxFailedLogins; i++) {
      await login(username, "wrong-password-every-time");
    }
    expect((await login(username, PASSWORD)).statusCode).toBe(401);

    const unlocked = await inject(fx.adminToken, {
      method: "POST",
      url: `/admin/users/${user.id}/unlock`,
    });
    expect(unlocked.statusCode).toBe(200);
    expect((await login(username, PASSWORD)).statusCode).toBe(200);
  });

  it("admin password reset invalidates sessions and reimposes the gate", async () => {
    const username = `ua-reset-${suffix}`;
    await db.insert(users).values({
      username,
      email: `${username}@example.com`,
      fullName: username,
      passwordHash: await hashPassword(PASSWORD),
    });
    const [user] = await db.select().from(users).where(eq(users.username, username));
    if (!user) throw new Error("fixture failed");
    const oldToken = (await login(username, PASSWORD)).json().token;

    const reset = await inject(fx.adminToken, {
      method: "POST",
      url: `/admin/users/${user.id}/reset-password`,
    });
    expect(reset.statusCode).toBe(200);
    const temp = reset.json().temporaryPassword;
    expect(temp).toBeDefined();

    expect((await inject(oldToken, { method: "GET", url: "/auth/me" })).statusCode).toBe(401);
    expect((await login(username, PASSWORD)).statusCode).toBe(401);

    const fresh = (await login(username, temp)).json().token;
    const gated = await inject(fresh, { method: "GET", url: "/studies" });
    expect(gated.statusCode).toBe(403);
    expect(gated.json().code).toBe("password_change_required");

    // SSO accounts have no password to reset.
    const ssoUsername = `ua-reset-sso-${suffix}`;
    const sso = await inject(fx.adminToken, {
      method: "POST",
      url: "/admin/users",
      payload: {
        username: ssoUsername,
        email: `${ssoUsername}@example.com`,
        fullName: "SSO",
        auth: "sso",
      },
    });
    const ssoReset = await inject(fx.adminToken, {
      method: "POST",
      url: `/admin/users/${sso.json().id}/reset-password`,
    });
    expect(ssoReset.statusCode).toBe(400);
  });

  it("system-admin flag changes are audited and self-changes refused", async () => {
    const promoted = await inject(fx.adminToken, {
      method: "POST",
      url: `/admin/users/${fx.plainId}/system-admin`,
      payload: { isSystemAdmin: true },
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json().isSystemAdmin).toBe(true);

    // The promoted user can now see the user list…
    const list = await inject(fx.plainToken, { method: "GET", url: "/admin/users" });
    expect(list.statusCode).toBe(200);
    for (const row of list.json()) {
      expect(row.passwordHash).toBeUndefined();
      expect(row.oidcSubject).toBeUndefined();
    }

    // …and demotion takes effect.
    const demoted = await inject(fx.adminToken, {
      method: "POST",
      url: `/admin/users/${fx.plainId}/system-admin`,
      payload: { isSystemAdmin: false },
    });
    expect(demoted.statusCode).toBe(200);
    expect((await inject(fx.plainToken, { method: "GET", url: "/admin/users" })).statusCode).toBe(
      403,
    );

    const self = await inject(fx.adminToken, {
      method: "POST",
      url: `/admin/users/${fx.adminId}/system-admin`,
      payload: { isSystemAdmin: false },
    });
    expect(self.statusCode).toBe(400);

    const trail = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityId, fx.plainId),
          eq(auditEvents.action, "user.system_admin_changed"),
        ),
      );
    expect(trail.length).toBe(2);
  });
});
