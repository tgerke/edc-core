import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password.js";
import { createDb, databaseUrl } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { accessLog, auditEvents, sessions, users } from "../db/schema/index.js";
import { buildServer, parseTrustProxy } from "../server.js";

const { db, client } = createDb();
let dbAvailable = false;
try {
  await client`SELECT 1`;
  dbAvailable = true;
} catch {
  if (process.env.CI) throw new Error(`CI requires a reachable database at ${databaseUrl()}`);
  console.warn(`⚠ Skipping trust-proxy tests: no database at ${databaseUrl()}.`);
}

const PASSWORD = "correct-Horse-battery-7";
const UA = "trust-proxy-test/1.0";

// Access-log rows land in onResponse, after the response is dispatched.
async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result !== undefined) return result;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("parseTrustProxy", () => {
  it("maps env values to Fastify trustProxy settings", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("1")).toBe(true);
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy("2")).toBe(2);
    expect(parseTrustProxy("10.0.0.0/8, 127.0.0.1")).toBe("10.0.0.0/8, 127.0.0.1");
  });
});

describe.skipIf(!dbAvailable)("EDC_TRUST_PROXY (integration)", () => {
  // Two servers over the same database: one trusts X-Forwarded-For, one
  // (the default) does not.
  let trusting: FastifyInstance;
  let untrusting: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  let username = "";

  async function login(
    server: FastifyInstance,
    opts: { xff?: string } = {},
  ): Promise<{ token: string; sessionId: string }> {
    const response = await server.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username, password: PASSWORD },
      remoteAddress: "127.0.0.1",
      headers: {
        "user-agent": UA,
        ...(opts.xff ? { "x-forwarded-for": opts.xff } : {}),
      },
    });
    expect(response.statusCode).toBe(200);
    const token = response.json().token as string;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const [row] = await db.select().from(sessions).where(eq(sessions.tokenHash, tokenHash));
    if (!row) throw new Error("session not found");
    return { token, sessionId: row.id };
  }

  function me(server: FastifyInstance, token: string, opts: { xff?: string } = {}) {
    return server.inject({
      method: "GET",
      url: "/auth/me",
      remoteAddress: "127.0.0.1",
      headers: {
        authorization: `Bearer ${token}`,
        "user-agent": UA,
        ...(opts.xff ? { "x-forwarded-for": opts.xff } : {}),
      },
    });
  }

  async function sessionIp(sessionId: string) {
    const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    return row?.ip;
  }

  async function ipChangeEvents(sessionId: string) {
    return db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.action, "auth.session_ip_changed"), eq(auditEvents.entityId, sessionId)),
      );
  }

  beforeAll(async () => {
    await runMigrations();
    trusting = await buildServer({ db, trustProxy: true });
    untrusting = await buildServer({ db });
    await Promise.all([trusting.ready(), untrusting.ready()]);

    username = `tp-user-${suffix}`;
    await db.insert(users).values({
      username,
      email: `${username}@example.com`,
      fullName: username,
      passwordHash: await hashPassword(PASSWORD),
    });
  });

  afterAll(async () => {
    await trusting.close();
    await untrusting.close();
    await client.end();
  });

  it("without the knob, a forged X-Forwarded-For is ignored everywhere", async () => {
    const { token, sessionId } = await login(untrusting, { xff: "203.0.113.7" });
    expect(await sessionIp(sessionId)).toBe("127.0.0.1");

    const response = await me(untrusting, token, { xff: "203.0.113.99" });
    expect(response.statusCode).toBe(200);
    expect(await sessionIp(sessionId)).toBe("127.0.0.1");
    expect(await ipChangeEvents(sessionId)).toHaveLength(0);

    const row = await waitFor(async () => {
      const rows = await db
        .select()
        .from(accessLog)
        .where(and(eq(accessLog.sessionId, sessionId), eq(accessLog.path, "/auth/me")))
        .orderBy(desc(accessLog.id))
        .limit(1);
      return rows[0];
    });
    expect(row.ip).toBe("127.0.0.1");
  });

  it("with the knob, the forwarded client address reaches session, audit, and access log", async () => {
    const { token, sessionId } = await login(trusting, { xff: "203.0.113.7" });
    expect(await sessionIp(sessionId)).toBe("203.0.113.7");

    // Roaming client: new forwarded address is recorded, not fatal.
    const response = await me(trusting, token, { xff: "203.0.113.8" });
    expect(response.statusCode).toBe(200);
    expect(await sessionIp(sessionId)).toBe("203.0.113.8");

    const events = await ipChangeEvents(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]?.oldValue).toMatchObject({ ip: "203.0.113.7" });
    expect(events[0]?.newValue).toMatchObject({ ip: "203.0.113.8" });

    const row = await waitFor(async () => {
      const rows = await db
        .select()
        .from(accessLog)
        .where(and(eq(accessLog.sessionId, sessionId), eq(accessLog.ip, "203.0.113.8")))
        .limit(1);
      return rows[0];
    });
    expect(row.path).toBe("/auth/me");
  });
});
