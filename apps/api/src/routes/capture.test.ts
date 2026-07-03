import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password.js";
import { grantRole } from "../auth/rbac.js";
import { createDb, databaseUrl } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { auditEvents, roles, sites, studies, users } from "../db/schema/index.js";
import { buildServer } from "../server.js";
import { importStudyBuild } from "../services/study-builds.js";

const { db, client } = createDb();
let dbAvailable = false;
try {
  await client`SELECT 1`;
  dbAvailable = true;
} catch {
  if (process.env.CI) throw new Error(`CI requires a reachable database at ${databaseUrl()}`);
  console.warn(
    `⚠ Skipping capture integration tests: no database at ${databaseUrl()}. ` +
      "Start one with: podman compose -f infra/compose.yaml up -d postgres",
  );
}

const odmFixture = readFileSync(
  path.join(
    fileURLToPath(import.meta.url),
    "../../../../../packages/odm/test/fixtures/cdisc-demographics-race.xml",
  ),
  "utf8",
);

const PASSWORD = "correct-Horse-battery-7";

describe.skipIf(!dbAvailable)("capture workflow (integration)", () => {
  let server: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const fx = {
    studyId: "",
    site1Id: "",
    site2Id: "",
    subjectId: "",
    formId: "",
    tokens: {} as Record<string, string>,
  };

  async function makeUser(name: string, roleName: string | null, siteScoped = false) {
    const [user] = await db
      .insert(users)
      .values({
        username: `${name}-${suffix}`,
        email: `${name}-${suffix}@example.com`,
        fullName: name,
        passwordHash: await hashPassword(PASSWORD),
      })
      .returning();
    if (!user) throw new Error("user fixture failed");
    if (roleName) {
      const [role] = await db.select().from(roles).where(eq(roles.name, roleName));
      if (!role) throw new Error(`seeded role ${roleName} missing`);
      await grantRole(db, {
        userId: user.id,
        studyId: fx.studyId,
        roleId: role.id,
        ...(siteScoped ? { siteId: fx.site1Id } : {}),
        grantedBy: user.id,
      });
    }
    const login = await server.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: `${name}-${suffix}`, password: PASSWORD },
    });
    fx.tokens[name] = login.json().token;
    return user.id;
  }

  function as(name: string) {
    return { authorization: `Bearer ${fx.tokens[name]}` };
  }

  beforeAll(async () => {
    await runMigrations();
    server = await buildServer({ db });
    await server.ready();

    const [study] = await db
      .insert(studies)
      .values({ oid: `ST.CAP.${suffix}`, name: "Capture Study", status: "active" })
      .returning();
    if (!study) throw new Error("study fixture failed");
    fx.studyId = study.id;
    const [site1] = await db
      .insert(sites)
      .values({ studyId: study.id, oid: "SITE.1", name: "Site One" })
      .returning();
    const [site2] = await db
      .insert(sites)
      .values({ studyId: study.id, oid: "SITE.2", name: "Site Two" })
      .returning();
    if (!site1 || !site2) throw new Error("site fixture failed");
    fx.site1Id = site1.id;
    fx.site2Id = site2.id;

    const adminId = await makeUser("dm", "data_manager"); // study.manage, data.lock…
    await makeUser("inv", "investigator", true); // site 1 only
    await makeUser("mon", "monitor");
    await makeUser("noone", null);

    const imported = await importStudyBuild(db, {
      studyId: study.id,
      content: odmFixture,
      actorId: adminId,
    });
    if (!imported.ok) throw new Error("fixture import failed");
  });

  afterAll(async () => {
    await server.close();
    await client.end();
  });

  it("enrolls a subject at the investigator's own site", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/studies/${fx.studyId}/subjects`,
      payload: { siteId: fx.site1Id, subjectKey: "001-001" },
      headers: as("inv"),
    });
    expect(res.statusCode).toBe(201);
    fx.subjectId = res.json().id;
  });

  it("rejects enrollment at a site outside the investigator's grant", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/studies/${fx.studyId}/subjects`,
      payload: { siteId: fx.site2Id, subjectKey: "002-001" },
      headers: as("inv"),
    });
    expect(res.statusCode).toBe(403);
  });

  it("creates event + form instances idempotently, pinned to the build", async () => {
    const payload = { eventOid: "SE.SCREENING", formOid: "FO.DEMOGRAPHICS" };
    const first = await server.inject({
      method: "POST",
      url: `/subjects/${fx.subjectId}/forms`,
      payload,
      headers: as("inv"),
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().status).toBe("not_started");
    fx.formId = first.json().id;

    const second = await server.inject({
      method: "POST",
      url: `/subjects/${fx.subjectId}/forms`,
      payload,
      headers: as("inv"),
    });
    expect(second.json().id).toBe(fx.formId);
  });

  it("writes values, auto-starting the form", async () => {
    const res = await server.inject({
      method: "PUT",
      url: `/forms/${fx.formId}/items`,
      payload: { itemGroupOid: "IG.DEMOGRAPHICS", itemOid: "IT.DOB", value: "1957-05-07" },
      headers: as("inv"),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().version).toBe(1);

    const form = await server.inject({
      method: "GET",
      url: `/forms/${fx.formId}`,
      headers: as("inv"),
    });
    expect(form.json().context.status).toBe("in_progress");
    expect(form.json().values).toHaveLength(1);
  });

  it("walks the workflow: complete → verify → locked, with permission checks", async () => {
    const post = (action: string, who: string) =>
      server.inject({
        method: "POST",
        url: `/forms/${fx.formId}/status`,
        payload: { action },
        headers: as(who),
      });

    // Investigator cannot verify; monitor cannot complete.
    expect((await post("verify", "inv")).statusCode).toBe(403);
    expect((await post("complete", "mon")).statusCode).toBe(403);

    expect((await post("complete", "inv")).statusCode).toBe(200);
    // Sequence check: cannot complete twice (P11-13).
    expect((await post("complete", "inv")).statusCode).toBe(409);

    expect((await post("verify", "mon")).statusCode).toBe(200);
    expect((await post("lock", "dm")).statusCode).toBe(200);
  });

  it("blocks writes on a locked form", async () => {
    const res = await server.inject({
      method: "PUT",
      url: `/forms/${fx.formId}/items`,
      payload: {
        itemGroupOid: "IG.DEMOGRAPHICS",
        itemOid: "IT.DOB",
        value: "1957-05-08",
        reasonForChange: "should not matter",
      },
      headers: as("inv"),
    });
    expect(res.statusCode).toBe(409);
  });

  it("audited every status change", async () => {
    const trail = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityType, "form_instance"),
          eq(auditEvents.entityId, fx.formId),
          eq(auditEvents.action, "form.status_changed"),
        ),
      );
    const sequence = trail.map((e) => (e.newValue as { status: string }).status);
    expect(sequence).toEqual(["in_progress", "complete", "verified", "locked"]);
  });

  it("corrections require reopen: unlock, reopen, change with reason", async () => {
    const post = (action: string, who: string) =>
      server.inject({
        method: "POST",
        url: `/forms/${fx.formId}/status`,
        payload: { action },
        headers: as(who),
      });
    expect((await post("unlock", "dm")).statusCode).toBe(200); // locked → complete
    expect((await post("reopen", "inv")).statusCode).toBe(200); // complete → in_progress

    const withoutReason = await server.inject({
      method: "PUT",
      url: `/forms/${fx.formId}/items`,
      payload: { itemGroupOid: "IG.DEMOGRAPHICS", itemOid: "IT.DOB", value: "1957-05-08" },
      headers: as("inv"),
    });
    expect(withoutReason.statusCode).toBe(400);

    const withReason = await server.inject({
      method: "PUT",
      url: `/forms/${fx.formId}/items`,
      payload: {
        itemGroupOid: "IG.DEMOGRAPHICS",
        itemOid: "IT.DOB",
        value: "1957-05-08",
        reasonForChange: "transcription error",
      },
      headers: as("inv"),
    });
    expect(withReason.statusCode).toBe(201);
    expect(withReason.json().version).toBe(2);
  });

  it("serves the subject matrix", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/studies/${fx.studyId}/matrix`,
      headers: as("dm"),
    });
    expect(res.statusCode).toBe(200);
    const matrix = res.json();
    expect(matrix.buildVersion).toBe(1);
    expect(matrix.events[0].oid).toBe("SE.SCREENING");
    expect(matrix.events[0].forms[0].oid).toBe("FO.DEMOGRAPHICS");
    const subject = matrix.subjects.find((s: { id: string }) => s.id === fx.subjectId);
    expect(subject.cells["SE.SCREENING:FO.DEMOGRAPHICS"].status).toBe("in_progress");
  });

  it("hides capture from non-members", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/studies/${fx.studyId}/matrix`,
      headers: as("noone"),
    });
    expect(res.statusCode).toBe(403);
  });
});
