import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password.js";
import { grantRole } from "../auth/rbac.js";
import { createDb, databaseUrl } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { auditEvents, roles, sites, studies, users } from "../db/schema/index.js";
import { buildServer } from "../server.js";
import { collectCasebookData } from "../services/casebook.js";
import { importStudyBuild } from "../services/study-builds.js";

const { db, client } = createDb();
let dbAvailable = false;
try {
  await client`SELECT 1`;
  dbAvailable = true;
} catch {
  if (process.env.CI) throw new Error(`CI requires a reachable database at ${databaseUrl()}`);
  console.warn(`⚠ Skipping casebook tests: no database at ${databaseUrl()}.`);
}

/** Codelist + repeating group so the casebook exercises decodes and occurrences. */
const CASEBOOK_ODM = `<ODM xmlns="http://www.cdisc.org/ns/odm/v2.0" FileOID="CBK" FileType="Snapshot"
    ODMVersion="2.0" CreationDateTime="2026-07-07T00:00:00Z" Granularity="Metadata">
  <Study OID="ST.CBK" StudyName="Casebook Study">
    <MetaDataVersion OID="MDV.1" Name="v1">
      <StudyEventDef OID="SE.V1" Name="Visit 1" Repeating="No" Type="Scheduled">
        <ItemGroupRef ItemGroupOID="FO.VS" Mandatory="Yes"/>
      </StudyEventDef>
      <ItemGroupDef OID="FO.VS" Name="Vital Signs" Type="Form" Repeating="No">
        <ItemGroupRef ItemGroupOID="IG.GEN" Mandatory="Yes"/>
        <ItemGroupRef ItemGroupOID="IG.VS" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemGroupDef OID="IG.GEN" Name="General" Type="Section" Repeating="No">
        <ItemRef ItemOID="IT.POS" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemGroupDef OID="IG.VS" Name="Reading" Type="Section" Repeating="Simple">
        <ItemRef ItemOID="IT.SYSBP" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemDef OID="IT.POS" Name="Position" DataType="text">
        <Question><TranslatedText xml:lang="en">Position of subject?</TranslatedText></Question>
        <CodeListRef CodeListOID="CL.POS"/>
      </ItemDef>
      <ItemDef OID="IT.SYSBP" Name="Systolic BP" DataType="integer">
        <Question><TranslatedText xml:lang="en">Systolic blood pressure?</TranslatedText></Question>
      </ItemDef>
      <CodeList OID="CL.POS" Name="Position" DataType="text">
        <CodeListItem CodedValue="SITTING">
          <Decode><TranslatedText xml:lang="en">Sitting</TranslatedText></Decode>
        </CodeListItem>
      </CodeList>
    </MetaDataVersion>
  </Study>
</ODM>`;

const PASSWORD = "correct-Horse-battery-7";

describe.skipIf(!dbAvailable)("subject casebook export", () => {
  let server: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const fx = { studyId: "", subjectId: "", formId: "", invToken: "", dmToken: "", invName: "" };

  beforeAll(async () => {
    await runMigrations();
    server = await buildServer({ db });
    await server.ready();

    const passwordHash = await hashPassword(PASSWORD);
    const mkUser = async (prefix: string, fullName: string) => {
      const [user] = await db
        .insert(users)
        .values({
          username: `${prefix}-${suffix}`,
          email: `${prefix}-${suffix}@example.com`,
          fullName,
          passwordHash,
        })
        .returning();
      if (!user) throw new Error("user fixture failed");
      return user;
    };
    const investigator = await mkUser("cbi", "Casebook Investigator");
    const dataManager = await mkUser("cbd", "Casebook DM");
    fx.invName = investigator.fullName;

    const [study] = await db
      .insert(studies)
      .values({ oid: `ST.CBK.${suffix}`, name: "Casebook Study" })
      .returning();
    if (!study) throw new Error("study fixture failed");
    fx.studyId = study.id;
    const [site] = await db
      .insert(sites)
      .values({ studyId: study.id, oid: "SITE.1", name: "Casebook Site" })
      .returning();
    if (!site) throw new Error("site fixture failed");

    const roleByName = async (name: string) => {
      const [role] = await db.select().from(roles).where(eq(roles.name, name));
      if (!role) throw new Error(`role ${name} missing`);
      return role;
    };
    await grantRole(db, {
      userId: investigator.id,
      studyId: study.id,
      roleId: (await roleByName("investigator")).id,
      grantedBy: investigator.id,
    });
    await grantRole(db, {
      userId: dataManager.id,
      studyId: study.id,
      roleId: (await roleByName("data_manager")).id,
      grantedBy: investigator.id,
    });

    const imported = await importStudyBuild(db, {
      studyId: study.id,
      content: CASEBOOK_ODM,
      actorId: dataManager.id,
    });
    if (!imported.ok) throw new Error(`import failed: ${JSON.stringify(imported.issues)}`);

    const login = async (username: string) =>
      (
        await server.inject({
          method: "POST",
          url: "/auth/login",
          payload: { username, password: PASSWORD },
        })
      ).json().token as string;
    fx.invToken = await login(`cbi-${suffix}`);
    fx.dmToken = await login(`cbd-${suffix}`);

    const auth = { authorization: `Bearer ${fx.invToken}` };
    const subject = (
      await server.inject({
        method: "POST",
        url: `/studies/${study.id}/subjects`,
        payload: { siteId: site.id, subjectKey: "CB-001" },
        headers: auth,
      })
    ).json();
    fx.subjectId = subject.id;
    fx.formId = (
      await server.inject({
        method: "POST",
        url: `/subjects/${subject.id}/forms`,
        payload: { eventOid: "SE.V1", formOid: "FO.VS" },
        headers: auth,
      })
    ).json().id;

    const write = (payload: Record<string, unknown>) =>
      server.inject({ method: "PUT", url: `/forms/${fx.formId}/items`, payload, headers: auth });
    await write({ itemGroupOid: "IG.GEN", itemOid: "IT.POS", value: "SITTING" });
    await write({
      itemGroupOid: "IG.VS",
      itemGroupRepeatKey: 1,
      itemOid: "IT.SYSBP",
      value: "120",
    });
    await write({
      itemGroupOid: "IG.VS",
      itemGroupRepeatKey: 2,
      itemOid: "IT.SYSBP",
      value: "125",
    });
    // A correction, so the casebook shows a version marker with the reason.
    await write({
      itemGroupOid: "IG.VS",
      itemGroupRepeatKey: 2,
      itemOid: "IT.SYSBP",
      value: "126",
      reasonForChange: "transcription error",
    });
    await server.inject({
      method: "POST",
      url: `/forms/${fx.formId}/status`,
      payload: { action: "complete" },
      headers: auth,
    });
    await server.inject({
      method: "POST",
      url: `/forms/${fx.formId}/sign`,
      payload: { username: `cbi-${suffix}`, password: PASSWORD, meaning: "Investigator approval" },
      headers: auth,
    });
  });

  afterAll(async () => {
    await server.close();
    await client.end();
  });

  it("assembles the casebook data faithfully", async () => {
    const data = await collectCasebookData(db, { studyId: fx.studyId, subjectId: fx.subjectId });
    expect(data.subject).toMatchObject({ key: "CB-001", siteName: "Casebook Site" });
    expect(data.events).toHaveLength(1);
    const form = data.events[0]?.forms[0];
    expect(form).toMatchObject({ formOid: "FO.VS", name: "Vital Signs", status: "signed" });

    // Non-repeating group with codelist decode.
    const general = form?.groups.find((g) => g.groupOid === "IG.GEN");
    expect(general?.occurrence).toBeNull();
    expect(general?.items[0]).toMatchObject({ value: "SITTING", decode: "Sitting", version: 1 });

    // Repeating group expands per stored occurrence; correction is marked.
    const readings = form?.groups.filter((g) => g.groupOid === "IG.VS") ?? [];
    expect(readings.map((g) => g.occurrence)).toEqual([1, 2]);
    expect(readings[0]?.items[0]).toMatchObject({ value: "120", version: 1 });
    expect(readings[1]?.items[0]).toMatchObject({
      value: "126",
      version: 2,
      reasonForChange: "transcription error",
    });

    expect(form?.signatures[0]).toMatchObject({
      signerName: fx.invName,
      meaning: "Investigator approval",
      invalidatedReason: null,
    });
  });

  it("returns a PDF for export.data holders and audits the export", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/subjects/${fx.subjectId}/casebook`,
      headers: { authorization: `Bearer ${fx.dmToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toContain("CB-001-casebook.pdf");
    expect(res.rawPayload.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(res.rawPayload.length).toBeGreaterThan(1500);

    const trail = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "subject.casebook_exported"));
    expect(trail.some((e) => e.entityId === fx.subjectId)).toBe(true);
  });

  it("denies users without export.data", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/subjects/${fx.subjectId}/casebook`,
      headers: { authorization: `Bearer ${fx.invToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("404s for unknown subjects", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/subjects/${randomUUID()}/casebook`,
      headers: { authorization: `Bearer ${fx.dmToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
