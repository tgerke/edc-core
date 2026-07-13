import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RTSM_AGENT_ROLE } from "../auth/api-keys.js";
import { hashPassword } from "../auth/password.js";
import { grantRole } from "../auth/rbac.js";
import { createDb, databaseUrl } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import {
  auditEvents,
  itemValueVersions,
  roles,
  rtsmEvents,
  sites,
  studies,
  userStudyRoles,
  users,
} from "../db/schema/index.js";
import { buildServer } from "../server.js";
import { importStudyBuild } from "../services/study-builds.js";

const { db, client } = createDb();
let dbAvailable = false;
try {
  await client`SELECT 1`;
  dbAvailable = true;
} catch {
  if (process.env.CI) throw new Error(`CI requires a reachable database at ${databaseUrl()}`);
  console.warn(`⚠ Skipping RTSM intake tests: no database at ${databaseUrl()}.`);
}

const PASSWORD = "correct-Horse-battery-7";

/** One randomization form; IT.ARM is the blinded arm target. */
function odm(): string {
  return `<ODM xmlns="http://www.cdisc.org/ns/odm/v2.0"
      xmlns:edc="https://github.com/tgerke/edc-core/ns/odm-ext/v1"
      FileOID="RTSM1" FileType="Snapshot"
      ODMVersion="2.0" CreationDateTime="2026-07-11T00:00:00Z" Granularity="Metadata">
    <Study OID="ST.RTSMI" StudyName="RTSM Intake Study">
      <MetaDataVersion OID="MDV.1" Name="v1">
        <StudyEventDef OID="SE.RAND" Name="Randomization" Repeating="No" Type="Scheduled">
          <ItemGroupRef ItemGroupOID="FO.RAND" Mandatory="Yes"/>
        </StudyEventDef>
        <ItemGroupDef OID="FO.RAND" Name="Randomization" Type="Form" Repeating="No">
          <ItemGroupRef ItemGroupOID="IG.RAND" Mandatory="Yes"/>
        </ItemGroupDef>
        <ItemGroupDef OID="IG.RAND" Name="Assignment" Type="Section" Repeating="No">
          <ItemRef ItemOID="IT.ARM" Mandatory="No"/>
          <ItemRef ItemOID="IT.RANDDT" Mandatory="No"/>
        </ItemGroupDef>
        <ItemDef OID="IT.ARM" Name="Treatment arm" DataType="text" edc:Blinded="Yes"/>
        <ItemDef OID="IT.RANDDT" Name="Randomization date" DataType="date"/>
      </MetaDataVersion>
    </Study>
  </ODM>`;
}

const config = {
  eventOid: "SE.RAND",
  formOid: "FO.RAND",
  itemGroupOid: "IG.RAND",
  itemOid: "IT.ARM",
  enabled: true,
};

describe.skipIf(!dbAvailable)("RTSM assignment intake (integration)", () => {
  let server: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const fx = {
    studyId: "",
    otherStudyId: "",
    siteId: "",
    subjectId: "",
    adminToken: "",
    adminId: "",
    monitorToken: "",
    apiKey: "",
  };

  function inject(
    token: string,
    opts: { method: "GET" | "POST" | "PUT"; url: string; payload?: object },
  ) {
    return server.inject({ ...opts, headers: { authorization: `Bearer ${token}` } });
  }

  function postAssignment(payload: object, opts: { key?: string; studyId?: string } = {}) {
    return server.inject({
      method: "POST",
      url: `/studies/${opts.studyId ?? fx.studyId}/rtsm/assignments`,
      headers: { authorization: `Bearer ${opts.key ?? fx.apiKey}` },
      payload,
    });
  }

  async function armVersions() {
    return db
      .select({ version: itemValueVersions, event: rtsmEvents })
      .from(itemValueVersions)
      .innerJoin(rtsmEvents, eq(rtsmEvents.itemValueVersionId, itemValueVersions.id))
      .where(eq(rtsmEvents.studyId, fx.studyId));
  }

  beforeAll(async () => {
    await runMigrations();
    server = await buildServer({ db });
    await server.ready();

    const [study] = await db
      .insert(studies)
      .values({ oid: `ST.RTSMI.${suffix}`, name: "RTSM Intake Study" })
      .returning();
    const [otherStudy] = await db
      .insert(studies)
      .values({ oid: `ST.RTSMI2.${suffix}`, name: "Other Study" })
      .returning();
    if (!study || !otherStudy) throw new Error("fixture failed");
    fx.studyId = study.id;
    fx.otherStudyId = otherStudy.id;
    const [site] = await db
      .insert(sites)
      .values({ studyId: study.id, oid: "SITE.A", name: "Site A" })
      .returning();
    if (!site) throw new Error("fixture failed");
    fx.siteId = site.id;

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

    const admin = await mkUser(`ri-admin-${suffix}`, "admin");
    const monitor = await mkUser(`ri-monitor-${suffix}`, "monitor");
    fx.adminId = admin.id;
    fx.adminToken = admin.token;
    fx.monitorToken = monitor.token;

    const v1 = await importStudyBuild(db, { studyId: study.id, content: odm(), actorId: admin.id });
    if (!v1.ok) throw new Error(`build import failed: ${JSON.stringify(v1.issues)}`);

    const enrolled = await inject(fx.adminToken, {
      method: "POST",
      url: `/studies/${study.id}/subjects`,
      payload: { siteId: site.id, subjectKey: "S-101" },
    });
    if (enrolled.statusCode !== 201) throw new Error(`enroll failed: ${enrolled.body}`);
    fx.subjectId = enrolled.json().id;
  });

  afterAll(async () => {
    await server.close();
    await client.end();
  });

  it("config is study.manage-gated and validated against the build", async () => {
    const forbidden = await inject(fx.monitorToken, {
      method: "PUT",
      url: `/studies/${fx.studyId}/rtsm/config`,
      payload: config,
    });
    expect(forbidden.statusCode).toBe(403);

    const badOid = await inject(fx.adminToken, {
      method: "PUT",
      url: `/studies/${fx.studyId}/rtsm/config`,
      payload: { ...config, itemOid: "IT.NOPE" },
    });
    expect(badOid.statusCode).toBe(400);
    expect(badOid.json().error).toMatch(/IT.NOPE/);

    const wrongEvent = await inject(fx.adminToken, {
      method: "PUT",
      url: `/studies/${fx.studyId}/rtsm/config`,
      payload: { ...config, eventOid: "SE.NOPE" },
    });
    expect(wrongEvent.statusCode).toBe(400);

    const created = await inject(fx.adminToken, {
      method: "PUT",
      url: `/studies/${fx.studyId}/rtsm/config`,
      payload: { ...config, enabled: false },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().enabled).toBe(false);

    const fetched = await inject(fx.adminToken, {
      method: "GET",
      url: `/studies/${fx.studyId}/rtsm/config`,
    });
    expect(fetched.json().itemOid).toBe("IT.ARM");

    const trail = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.studyId, fx.studyId), eq(auditEvents.entityType, "rtsm_config")));
    expect(trail.map((e) => e.action)).toEqual(["rtsm_config.created"]);
  });

  it("rejects while disabled, recording the attempt", async () => {
    const minted = await inject(fx.adminToken, {
      method: "POST",
      url: `/studies/${fx.studyId}/rtsm/keys`,
      payload: { label: "intake tests" },
    });
    expect(minted.statusCode).toBe(201);
    fx.apiKey = minted.json().token;

    const res = await postAssignment({ subjectKey: "S-101", arm: "A", randomizationId: "R-1" });
    expect(res.statusCode).toBe(422);
    expect(res.json().outcome).toBe("rejected");
    expect(res.json().reason).toMatch(/disabled/);

    const enable = await inject(fx.adminToken, {
      method: "PUT",
      url: `/studies/${fx.studyId}/rtsm/config`,
      payload: config,
    });
    expect(enable.statusCode).toBe(200);
    expect(enable.json().enabled).toBe(true);
  });

  it("rejects an unknown subject with a reconcilable event row", async () => {
    const res = await postAssignment({ subjectKey: "S-999", arm: "A", randomizationId: "R-2" });
    expect(res.statusCode).toBe(422);
    expect(res.json().reason).toMatch(/not enrolled/);

    const [event] = await db
      .select()
      .from(rtsmEvents)
      .where(and(eq(rtsmEvents.studyId, fx.studyId), eq(rtsmEvents.randomizationId, "R-2")));
    expect(event?.outcome).toBe("rejected");
    expect(event?.subjectId).toBeNull();
    expect(event?.subjectKey).toBe("S-999");
  });

  it("applies an assignment through the standard write path", async () => {
    const res = await postAssignment({
      subjectKey: "S-101",
      arm: "ARM-B",
      randomizationId: "R-3",
      assignedAt: "2026-07-11T09:30:00Z",
      strata: { region: "US" },
      source: "vendor-rtsm",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.outcome).toBe("applied");
    // The arm is never echoed.
    expect(JSON.stringify(body)).not.toContain("ARM-B");

    const [joined] = await armVersions();
    expect(joined?.version.itemOid).toBe("IT.ARM");
    expect(joined?.version.value).toBe("ARM-B");
    expect(joined?.event.outcome).toBe("applied");
    expect(joined?.event.subjectId).toBe(fx.subjectId);

    const integrated = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.studyId, fx.studyId), eq(auditEvents.action, "item_value.integrated")),
      );
    expect(integrated).toHaveLength(1);

    // The form read shows the arm to unblinded staff, masked to the monitor.
    const formId = (
      await db
        .select({ id: rtsmEvents.id, formInstanceId: itemValueVersions.formInstanceId })
        .from(rtsmEvents)
        .innerJoin(itemValueVersions, eq(rtsmEvents.itemValueVersionId, itemValueVersions.id))
        .where(eq(rtsmEvents.studyId, fx.studyId))
    )[0]?.formInstanceId;
    if (!formId) throw new Error("form instance missing");

    const adminView = await inject(fx.adminToken, { method: "GET", url: `/forms/${formId}` });
    const adminArm = adminView
      .json()
      .values.find((v: { item_oid: string }) => v.item_oid === "IT.ARM");
    expect(adminArm.value).toBe("ARM-B");

    const monitorView = await inject(fx.monitorToken, { method: "GET", url: `/forms/${formId}` });
    const monitorArm = monitorView
      .json()
      .values.find((v: { item_oid: string }) => v.item_oid === "IT.ARM");
    expect(monitorArm.value).toBeNull();
    expect(monitorArm.blinded).toBe(true);
  });

  it("an identical replay is a duplicate and writes nothing", async () => {
    const res = await postAssignment({
      subjectKey: "S-101",
      arm: "ARM-B",
      randomizationId: "R-3",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe("duplicate");
    expect(await armVersions()).toHaveLength(1);
  });

  it("a differing arm is a conflict and the stored value is untouched", async () => {
    const res = await postAssignment({
      subjectKey: "S-101",
      arm: "ARM-A",
      randomizationId: "R-4",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().outcome).toBe("conflict");
    // Neither value leaks in the response.
    expect(JSON.stringify(res.json())).not.toMatch(/ARM-A|ARM-B/);

    const versions = await armVersions();
    expect(versions).toHaveLength(1);
    expect(versions[0]?.version.value).toBe("ARM-B");
  });

  it("masks arm and strata in the events listing for blinded viewers", async () => {
    const adminList = await inject(fx.adminToken, {
      method: "GET",
      url: `/studies/${fx.studyId}/rtsm/events`,
    });
    expect(adminList.statusCode).toBe(200);
    const adminApplied = adminList.json().find((e: { outcome: string }) => e.outcome === "applied");
    expect(adminApplied.payload.arm).toBe("ARM-B");
    expect(adminApplied.payload.strata).toEqual({ region: "US" });

    const monitorList = await inject(fx.monitorToken, {
      method: "GET",
      url: `/studies/${fx.studyId}/rtsm/events`,
    });
    expect(monitorList.statusCode).toBe(200);
    for (const event of monitorList.json()) {
      expect(JSON.stringify(event)).not.toMatch(/ARM-B|region/);
    }
    const monitorApplied = monitorList
      .json()
      .find((e: { outcome: string }) => e.outcome === "applied");
    expect(monitorApplied.payload.arm).toBe("[BLINDED]");
    expect(monitorApplied.payload.subjectKey).toBe("S-101");
  });

  it("rejects when the service account's grant is revoked, and recovers", async () => {
    const [account] = await db
      .select()
      .from(users)
      .where(eq(users.username, `svc-rtsm-${fx.studyId}`));
    if (!account) throw new Error("service account missing");
    const [role] = await db.select().from(roles).where(eq(roles.name, RTSM_AGENT_ROLE));
    if (!role) throw new Error("role missing");

    await db
      .update(userStudyRoles)
      .set({ revokedAt: new Date() })
      .where(and(eq(userStudyRoles.userId, account.id), eq(userStudyRoles.roleId, role.id)));
    try {
      const res = await postAssignment({
        subjectKey: "S-101",
        arm: "ARM-B",
        randomizationId: "R-5",
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().reason).toMatch(/integration.rtsm/);
    } finally {
      await db
        .update(userStudyRoles)
        .set({ revokedAt: null })
        .where(and(eq(userStudyRoles.userId, account.id), eq(userStudyRoles.roleId, role.id)));
    }
  });

  it("only an API key for this study can post", async () => {
    const crossStudy = await postAssignment(
      { subjectKey: "S-101", arm: "A", randomizationId: "R-6" },
      { studyId: fx.otherStudyId },
    );
    expect(crossStudy.statusCode).toBe(403);

    const session = await postAssignment(
      { subjectKey: "S-101", arm: "A", randomizationId: "R-6" },
      { key: fx.adminToken },
    );
    expect(session.statusCode).toBe(401);
  });

  it("the events log is append-only", async () => {
    const [event] = await db
      .select({ id: rtsmEvents.id })
      .from(rtsmEvents)
      .where(eq(rtsmEvents.studyId, fx.studyId))
      .limit(1);
    if (!event) throw new Error("no events");
    // drizzle wraps the pg error; the trigger's message is on the cause chain.
    const rejection = async (promise: Promise<unknown>) => {
      try {
        await promise;
        return "";
      } catch (err) {
        const messages: string[] = [];
        for (let e = err; e instanceof Error; e = e.cause) messages.push(e.message);
        return messages.join("; ");
      }
    };
    expect(
      await rejection(
        db.update(rtsmEvents).set({ outcome: "applied" }).where(eq(rtsmEvents.id, event.id)),
      ),
    ).toContain("append-only");
    expect(await rejection(db.delete(rtsmEvents).where(eq(rtsmEvents.id, event.id)))).toContain(
      "append-only",
    );
  });

  // Last: applies a second assignment, which would skew the earlier
  // one-write-per-study count assertions if it ran before them.
  it("rejects a withdrawn subject until reinstated (#67)", async () => {
    const enrolled = await inject(fx.adminToken, {
      method: "POST",
      url: `/studies/${fx.studyId}/subjects`,
      payload: { siteId: fx.siteId, subjectKey: "S-102" },
    });
    expect(enrolled.statusCode).toBe(201);
    const subjectId = enrolled.json().id;
    const withdrawn = await inject(fx.adminToken, {
      method: "POST",
      url: `/subjects/${subjectId}/status`,
      payload: { action: "withdraw", reason: "consent withdrawn" },
    });
    expect(withdrawn.statusCode).toBe(200);

    const rejected = await postAssignment({
      subjectKey: "S-102",
      arm: "ARM-A",
      randomizationId: "R-W1",
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().reason).toMatch(/withdrawn.*reinstate/);
    const [event] = await db
      .select()
      .from(rtsmEvents)
      .where(and(eq(rtsmEvents.studyId, fx.studyId), eq(rtsmEvents.randomizationId, "R-W1")));
    expect(event?.outcome).toBe("rejected");
    expect(event?.subjectId).toBe(subjectId);

    const reinstated = await inject(fx.adminToken, {
      method: "POST",
      url: `/subjects/${subjectId}/status`,
      payload: { action: "reinstate", reason: "withdrawn in error" },
    });
    expect(reinstated.statusCode).toBe(200);
    const applied = await postAssignment({
      subjectKey: "S-102",
      arm: "ARM-A",
      randomizationId: "R-W2",
    });
    expect(applied.statusCode).toBe(201);
    expect(applied.json().outcome).toBe("applied");
  });
});
