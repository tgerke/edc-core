import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password.js";
import { grantRole } from "../auth/rbac.js";
import { createDb, databaseUrl } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { auditEvents, queries, roles, sites, studies, users } from "../db/schema/index.js";
import { buildServer } from "../server.js";
import { importStudyBuild } from "../services/study-builds.js";

const { db, client } = createDb();
let dbAvailable = false;
try {
  await client`SELECT 1`;
  dbAvailable = true;
} catch {
  if (process.env.CI) throw new Error(`CI requires a reachable database at ${databaseUrl()}`);
  console.warn(`⚠ Skipping checks integration tests: no database at ${databaseUrl()}.`);
}

const VITALS_ODM = `<ODM xmlns="http://www.cdisc.org/ns/odm/v2.0" FileOID="VITALS" FileType="Snapshot"
    ODMVersion="2.0" CreationDateTime="2026-07-04T00:00:00Z" Granularity="Metadata">
  <Study OID="ST.VITALS" StudyName="Vitals Study">
    <MetaDataVersion OID="MDV.1" Name="v1">
      <StudyEventDef OID="SE.V1" Name="Visit 1" Repeating="No" Type="Scheduled">
        <ItemGroupRef ItemGroupOID="FO.VS" Mandatory="Yes"/>
      </StudyEventDef>
      <ItemGroupDef OID="FO.VS" Name="Vital Signs" Type="Form" Repeating="No">
        <ItemGroupRef ItemGroupOID="IG.VS" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemGroupDef OID="IG.VS" Name="Blood Pressure" Type="Section" Repeating="No">
        <ItemRef ItemOID="IT.SYSBP" Mandatory="Yes"/>
        <ItemRef ItemOID="IT.DIABP" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemDef OID="IT.SYSBP" Name="Systolic BP" DataType="integer"/>
      <ItemDef OID="IT.DIABP" Name="Diastolic BP" DataType="integer"/>
      <ConditionDef OID="CHECK.BP_INVERTED" Name="BP inverted">
        <Description><TranslatedText xml:lang="en" Type="text/plain">Systolic BP must exceed diastolic BP</TranslatedText></Description>
        <FormalExpression Context="jsonata">\`IT.SYSBP\` != null and \`IT.DIABP\` != null and \`IT.SYSBP\` &lt;= \`IT.DIABP\`</FormalExpression>
      </ConditionDef>
    </MetaDataVersion>
  </Study>
</ODM>`;

const PASSWORD = "correct-Horse-battery-7";

describe.skipIf(!dbAvailable)("edit checks raise and resolve system queries", () => {
  let server: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const fx = { studyId: "", formId: "", token: "" };

  beforeAll(async () => {
    await runMigrations();
    server = await buildServer({ db });
    await server.ready();

    const [user] = await db
      .insert(users)
      .values({
        username: `chk-${suffix}`,
        email: `chk-${suffix}@example.com`,
        fullName: "Checker",
        passwordHash: await hashPassword(PASSWORD),
      })
      .returning();
    const [study] = await db
      .insert(studies)
      .values({ oid: `ST.CHK.${suffix}`, name: "Checks Study" })
      .returning();
    if (!user || !study) throw new Error("fixture failed");
    fx.studyId = study.id;
    const [site] = await db
      .insert(sites)
      .values({ studyId: study.id, oid: "SITE.1", name: "Site" })
      .returning();
    const [investigator] = await db.select().from(roles).where(eq(roles.name, "investigator"));
    if (!site || !investigator) throw new Error("fixture failed");
    await grantRole(db, {
      userId: user.id,
      studyId: study.id,
      roleId: investigator.id,
      grantedBy: user.id,
    });

    const imported = await importStudyBuild(db, {
      studyId: study.id,
      content: VITALS_ODM,
      actorId: user.id,
    });
    if (!imported.ok) throw new Error(`import failed: ${JSON.stringify(imported.issues)}`);

    fx.token = (
      await server.inject({
        method: "POST",
        url: "/auth/login",
        payload: { username: `chk-${suffix}`, password: PASSWORD },
      })
    ).json().token;

    const subject = (
      await server.inject({
        method: "POST",
        url: `/studies/${study.id}/subjects`,
        payload: { siteId: site.id, subjectKey: "V-001" },
        headers: { authorization: `Bearer ${fx.token}` },
      })
    ).json();
    fx.formId = (
      await server.inject({
        method: "POST",
        url: `/subjects/${subject.id}/forms`,
        payload: { eventOid: "SE.V1", formOid: "FO.VS" },
        headers: { authorization: `Bearer ${fx.token}` },
      })
    ).json().id;
  });

  afterAll(async () => {
    await server.close();
    await client.end();
  });

  function write(itemOid: string, value: string, reasonForChange?: string) {
    return server.inject({
      method: "PUT",
      url: `/forms/${fx.formId}/items`,
      payload: {
        itemGroupOid: "IG.VS",
        itemOid,
        value,
        ...(reasonForChange ? { reasonForChange } : {}),
      },
      headers: { authorization: `Bearer ${fx.token}` },
    });
  }

  it("opens a system query when a check fires", async () => {
    await write("IT.SYSBP", "80");
    const res = await write("IT.DIABP", "95");
    expect(res.statusCode).toBe(201);
    expect(res.json().findings).toEqual([
      { checkOid: "CHECK.BP_INVERTED", message: "Systolic BP must exceed diastolic BP" },
    ]);

    const open = await db
      .select()
      .from(queries)
      .where(and(eq(queries.formInstanceId, fx.formId), eq(queries.status, "open")));
    expect(open).toHaveLength(1);
    expect(open[0]?.origin).toBe("system");
    expect(open[0]?.checkOid).toBe("CHECK.BP_INVERTED");
  });

  it("does not duplicate the query while the problem persists", async () => {
    const res = await write("IT.DIABP", "96", "re-measured");
    expect(res.json().findings).toHaveLength(1);
    const open = await db
      .select()
      .from(queries)
      .where(and(eq(queries.formInstanceId, fx.formId), eq(queries.status, "open")));
    expect(open).toHaveLength(1);
  });

  it("exposes open queries on form reads", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/forms/${fx.formId}`,
      headers: { authorization: `Bearer ${fx.token}` },
    });
    expect(res.json().openQueries).toHaveLength(1);
    expect(res.json().openQueries[0].checkOid).toBe("CHECK.BP_INVERTED");
  });

  it("auto-closes the query when the data problem is resolved, with audit", async () => {
    const res = await write("IT.SYSBP", "128", "transcription error");
    expect(res.json().findings).toEqual([]);

    const open = await db
      .select()
      .from(queries)
      .where(and(eq(queries.formInstanceId, fx.formId), eq(queries.status, "open")));
    expect(open).toHaveLength(0);

    const trail = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.studyId, fx.studyId), eq(auditEvents.entityType, "query")));
    expect(trail.map((e) => e.action).sort()).toEqual(["query.closed", "query.opened"]);
  });
});
