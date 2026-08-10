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
import { importStudyBuild } from "../services/study-builds.js";

const { db, client } = createDb();
let dbAvailable = false;
try {
  await client`SELECT 1`;
  dbAvailable = true;
} catch {
  if (process.env.CI) throw new Error(`CI requires a reachable database at ${databaseUrl()}`);
  console.warn(`⚠ Skipping PMO integration tests: no database at ${databaseUrl()}.`);
}

const PASSWORD = "correct-Horse-battery-7";

/** Build v1: SE.V1 collects FO.VISIT whose IT.VISDT is the designated visit
 * date; SE.EXTRA collects a form with no designated item. */
function odmV1(): string {
  return `<ODM xmlns="http://www.cdisc.org/ns/odm/v2.0"
      xmlns:edc="https://github.com/tgerke/edc-core/ns/odm-ext/v1"
      FileOID="PMO1" FileType="Snapshot"
      ODMVersion="2.0" CreationDateTime="2026-08-10T00:00:00Z" Granularity="Metadata">
    <Study OID="ST.PMO" StudyName="PMO Read Study">
      <MetaDataVersion OID="MDV.1" Name="v1">
        <StudyEventDef OID="SE.V1" Name="Visit 1" Repeating="No" Type="Scheduled">
          <ItemGroupRef ItemGroupOID="FO.VISIT" Mandatory="Yes"/>
        </StudyEventDef>
        <StudyEventDef OID="SE.EXTRA" Name="Unscheduled" Repeating="No" Type="Unscheduled">
          <ItemGroupRef ItemGroupOID="FO.NOTES" Mandatory="No"/>
        </StudyEventDef>
        <ItemGroupDef OID="FO.VISIT" Name="Visit Form" Type="Form" Repeating="No">
          <ItemGroupRef ItemGroupOID="IG.VISIT" Mandatory="Yes"/>
        </ItemGroupDef>
        <ItemGroupDef OID="IG.VISIT" Name="Visit Details" Type="Section" Repeating="No">
          <ItemRef ItemOID="IT.VISDT" Mandatory="Yes"/>
          <ItemRef ItemOID="IT.WEIGHT" Mandatory="No"/>
        </ItemGroupDef>
        <ItemGroupDef OID="FO.NOTES" Name="Notes Form" Type="Form" Repeating="No">
          <ItemGroupRef ItemGroupOID="IG.NOTES" Mandatory="Yes"/>
        </ItemGroupDef>
        <ItemGroupDef OID="IG.NOTES" Name="Notes" Type="Section" Repeating="No">
          <ItemRef ItemOID="IT.NOTE" Mandatory="No"/>
        </ItemGroupDef>
        <ItemDef OID="IT.VISDT" Name="Visit Date" DataType="date" edc:VisitDate="Yes"/>
        <ItemDef OID="IT.WEIGHT" Name="Weight" DataType="float"/>
        <ItemDef OID="IT.NOTE" Name="Note" DataType="text"/>
      </MetaDataVersion>
    </Study>
  </ODM>`;
}

describe.skipIf(!dbAvailable)("PMO read surface (ADR-0017, integration)", () => {
  let server: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const fx = {
    studyId: "",
    otherStudyId: "",
    siteId: "",
    adminToken: "",
    adminId: "",
    readOnlyToken: "",
    pmoKey: "",
    rtsmKey: "",
    otherPmoKey: "",
    subjectIds: new Map<string, string>(),
    formInstanceIds: new Map<string, string>(),
  };

  function inject(
    token: string,
    opts: { method: "GET" | "POST" | "PUT"; url: string; payload?: object },
  ) {
    return server.inject({ ...opts, headers: { authorization: `Bearer ${token}` } });
  }

  async function createForm(subjectKey: string, eventOid: string, formOid: string) {
    const subjectId = fx.subjectIds.get(subjectKey);
    const res = await inject(fx.adminToken, {
      method: "POST",
      url: `/subjects/${subjectId}/forms`,
      payload: { eventOid, formOid },
    });
    if (res.statusCode !== 201) throw new Error(`form create failed: ${res.body}`);
    fx.formInstanceIds.set(`${subjectKey}|${eventOid}|${formOid}`, res.json().id);
    return res.json().id;
  }

  async function writeItem(
    formKey: string,
    itemGroupOid: string,
    itemOid: string,
    value: string,
    reasonForChange?: string,
  ) {
    const res = await inject(fx.adminToken, {
      method: "PUT",
      url: `/forms/${fx.formInstanceIds.get(formKey)}/items`,
      payload: { itemGroupOid, itemOid, value, ...(reasonForChange ? { reasonForChange } : {}) },
    });
    if (res.statusCode !== 200 && res.statusCode !== 201) {
      throw new Error(`item write failed: ${res.body}`);
    }
  }

  beforeAll(async () => {
    await runMigrations();
    server = await buildServer({ db });
    await server.ready();

    const [study] = await db
      .insert(studies)
      .values({ oid: `ST.PMO.${suffix}`, name: "PMO Read Study" })
      .returning();
    const [otherStudy] = await db
      .insert(studies)
      .values({ oid: `ST.PMO2.${suffix}`, name: "Other Study" })
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

    const mkUser = async (username: string, roleName: string, studyId: string) => {
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
      await grantRole(db, { userId: user.id, studyId, roleId: role.id, grantedBy: user.id });
      const token = (
        await server.inject({
          method: "POST",
          url: "/auth/login",
          payload: { username, password: PASSWORD },
        })
      ).json().token;
      return { id: user.id, token };
    };

    const admin = await mkUser(`pmo-admin-${suffix}`, "admin", study.id);
    fx.adminId = admin.id;
    fx.adminToken = admin.token;
    fx.readOnlyToken = (await mkUser(`pmo-ro-${suffix}`, "read_only", study.id)).token;
    const otherAdmin = await mkUser(`pmo-admin2-${suffix}`, "admin", otherStudy.id);

    const v1 = await importStudyBuild(db, {
      studyId: study.id,
      content: odmV1(),
      actorId: admin.id,
    });
    if (!v1.ok) throw new Error(`build import failed: ${JSON.stringify(v1.issues)}`);

    for (const key of ["S-101", "S-102", "S-103"]) {
      const enrolled = await inject(fx.adminToken, {
        method: "POST",
        url: `/studies/${study.id}/subjects`,
        payload: { siteId: site.id, subjectKey: key },
      });
      if (enrolled.statusCode !== 201) throw new Error(`enroll failed: ${enrolled.body}`);
      fx.subjectIds.set(key, enrolled.json().id);
    }

    // S-101: a dated visit plus an undated unscheduled event.
    await createForm("S-101", "SE.V1", "FO.VISIT");
    await writeItem("S-101|SE.V1|FO.VISIT", "IG.VISIT", "IT.VISDT", "2026-06-02");
    await createForm("S-101", "SE.EXTRA", "FO.NOTES");
    // S-102: the date is corrected after first entry; the current value wins.
    await createForm("S-102", "SE.V1", "FO.VISIT");
    await writeItem("S-102|SE.V1|FO.VISIT", "IG.VISIT", "IT.VISDT", "2026-06-03");
    await writeItem("S-102|SE.V1|FO.VISIT", "IG.VISIT", "IT.VISDT", "2026-06-04", "typo");
    // S-103: a form exists, nothing entered yet.
    await createForm("S-103", "SE.V1", "FO.VISIT");

    // A manual query with a thread, for the body-omission pin.
    const q = await inject(fx.adminToken, {
      method: "POST",
      url: `/forms/${fx.formInstanceIds.get("S-101|SE.V1|FO.VISIT")}/queries`,
      payload: { itemGroupOid: "IG.VISIT", itemOid: "IT.VISDT", body: "Please confirm the date" },
    });
    if (q.statusCode !== 201) throw new Error(`query open failed: ${q.body}`);

    const mintKey = async (token: string, studyId: string, path: "pmo" | "rtsm") => {
      const res = await inject(token, {
        method: "POST",
        url: `/studies/${studyId}/${path}/keys`,
        payload: { label: "integration tests" },
      });
      if (res.statusCode !== 201) throw new Error(`key mint failed: ${res.body}`);
      return res.json().token;
    };
    fx.pmoKey = await mintKey(fx.adminToken, fx.studyId, "pmo");
    fx.rtsmKey = await mintKey(fx.adminToken, fx.studyId, "rtsm");
    fx.otherPmoKey = await mintKey(otherAdmin.token, fx.otherStudyId, "pmo");
  });

  afterAll(async () => {
    await server.close();
    await client.end();
  });

  it("mints pmo keys with their own prefix, listed apart from RTSM keys", async () => {
    expect(fx.pmoKey.startsWith("edcpmo_")).toBe(true);
    expect(fx.rtsmKey.startsWith("edcrtsm_")).toBe(true);
    const pmoList = await inject(fx.adminToken, {
      method: "GET",
      url: `/studies/${fx.studyId}/pmo/keys`,
    });
    const rtsmList = await inject(fx.adminToken, {
      method: "GET",
      url: `/studies/${fx.studyId}/rtsm/keys`,
    });
    expect(pmoList.json()).toHaveLength(1);
    expect(rtsmList.json()).toHaveLength(1);
    expect(pmoList.json()[0].tokenPrefix.startsWith("edcpmo_")).toBe(true);
  });

  it("serves visits with build-designated dates: current value wins, undated is null", async () => {
    const res = await inject(fx.pmoKey, { method: "GET", url: `/studies/${fx.studyId}/visits` });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows).toEqual([
      expect.objectContaining({
        subjectKey: "S-101",
        eventOid: "SE.EXTRA",
        eventRepeatKey: 1,
        visitDate: null,
      }),
      expect.objectContaining({ subjectKey: "S-101", eventOid: "SE.V1", visitDate: "2026-06-02" }),
      expect.objectContaining({ subjectKey: "S-102", eventOid: "SE.V1", visitDate: "2026-06-04" }),
      expect.objectContaining({ subjectKey: "S-103", eventOid: "SE.V1", visitDate: null }),
    ]);
  });

  it("serves form instances with first-entry timestamps; untouched forms are null", async () => {
    const res = await inject(fx.pmoKey, {
      method: "GET",
      url: `/studies/${fx.studyId}/form-instances`,
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    const byKey = new Map(
      rows.map((r: { subjectKey: string; formOid: string }) => [`${r.subjectKey}|${r.formOid}`, r]),
    );
    expect(byKey.get("S-101|FO.VISIT")).toMatchObject({
      eventOid: "SE.V1",
      status: "in_progress",
    });
    expect((byKey.get("S-101|FO.VISIT") as { firstEnteredAt: string }).firstEnteredAt).toBeTruthy();
    expect(byKey.get("S-103|FO.VISIT")).toMatchObject({
      status: "not_started",
      firstEnteredAt: null,
    });
  });

  it("session members see the same listings", async () => {
    const visits = await inject(fx.readOnlyToken, {
      method: "GET",
      url: `/studies/${fx.studyId}/visits`,
    });
    expect(visits.statusCode).toBe(200);
    expect(visits.json()).toHaveLength(4);
    const forms = await inject(fx.readOnlyToken, {
      method: "GET",
      url: `/studies/${fx.studyId}/form-instances`,
    });
    expect(forms.statusCode).toBe(200);
  });

  it("lets a pmo key read subjects, members, and queries — with message bodies omitted", async () => {
    const subjects = await inject(fx.pmoKey, {
      method: "GET",
      url: `/studies/${fx.studyId}/subjects`,
    });
    expect(subjects.statusCode).toBe(200);
    expect(subjects.json()).toHaveLength(3);

    const members = await inject(fx.pmoKey, {
      method: "GET",
      url: `/studies/${fx.studyId}/members`,
    });
    expect(members.statusCode).toBe(200);
    // Service accounts never appear in the roster, the pmo account included.
    expect(members.json().every((m: { username: string }) => !m.username.startsWith("svc-"))).toBe(
      true,
    );

    const queries = await inject(fx.pmoKey, {
      method: "GET",
      url: `/studies/${fx.studyId}/queries`,
    });
    expect(queries.statusCode).toBe(200);
    const [thread] = queries.json();
    expect(thread.messages.length).toBeGreaterThan(0);
    expect(thread.messages[0].author).toBeTruthy();
    expect(thread.messages[0].createdAt).toBeTruthy();
    expect(thread.messages[0]).not.toHaveProperty("body");

    // The same listing keeps bodies for a session member.
    const memberView = await inject(fx.adminToken, {
      method: "GET",
      url: `/studies/${fx.studyId}/queries`,
    });
    expect(memberView.json()[0].messages[0].body).toBe("Please confirm the date");
  });

  it("pins key classes: an RTSM key cannot read, a pmo key cannot post assignments", async () => {
    const read = await inject(fx.rtsmKey, { method: "GET", url: `/studies/${fx.studyId}/visits` });
    expect(read.statusCode).toBe(401);
    const write = await inject(fx.pmoKey, {
      method: "POST",
      url: `/studies/${fx.studyId}/rtsm/assignments`,
      payload: { subjectKey: "S-101", arm: "A", randomizationId: "R-9" },
    });
    expect(write.statusCode).toBe(401);
  });

  it("scopes keys to their study and rejects anonymous callers", async () => {
    const wrongStudy = await inject(fx.otherPmoKey, {
      method: "GET",
      url: `/studies/${fx.studyId}/visits`,
    });
    expect(wrongStudy.statusCode).toBe(403);
    const anonymous = await server.inject({
      method: "GET",
      url: `/studies/${fx.studyId}/visits`,
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it("fails loudly on a visit-date value that is not an ISO date", async () => {
    await createForm("S-103", "SE.EXTRA", "FO.NOTES");
    // The unvalidated write path accepts free text; the read boundary is
    // where a non-ISO value must stop, naming the datum (ADR-0017).
    await writeItem("S-103|SE.V1|FO.VISIT", "IG.VISIT", "IT.VISDT", "06/15/2026");
    const res = await inject(fx.pmoKey, { method: "GET", url: `/studies/${fx.studyId}/visits` });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toContain("S-103");
    expect(res.json().error).toContain("06/15/2026");
    // Correcting the value restores the listing.
    await writeItem("S-103|SE.V1|FO.VISIT", "IG.VISIT", "IT.VISDT", "2026-06-15", "format fix");
    const fixed = await inject(fx.pmoKey, { method: "GET", url: `/studies/${fx.studyId}/visits` });
    expect(fixed.statusCode).toBe(200);
    expect(
      fixed
        .json()
        .find(
          (r: { subjectKey: string; eventOid: string }) =>
            r.subjectKey === "S-103" && r.eventOid === "SE.V1",
        ).visitDate,
    ).toBe("2026-06-15");
  });
});
