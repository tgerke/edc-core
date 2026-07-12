import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthConfig } from "../auth/config.js";
import { hashPassword } from "../auth/password.js";
import { createDb, databaseUrl } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import {
  accessLog,
  auditEvents,
  notifications,
  securityAnomalies,
  users,
} from "../db/schema/index.js";
import { buildServer } from "../server.js";
import { type AnomalyConfig, scanSecurityAnomalies } from "../services/security-anomalies.js";

const { db, client } = createDb();
let dbAvailable = false;
try {
  await client`SELECT 1`;
  dbAvailable = true;
} catch {
  if (process.env.CI) throw new Error(`CI requires a reachable database at ${databaseUrl()}`);
  console.warn(`⚠ Skipping security anomaly tests: no database at ${databaseUrl()}.`);
}

const PASSWORD = "correct-Horse-battery-7";
const UA = "edc-test-browser/1.0";

const authConfig: AuthConfig = {
  passwordMinLength: 12,
  maxFailedLogins: 3,
  lockoutMinutes: 15,
  sessionIdleMinutes: 30,
  sessionAbsoluteHours: 8,
  oidc: null,
  oidcOnly: false,
};

const anomalyConfig: AnomalyConfig = { failedLoginThreshold: 5, windowMinutes: 15 };

// Per-run source addresses isolate burst assertions from parallel suites and
// from rows accumulated in the shared dev database (see access-log.test.ts).
function randomIp(): string {
  return `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${
    Math.floor(Math.random() * 250) + 1
  }`;
}

// Access-log rows land in onResponse, after inject resolves — poll.
async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result !== undefined) return result;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(!dbAvailable)("security anomalies (integration)", () => {
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

  beforeAll(async () => {
    await runMigrations();
    server = await buildServer({ db, authConfig });
    await server.ready();

    const admin = await mkUser(`sa-admin-${suffix}`, true);
    const plain = await mkUser(`sa-plain-${suffix}`, false);
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

  describe("failed-login burst detection", () => {
    it("materialises one anomaly for a burst of 401s from a single address", async () => {
      const ip = randomIp();
      for (let i = 0; i < anomalyConfig.failedLoginThreshold; i++) {
        const response = await server.inject({
          method: "GET",
          url: "/auth/me",
          headers: { authorization: "Bearer not-a-real-token", "user-agent": UA },
          remoteAddress: ip,
        });
        expect(response.statusCode).toBe(401);
      }

      const created = await waitFor(async () => {
        const count = await scanSecurityAnomalies(db, anomalyConfig, { ip });
        return count > 0 ? count : undefined;
      });
      expect(created).toBe(1);

      const [anomaly] = await db
        .select()
        .from(securityAnomalies)
        .where(and(eq(securityAnomalies.kind, "failed_login_burst"), eq(securityAnomalies.ip, ip)));
      expect(anomaly).toBeDefined();
      expect(anomaly?.severity).toBe("critical");
      expect(anomaly?.summary).toContain(ip);
      expect(anomaly?.acknowledgedAt).toBeNull();

      // Re-scan is a no-op: the dedupe key already exists.
      expect(await scanSecurityAnomalies(db, anomalyConfig, { ip })).toBe(0);
    });

    it("stays quiet below the threshold", async () => {
      const ip = randomIp();
      for (let i = 0; i < anomalyConfig.failedLoginThreshold - 1; i++) {
        await server.inject({
          method: "GET",
          url: "/auth/me",
          headers: { authorization: "Bearer not-a-real-token", "user-agent": UA },
          remoteAddress: ip,
        });
      }
      // Wait until every 401 row is visible so the scan sees all of them.
      await waitFor(async () => {
        const rows = await db.select().from(accessLog).where(eq(accessLog.ip, ip));
        return rows.length === anomalyConfig.failedLoginThreshold - 1 ? true : undefined;
      });
      expect(await scanSecurityAnomalies(db, anomalyConfig, { ip })).toBe(0);
    });
  });

  describe("audit-driven detection", () => {
    it("reports a lockout and notifies system administrators once", async () => {
      const victim = await mkUser(`sa-victim-${suffix}`, false);
      for (let i = 0; i < authConfig.maxFailedLogins; i++) {
        await server.inject({
          method: "POST",
          url: "/auth/login",
          payload: { username: victim.username, password: "wrong-Password-99" },
          headers: { "user-agent": UA },
        });
      }

      expect(await scanSecurityAnomalies(db, anomalyConfig, { userId: victim.id })).toBe(1);
      const [anomaly] = await db
        .select()
        .from(securityAnomalies)
        .where(and(eq(securityAnomalies.kind, "lockout"), eq(securityAnomalies.userId, victim.id)));
      expect(anomaly).toBeDefined();
      expect(anomaly?.severity).toBe("warning");
      expect(anomaly?.summary).toContain(victim.username);

      // Fan-out to the system admin, with the anomaly id as dedupe key.
      const rows = await db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, fx.adminId),
            eq(notifications.type, "security.anomaly"),
            eq(notifications.dedupeKey, anomaly?.id ?? ""),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.studyId).toBeNull();

      // Re-scan: same audit event, no second anomaly or notification.
      expect(await scanSecurityAnomalies(db, anomalyConfig, { userId: victim.id })).toBe(0);
    });

    it("reports a session presented by a different client", async () => {
      const token = await login(fx.plainUsername, { userAgent: "binding-browser/1.0" });
      const response = await server.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${token}`, "user-agent": "other-browser/2.0" },
      });
      expect(response.statusCode).toBe(401);

      expect(await scanSecurityAnomalies(db, anomalyConfig, { userId: fx.plainId })).toBe(1);
      const [anomaly] = await db
        .select()
        .from(securityAnomalies)
        .where(
          and(
            eq(securityAnomalies.kind, "session_binding_violation"),
            eq(securityAnomalies.userId, fx.plainId),
          ),
        )
        .orderBy(desc(securityAnomalies.detectedAt))
        .limit(1);
      expect(anomaly?.severity).toBe("critical");
      expect(anomaly?.summary).toContain(fx.plainUsername);
    });
  });

  describe("review surface", () => {
    it("lists anomalies for system admins and hides them from others", async () => {
      const denied = await server.inject({
        method: "GET",
        url: "/admin/security-anomalies",
        headers: { authorization: `Bearer ${fx.plainToken}`, "user-agent": UA },
      });
      expect(denied.statusCode).toBe(403);

      const allowed = await server.inject({
        method: "GET",
        url: "/admin/security-anomalies?status=open",
        headers: { authorization: `Bearer ${fx.adminToken}`, "user-agent": UA },
      });
      expect(allowed.statusCode).toBe(200);
      const page = allowed.json();
      expect(page.total).toBeGreaterThan(0);
      expect(page.entries[0]).toHaveProperty("kind");
      expect(page.entries[0]).toHaveProperty("summary");
    });

    it("exports CSV", async () => {
      const response = await server.inject({
        method: "GET",
        url: "/admin/security-anomalies?format=csv",
        headers: { authorization: `Bearer ${fx.adminToken}`, "user-agent": UA },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/csv");
      expect(response.body.split("\n")[0]).toContain("detected_at,kind,severity");
    });

    it("acknowledges an anomaly, audits it, and rejects a second acknowledgement", async () => {
      const ip = randomIp();
      await db.insert(securityAnomalies).values({
        kind: "failed_login_burst",
        severity: "critical",
        ip,
        summary: `fixture burst from ${ip}`,
        details: {},
        dedupeKey: `test:${randomUUID()}`,
      });
      const [anomaly] = await db
        .select()
        .from(securityAnomalies)
        .where(eq(securityAnomalies.ip, ip));
      if (!anomaly) throw new Error("fixture failed");

      const denied = await server.inject({
        method: "POST",
        url: `/admin/security-anomalies/${anomaly.id}/acknowledge`,
        payload: { note: "reviewed" },
        headers: { authorization: `Bearer ${fx.plainToken}`, "user-agent": UA },
      });
      expect(denied.statusCode).toBe(403);

      const first = await server.inject({
        method: "POST",
        url: `/admin/security-anomalies/${anomaly.id}/acknowledge`,
        payload: { note: "blocked at the firewall" },
        headers: { authorization: `Bearer ${fx.adminToken}`, "user-agent": UA },
      });
      expect(first.statusCode).toBe(200);

      const [updated] = await db
        .select()
        .from(securityAnomalies)
        .where(eq(securityAnomalies.id, anomaly.id));
      expect(updated?.acknowledgedAt).not.toBeNull();
      expect(updated?.acknowledgedBy).toBe(fx.adminId);
      expect(updated?.acknowledgedNote).toBe("blocked at the firewall");

      const [audit] = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, "security.anomaly_acknowledged"),
            eq(auditEvents.entityId, anomaly.id),
          ),
        );
      expect(audit).toBeDefined();
      expect(audit?.actorId).toBe(fx.adminId);
      expect(audit?.reason).toBe("blocked at the firewall");

      const second = await server.inject({
        method: "POST",
        url: `/admin/security-anomalies/${anomaly.id}/acknowledge`,
        payload: {},
        headers: { authorization: `Bearer ${fx.adminToken}`, "user-agent": UA },
      });
      expect(second.statusCode).toBe(409);

      const missing = await server.inject({
        method: "POST",
        url: `/admin/security-anomalies/${randomUUID()}/acknowledge`,
        payload: {},
        headers: { authorization: `Bearer ${fx.adminToken}`, "user-agent": UA },
      });
      expect(missing.statusCode).toBe(404);
    });
  });
});
