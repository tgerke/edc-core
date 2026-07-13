import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAuthConfig } from "../auth/config.js";
import { hashPassword } from "../auth/password.js";
import { createDb, databaseUrl } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { accessLog, auditEvents, sessions, users } from "../db/schema/index.js";
import { buildServer } from "../server.js";

const { db, client } = createDb();
let dbAvailable = false;
try {
  await client`SELECT 1`;
  dbAvailable = true;
} catch {
  if (process.env.CI) throw new Error(`CI requires a reachable database at ${databaseUrl()}`);
  console.warn(`⚠ Skipping access log tests: no database at ${databaseUrl()}.`);
}

const PASSWORD = "correct-Horse-battery-7";
const UA = "edc-test-browser/1.0";

// The log row is written in onResponse, after the response has been
// dispatched — poll instead of asserting immediately.
async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result !== undefined) return result;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(!dbAvailable)("access log & session binding (integration)", () => {
  let server: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const fx = { adminId: "", adminToken: "", plainId: "", plainToken: "", plainUsername: "" };

  async function mkUser(username: string, isSystemAdmin: boolean) {
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
    return user;
  }

  async function login(username: string, opts: { userAgent?: string; ip?: string } = {}) {
    const response = await server.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username, password: PASSWORD },
      headers: { "user-agent": opts.userAgent ?? UA },
      ...(opts.ip ? { remoteAddress: opts.ip } : {}),
    });
    expect(response.statusCode).toBe(200);
    return response.json().token as string;
  }

  function inject(opts: {
    method?: "GET" | "POST";
    url: string;
    token?: string;
    userAgent?: string;
    ip?: string;
  }) {
    return server.inject({
      method: opts.method ?? "GET",
      url: opts.url,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        "user-agent": opts.userAgent ?? UA,
      },
      ...(opts.ip ? { remoteAddress: opts.ip } : {}),
    });
  }

  async function sessionFor(token: string) {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const [row] = await db.select().from(sessions).where(eq(sessions.tokenHash, tokenHash));
    return row;
  }

  beforeAll(async () => {
    await runMigrations();
    server = await buildServer({ db });
    await server.ready();

    const admin = await mkUser(`al-admin-${suffix}`, true);
    const plain = await mkUser(`al-plain-${suffix}`, false);
    fx.adminId = admin.id;
    fx.plainId = plain.id;
    fx.plainUsername = plain.username;
    fx.adminToken = await login(admin.username);
    fx.plainToken = await login(plain.username);
  });

  afterAll(async () => {
    await server.close();
    await client.end();
  });

  describe("structured access logging", () => {
    it("records authenticated requests with user, session, route, and status", async () => {
      const response = await inject({ url: "/auth/me", token: fx.plainToken });
      expect(response.statusCode).toBe(200);

      const row = await waitFor(async () => {
        const rows = await db
          .select()
          .from(accessLog)
          .where(and(eq(accessLog.userId, fx.plainId), eq(accessLog.path, "/auth/me")))
          .orderBy(desc(accessLog.id))
          .limit(1);
        return rows[0];
      });
      expect(row.method).toBe("GET");
      expect(row.statusCode).toBe(200);
      expect(row.route).toBe("/auth/me");
      expect(row.userAgent).toBe(UA);
      expect(row.sessionId).toBeTruthy();
      expect(row.ip).toBeTruthy();
    });

    it("records unauthenticated requests without a user", async () => {
      const path = `/no-such-route-${suffix}`;
      const response = await inject({ url: path });
      expect(response.statusCode).toBe(404);

      const row = await waitFor(async () => {
        const rows = await db.select().from(accessLog).where(eq(accessLog.path, path)).limit(1);
        return rows[0];
      });
      expect(row.userId).toBeNull();
      expect(row.sessionId).toBeNull();
      expect(row.statusCode).toBe(404);
    });

    it("does not log health probes", async () => {
      // A per-run source address isolates this test from parallel suites and
      // from rows accumulated in the shared dev database by earlier runs.
      const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${
        Math.floor(Math.random() * 250) + 1
      }`;
      const health = await inject({ url: "/health", ip });
      expect(health.statusCode).toBe(200);
      const marker = await inject({ url: `/after-health-${suffix}`, ip });
      expect(marker.statusCode).toBe(404);

      // Once the later request's row is visible, the health row would be too.
      await waitFor(async () => {
        const rows = await db
          .select()
          .from(accessLog)
          .where(and(eq(accessLog.path, `/after-health-${suffix}`), eq(accessLog.ip, ip)));
        return rows[0];
      });
      const healthRows = await db
        .select()
        .from(accessLog)
        .where(and(eq(accessLog.ip, ip), eq(accessLog.path, "/health")));
      expect(healthRows).toHaveLength(0);
    });
  });

  describe("session binding (P11-14 device check)", () => {
    it("revokes and audits a session presented by a different user-agent", async () => {
      const token = await login(fx.plainUsername, { userAgent: "binding-browser/1.0" });
      const session = await sessionFor(token);
      expect(session?.userAgent).toBe("binding-browser/1.0");

      const hijacked = await inject({
        url: "/auth/me",
        token,
        userAgent: "different-browser/2.0",
      });
      expect(hijacked.statusCode).toBe(401);

      const revoked = await sessionFor(token);
      expect(revoked?.revokedAt).not.toBeNull();

      // Revocation is permanent: the original client is out too.
      const original = await inject({ url: "/auth/me", token, userAgent: "binding-browser/1.0" });
      expect(original.statusCode).toBe(401);

      const [event] = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, "auth.session_binding_violation"),
            eq(auditEvents.entityId, session?.id ?? ""),
          ),
        );
      expect(event).toBeDefined();
      expect(event?.actorId).toBe(fx.plainId);
      expect(event?.oldValue).toMatchObject({ userAgent: "binding-browser/1.0" });
      expect(event?.newValue).toMatchObject({ userAgent: "different-browser/2.0" });
    });

    it("treats a missing user-agent as a binding violation", async () => {
      const token = await login(fx.plainUsername, { userAgent: "strict-browser/1.0" });
      const response = await server.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(401);
    });

    it("skips the check for sessions issued without a user-agent", async () => {
      // Pre-binding sessions have no stored user-agent; they must not be
      // locked out by the upgrade.
      const raw = randomBytes(32).toString("base64url");
      await db.insert(sessions).values({
        userId: fx.plainId,
        tokenHash: createHash("sha256").update(raw).digest("hex"),
        authMethod: "password",
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      const response = await inject({ url: "/auth/me", token: raw, userAgent: "any-browser/9.9" });
      expect(response.statusCode).toBe(200);
    });

    it("audits an IP change without ending the session", async () => {
      const token = await login(fx.plainUsername, { ip: "10.1.1.1" });
      const session = await sessionFor(token);
      expect(session?.ip).toBe("10.1.1.1");

      const roamed = await inject({ url: "/auth/me", token, ip: "10.2.2.2" });
      expect(roamed.statusCode).toBe(200);

      const updated = await sessionFor(token);
      expect(updated?.ip).toBe("10.2.2.2");
      expect(updated?.revokedAt).toBeNull();

      const [event] = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, "auth.session_ip_changed"),
            eq(auditEvents.entityId, session?.id ?? ""),
          ),
        );
      expect(event?.oldValue).toMatchObject({ ip: "10.1.1.1" });
      expect(event?.newValue).toMatchObject({ ip: "10.2.2.2" });
    });

    it("EDC_SESSION_UA_STRICT=0 downgrades a UA mismatch to audit-and-rebind (#69)", async () => {
      // Same db, second server with the kill-switch off (trust-proxy pattern).
      const lax = await buildServer({
        db,
        authConfig: { ...loadAuthConfig(), sessionUaStrict: false },
      });
      await lax.ready();
      try {
        const loginRes = await lax.inject({
          method: "POST",
          url: "/auth/login",
          payload: { username: fx.plainUsername, password: PASSWORD },
          headers: { "user-agent": "managed-browser/1.0" },
        });
        expect(loginRes.statusCode).toBe(200);
        const token = loginRes.json().token as string;
        const session = await sessionFor(token);

        const roamed = await lax.inject({
          method: "GET",
          url: "/auth/me",
          headers: { authorization: `Bearer ${token}`, "user-agent": "managed-browser/2.0" },
        });
        expect(roamed.statusCode).toBe(200);

        // Rebound once, not revoked; the violation is still audited.
        const updated = await sessionFor(token);
        expect(updated?.revokedAt).toBeNull();
        expect(updated?.userAgent).toBe("managed-browser/2.0");

        const again = await lax.inject({
          method: "GET",
          url: "/auth/me",
          headers: { authorization: `Bearer ${token}`, "user-agent": "managed-browser/2.0" },
        });
        expect(again.statusCode).toBe(200);

        const events = await db
          .select()
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.action, "auth.session_binding_violation"),
              eq(auditEvents.entityId, session?.id ?? ""),
            ),
          );
        expect(events).toHaveLength(1);
        expect(events[0]?.oldValue).toMatchObject({ userAgent: "managed-browser/1.0" });
        expect(events[0]?.newValue).toMatchObject({
          userAgent: "managed-browser/2.0",
          enforced: false,
        });
      } finally {
        await lax.close();
      }
    });
  });

  describe("GET /admin/access-log", () => {
    it("requires a system administrator", async () => {
      const anon = await inject({ url: "/admin/access-log" });
      expect(anon.statusCode).toBe(401);
      const plain = await inject({ url: "/admin/access-log", token: fx.plainToken });
      expect(plain.statusCode).toBe(403);
    });

    it("filters by user and returns entries with a total", async () => {
      await inject({ url: "/auth/me", token: fx.plainToken });
      const body = await waitFor(async () => {
        const response = await inject({
          url: `/admin/access-log?user=${fx.plainUsername}`,
          token: fx.adminToken,
        });
        expect(response.statusCode).toBe(200);
        const json = response.json();
        return json.entries.length > 0 ? json : undefined;
      });
      expect(body.total).toBeGreaterThan(0);
      for (const entry of body.entries) {
        expect(entry.user).toBe(fx.plainUsername);
      }
    });

    it("filters by status and path prefix", async () => {
      const path = `/status-filter-${suffix}`;
      await inject({ url: path, token: fx.plainToken });
      const body = await waitFor(async () => {
        const response = await inject({
          url: `/admin/access-log?status=404&path=${path}`,
          token: fx.adminToken,
        });
        const json = response.json();
        return json.entries.length > 0 ? json : undefined;
      });
      expect(body.entries[0].statusCode).toBe(404);
      expect(body.entries[0].path).toBe(path);
    });

    it("exports CSV", async () => {
      const response = await inject({
        url: `/admin/access-log?user=${fx.plainUsername}&format=csv`,
        token: fx.adminToken,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/csv");
      expect(response.body.split("\n")[0]).toBe(
        "occurred_at,user,method,path,status,ip,user_agent,session_id,duration_ms",
      );
    });

    it("rejects invalid filters", async () => {
      const response = await inject({
        url: "/admin/access-log?status=notanumber",
        token: fx.adminToken,
      });
      expect(response.statusCode).toBe(400);
    });
  });
});
