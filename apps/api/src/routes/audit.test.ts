import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password.js";
import { grantRole } from "../auth/rbac.js";
import { createDb, databaseUrl } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { roles, sites, studies, users } from "../db/schema/index.js";
import { buildServer } from "../server.js";

const { db, client } = createDb();
let dbAvailable = false;
try {
  await client`SELECT 1`;
  dbAvailable = true;
} catch {
  if (process.env.CI) throw new Error(`CI requires a reachable database at ${databaseUrl()}`);
  console.warn(`⚠ Skipping audit review tests: no database at ${databaseUrl()}.`);
}

const PASSWORD = "correct-Horse-battery-7";

describe.skipIf(!dbAvailable)("audit trail review", () => {
  let server: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const fx = { studyId: "", dmToken: "", entryToken: "", subjectId: "" };

  async function makeUser(name: string, roleName: string, studyId: string) {
    const [user] = await db
      .insert(users)
      .values({
        username: `${name}-${suffix}`,
        email: `${name}-${suffix}@example.com`,
        fullName: name,
        passwordHash: await hashPassword(PASSWORD),
      })
      .returning();
    const [role] = await db.select().from(roles).where(eq(roles.name, roleName));
    if (!user || !role) throw new Error("fixture failed");
    await grantRole(db, { userId: user.id, studyId, roleId: role.id, grantedBy: user.id });
    const token = (
      await server.inject({
        method: "POST",
        url: "/auth/login",
        payload: { username: `${name}-${suffix}`, password: PASSWORD },
      })
    ).json().token;
    return { user, token };
  }

  beforeAll(async () => {
    await runMigrations();
    server = await buildServer({ db });
    await server.ready();

    const [study] = await db
      .insert(studies)
      .values({ oid: `ST.AUD.${suffix}`, name: "Audit Study" })
      .returning();
    if (!study) throw new Error("fixture failed");
    fx.studyId = study.id;
    const [site] = await db
      .insert(sites)
      .values({ studyId: study.id, oid: "SITE.1", name: "Site" })
      .returning();
    if (!site) throw new Error("fixture failed");

    const dm = await makeUser("dm", "data_manager", study.id);
    const entry = await makeUser("de", "data_entry", study.id);
    fx.dmToken = dm.token;
    fx.entryToken = entry.token;

    // Generate study-scoped events: an enrollment by the entry user.
    const subject = (
      await server.inject({
        method: "POST",
        url: `/studies/${study.id}/subjects`,
        payload: { siteId: site.id, subjectKey: "A-001" },
        headers: { authorization: `Bearer ${fx.entryToken}` },
      })
    ).json();
    fx.subjectId = subject.id;
  });

  afterAll(async () => {
    await server.close();
    await client.end();
  });

  function get(url: string, token = fx.dmToken) {
    return server.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  }

  it("requires audit.review", async () => {
    const denied = await get(`/studies/${fx.studyId}/audit`, fx.entryToken);
    expect(denied.statusCode).toBe(403);
  });

  it("lists study events newest-first with actor attribution and facets", async () => {
    const res = await get(`/studies/${fx.studyId}/audit`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBeGreaterThanOrEqual(3); // 2 role grants + enrollment
    const enrollment = body.events.find((e: { action: string }) => e.action === "subject.enrolled");
    expect(enrollment.actor).toBe(`de-${suffix}`);
    expect(enrollment.entityId).toBe(fx.subjectId);
    expect(body.facets.actions).toContain("subject.enrolled");
    expect(body.facets.actions).toContain("rbac.role_granted");
  });

  it("filters by action, actor, and entityType", async () => {
    const byAction = await get(`/studies/${fx.studyId}/audit?action=subject.enrolled`);
    expect(byAction.json().events).toHaveLength(1);

    const byActor = await get(`/studies/${fx.studyId}/audit?actor=de-${suffix}`);
    expect(byActor.json().events.every((e: { actor: string }) => e.actor === `de-${suffix}`)).toBe(
      true,
    );

    const byEntity = await get(`/studies/${fx.studyId}/audit?entityType=user_study_role`);
    expect(byEntity.json().events).toHaveLength(2);
  });

  it("paginates", async () => {
    const page = await get(`/studies/${fx.studyId}/audit?limit=1&offset=0`);
    expect(page.json().events).toHaveLength(1);
    const next = await get(`/studies/${fx.studyId}/audit?limit=1&offset=1`);
    expect(next.json().events[0].id).not.toBe(page.json().events[0].id);
  });

  it("exports CSV with attachment headers", async () => {
    const res = await get(`/studies/${fx.studyId}/audit?format=csv`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("attachment");
    const [header, ...lines] = res.body.split("\n");
    expect(header).toBe(
      "occurred_at,actor,actor_name,action,entity_type,entity_id,old_value,new_value,reason",
    );
    expect(lines.some((line) => line.includes("subject.enrolled"))).toBe(true);
  });
});
