import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password.js";
import { grantRole } from "../auth/rbac.js";
import { createDb, databaseUrl } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { auditEvents, roles, sites, studies, subjects, users } from "../db/schema/index.js";
import { buildServer } from "../server.js";
import { importStudyBuild } from "../services/study-builds.js";

const { db, client } = createDb();
let dbAvailable = false;
try {
  await client`SELECT 1`;
  dbAvailable = true;
} catch {
  if (process.env.CI) throw new Error(`CI requires a reachable database at ${databaseUrl()}`);
  console.warn(`⚠ Skipping subject lifecycle tests: no database at ${databaseUrl()}.`);
}

const PASSWORD = "correct-Horse-battery-7";

function odm(): string {
  return `<ODM xmlns="http://www.cdisc.org/ns/odm/v2.0"
      FileOID="LC1" FileType="Snapshot"
      ODMVersion="2.0" CreationDateTime="2026-07-12T00:00:00Z" Granularity="Metadata">
    <Study OID="ST.LC" StudyName="Lifecycle Study">
      <MetaDataVersion OID="MDV.1" Name="v1">
        <StudyEventDef OID="SE.EOS" Name="End of Study" Repeating="No" Type="Scheduled">
          <ItemGroupRef ItemGroupOID="FO.DS" Mandatory="Yes"/>
        </StudyEventDef>
        <ItemGroupDef OID="FO.DS" Name="Disposition" Type="Form" Repeating="No">
          <ItemGroupRef ItemGroupOID="IG.DS" Mandatory="Yes"/>
        </ItemGroupDef>
        <ItemGroupDef OID="IG.DS" Name="Disposition" Type="Section" Repeating="No">
          <ItemRef ItemOID="IT.DSTERM" Mandatory="No"/>
        </ItemGroupDef>
        <ItemDef OID="IT.DSTERM" Name="Disposition term" DataType="text"/>
      </MetaDataVersion>
    </Study>
  </ODM>`;
}

describe.skipIf(!dbAvailable)("subject lifecycle (integration)", () => {
  let server: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const fx = {
    studyId: "",
    siteAId: "",
    siteBId: "",
    coordAToken: "",
    coordBToken: "",
    monitorToken: "",
    subjectId: "",
  };

  function inject(
    token: string,
    opts: { method: "GET" | "POST" | "PUT"; url: string; payload?: object },
  ) {
    return server.inject({ ...opts, headers: { authorization: `Bearer ${token}` } });
  }

  function transition(subjectId: string, action: string, reason?: string, token = fx.coordAToken) {
    return inject(token, {
      method: "POST",
      url: `/subjects/${subjectId}/status`,
      payload: { action, ...(reason !== undefined ? { reason } : {}) },
    });
  }

  async function statusOf(subjectId: string) {
    const [row] = await db
      .select({ status: subjects.status })
      .from(subjects)
      .where(eq(subjects.id, subjectId));
    return row?.status;
  }

  beforeAll(async () => {
    await runMigrations();
    server = await buildServer({ db });
    await server.ready();

    const [study] = await db
      .insert(studies)
      .values({ oid: `ST.LC.${suffix}`, name: "Lifecycle Study" })
      .returning();
    if (!study) throw new Error("fixture failed");
    fx.studyId = study.id;
    const [siteA] = await db
      .insert(sites)
      .values({ studyId: study.id, oid: "SITE.A", name: "Site A" })
      .returning();
    const [siteB] = await db
      .insert(sites)
      .values({ studyId: study.id, oid: "SITE.B", name: "Site B" })
      .returning();
    if (!siteA || !siteB) throw new Error("fixture failed");
    fx.siteAId = siteA.id;
    fx.siteBId = siteB.id;

    const mkUser = async (username: string, roleName: string, siteId?: string) => {
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
        ...(siteId ? { siteId } : {}),
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

    fx.coordAToken = (await mkUser(`lc-coord-a-${suffix}`, "data_entry", siteA.id)).token;
    fx.coordBToken = (await mkUser(`lc-coord-b-${suffix}`, "data_entry", siteB.id)).token;
    fx.monitorToken = (await mkUser(`lc-monitor-${suffix}`, "monitor")).token;

    const admin = await mkUser(`lc-admin-${suffix}`, "admin");
    const build = await importStudyBuild(db, {
      studyId: study.id,
      content: odm(),
      actorId: admin.id,
    });
    if (!build.ok) throw new Error(`build import failed: ${JSON.stringify(build.issues)}`);
  });

  afterAll(async () => {
    await server.close();
    await client.end();
  });

  it("registers a subject in screening with its own audit action", async () => {
    const res = await inject(fx.coordAToken, {
      method: "POST",
      url: `/studies/${fx.studyId}/subjects`,
      payload: { siteId: fx.siteAId, subjectKey: "LC-001", status: "screening" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("screening");
    fx.subjectId = res.json().id;

    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.entityId, fx.subjectId), eq(auditEvents.action, "subject.registered")),
      );
    expect(audit).toBeDefined();

    // Plain enrollment is unchanged.
    const enrolled = await inject(fx.coordAToken, {
      method: "POST",
      url: `/studies/${fx.studyId}/subjects`,
      payload: { siteId: fx.siteAId, subjectKey: "LC-002" },
    });
    expect(enrolled.json().status).toBe("enrolled");
  });

  it("transitions are site-scoped and permission-gated", async () => {
    const wrongSite = await transition(fx.subjectId, "enroll", undefined, fx.coordBToken);
    expect(wrongSite.statusCode).toBe(403);
    const monitor = await transition(fx.subjectId, "enroll", undefined, fx.monitorToken);
    expect(monitor.statusCode).toBe(403);
  });

  it("screen failure requires a reason and is reversible via reinstate", async () => {
    const noReason = await transition(fx.subjectId, "screen_fail");
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().error).toMatch(/reason/);

    const failed = await transition(fx.subjectId, "screen_fail", "inclusion criterion 3 not met");
    expect(failed.statusCode).toBe(200);
    expect(failed.json().status).toBe("screen_failed");

    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityId, fx.subjectId),
          eq(auditEvents.action, "subject.status_changed"),
        ),
      );
    expect(audit?.oldValue).toEqual({ status: "screening" });
    expect(audit?.newValue).toEqual({ status: "screen_failed", action: "screen_fail" });
    expect(audit?.reason).toBe("inclusion criterion 3 not met");

    // Reinstate returns to screening (not enrolled) and needs a reason.
    expect((await transition(fx.subjectId, "reinstate")).statusCode).toBe(400);
    const reinstated = await transition(fx.subjectId, "reinstate", "lab value re-read in range");
    expect(reinstated.json().status).toBe("screening");
  });

  it("walks screening → enrolled → withdrawn → reinstated → completed", async () => {
    expect((await transition(fx.subjectId, "enroll")).json().status).toBe("enrolled");

    const withdrawn = await transition(fx.subjectId, "withdraw", "participant decision");
    expect(withdrawn.json().status).toBe("withdrawn");

    const reinstated = await transition(fx.subjectId, "reinstate", "withdrawn in error");
    expect(reinstated.json().status).toBe("enrolled");

    expect((await transition(fx.subjectId, "complete")).json().status).toBe("completed");
  });

  it("rejects transitions not allowed from the current status", async () => {
    // Subject is now completed: enrolling or withdrawing again conflicts.
    const enroll = await transition(fx.subjectId, "enroll");
    expect(enroll.statusCode).toBe(409);
    expect(enroll.json().error).toMatch(/cannot enroll a completed subject/);
    expect((await transition(fx.subjectId, "withdraw", "x")).statusCode).toBe(409);
    expect(await statusOf(fx.subjectId)).toBe("completed");

    const unknown = await transition(fx.subjectId, "vanish", "x");
    expect(unknown.statusCode).toBe(400);
  });

  it("statuses are disposition, not locks: data entry works after withdrawal", async () => {
    await transition(fx.subjectId, "reinstate", "resume for EOS data");
    await transition(fx.subjectId, "withdraw", "final withdrawal");
    expect(await statusOf(fx.subjectId)).toBe("withdrawn");

    const form = await inject(fx.coordAToken, {
      method: "POST",
      url: `/subjects/${fx.subjectId}/forms`,
      payload: { eventOid: "SE.EOS", formOid: "FO.DS" },
    });
    expect(form.statusCode).toBe(201);
    const write = await inject(fx.coordAToken, {
      method: "PUT",
      url: `/forms/${form.json().id}/items`,
      payload: { itemGroupOid: "IG.DS", itemOid: "IT.DSTERM", value: "WITHDRAWAL BY SUBJECT" },
    });
    expect(write.statusCode).toBe(201);
  });

  it("the subjects list and matrix carry the lifecycle status", async () => {
    const list = await inject(fx.monitorToken, {
      method: "GET",
      url: `/studies/${fx.studyId}/subjects`,
    });
    const row = list.json().find((s: { subjectKey: string }) => s.subjectKey === "LC-001");
    expect(row.status).toBe("withdrawn");

    const matrix = await inject(fx.monitorToken, {
      method: "GET",
      url: `/studies/${fx.studyId}/matrix`,
    });
    const subjectRow = matrix
      .json()
      .subjects.find((s: { subjectKey: string }) => s.subjectKey === "LC-001");
    expect(subjectRow.status).toBe("withdrawn");
  });
});
