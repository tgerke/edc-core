import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
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
  console.warn(`⚠ Skipping dynamic-fields integration tests: no database at ${databaseUrl()}.`);
}

const DYNAMIC_ODM = `<ODM xmlns="http://www.cdisc.org/ns/odm/v2.0"
    xmlns:edc="https://github.com/tgerke/edc-core/ns/odm-ext/v1"
    FileOID="DYN" FileType="Snapshot" ODMVersion="2.0"
    CreationDateTime="2026-07-18T00:00:00Z" Granularity="Metadata">
  <Study OID="ST.DYN" StudyName="Dynamic Fields Study">
    <MetaDataVersion OID="MDV.1" Name="v1">
      <StudyEventDef OID="SE.V1" Name="Visit 1" Repeating="No" Type="Scheduled">
        <ItemGroupRef ItemGroupOID="FO.DF" Mandatory="Yes"/>
      </StudyEventDef>
      <ItemGroupDef OID="FO.DF" Name="Screening" Type="Form" Repeating="No">
        <ItemGroupRef ItemGroupOID="IG.MAIN" Mandatory="Yes" OrderNumber="1"/>
        <ItemGroupRef ItemGroupOID="IG.PREG" Mandatory="No" OrderNumber="2" CollectionExceptionConditionOID="CD.MALE"/>
        <ItemGroupRef ItemGroupOID="IG.VS" Mandatory="No" OrderNumber="3"/>
      </ItemGroupDef>
      <ItemGroupDef OID="IG.MAIN" Name="Demographics" Type="Section" Repeating="No">
        <ItemRef ItemOID="IT.SEX" Mandatory="Yes"/>
        <ItemRef ItemOID="IT.SMOKER" Mandatory="No"/>
        <ItemRef ItemOID="IT.CIGS" Mandatory="No" CollectionExceptionConditionOID="CD.NONSMOKER"/>
        <ItemRef ItemOID="IT.WT" Mandatory="No"/>
        <ItemRef ItemOID="IT.HT" Mandatory="No"/>
        <ItemRef ItemOID="IT.BMI" Mandatory="No" MethodOID="MET.BMI"/>
      </ItemGroupDef>
      <ItemGroupDef OID="IG.PREG" Name="Pregnancy" Type="Section" Repeating="No">
        <ItemRef ItemOID="IT.PREG" Mandatory="No"/>
      </ItemGroupDef>
      <ItemGroupDef OID="IG.VS" Name="Vitals" Type="Section" Repeating="Simple">
        <ItemRef ItemOID="IT.HRMEAS" Mandatory="No"/>
        <ItemRef ItemOID="IT.HR" Mandatory="No" CollectionExceptionConditionOID="CD.HRND"/>
      </ItemGroupDef>
      <ItemDef OID="IT.SEX" Name="Sex" DataType="text"/>
      <ItemDef OID="IT.SMOKER" Name="Smoker" DataType="text"/>
      <ItemDef OID="IT.CIGS" Name="Cigarettes per day" DataType="integer"/>
      <ItemDef OID="IT.WT" Name="Weight (kg)" DataType="float"/>
      <ItemDef OID="IT.HT" Name="Height (m)" DataType="float"/>
      <ItemDef OID="IT.BMI" Name="BMI" DataType="float"/>
      <ItemDef OID="IT.PREG" Name="Pregnancy test result" DataType="text">
        <CodeListRef CodeListOID="CL.PREG"/>
      </ItemDef>
      <ItemDef OID="IT.HRMEAS" Name="HR measured" DataType="boolean"/>
      <ItemDef OID="IT.HR" Name="Heart rate" DataType="integer"/>
      <CodeList OID="CL.PREG" Name="Pregnancy result" DataType="text">
        <CodeListItem CodedValue="NEG"/>
        <CodeListItem CodedValue="POS"/>
        <CodeListItem CodedValue="NA" edc:CollectionExceptionConditionOID="CD.FEMALE"/>
      </CodeList>
      <ConditionDef OID="CD.MALE" Name="Subject is male">
        <FormalExpression Context="jsonata">\`IT.SEX\` = "M"</FormalExpression>
      </ConditionDef>
      <ConditionDef OID="CD.FEMALE" Name="Subject is female">
        <FormalExpression Context="jsonata">\`IT.SEX\` = "F"</FormalExpression>
      </ConditionDef>
      <ConditionDef OID="CD.NONSMOKER" Name="Not a smoker">
        <FormalExpression Context="jsonata">\`IT.SMOKER\` != "Y"</FormalExpression>
      </ConditionDef>
      <ConditionDef OID="CD.HRND" Name="HR not measured">
        <FormalExpression Context="jsonata">\`IT.HRMEAS\` = false</FormalExpression>
      </ConditionDef>
      <MethodDef OID="MET.BMI" Name="BMI from weight and height" Type="Computation">
        <FormalExpression Context="jsonata">\`IT.WT\` != null and \`IT.HT\` != null and \`IT.HT\` &gt; 0 ? \`IT.WT\` / (\`IT.HT\` * \`IT.HT\`) : null</FormalExpression>
      </MethodDef>
    </MetaDataVersion>
  </Study>
</ODM>`;

const PASSWORD = "correct-Horse-battery-7";

describe.skipIf(!dbAvailable)("dynamic fields: derivations, skip logic, options", () => {
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
        username: `dyn-${suffix}`,
        email: `dyn-${suffix}@example.com`,
        fullName: "Dynamo",
        passwordHash: await hashPassword(PASSWORD),
      })
      .returning();
    const [study] = await db
      .insert(studies)
      .values({ oid: `ST.DYN.${suffix}`, name: "Dynamic Study" })
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
      content: DYNAMIC_ODM,
      actorId: user.id,
    });
    if (!imported.ok) throw new Error(`import failed: ${JSON.stringify(imported.issues)}`);

    fx.token = (
      await server.inject({
        method: "POST",
        url: "/auth/login",
        payload: { username: `dyn-${suffix}`, password: PASSWORD },
      })
    ).json().token;

    const subject = (
      await server.inject({
        method: "POST",
        url: `/studies/${study.id}/subjects`,
        payload: { siteId: site.id, subjectKey: "D-001" },
        headers: { authorization: `Bearer ${fx.token}` },
      })
    ).json();
    fx.formId = (
      await server.inject({
        method: "POST",
        url: `/subjects/${subject.id}/forms`,
        payload: { eventOid: "SE.V1", formOid: "FO.DF" },
        headers: { authorization: `Bearer ${fx.token}` },
      })
    ).json().id;
  });

  afterAll(async () => {
    await server.close();
    await client.end();
  });

  function write(
    itemGroupOid: string,
    itemOid: string,
    value: string | null,
    options: { reasonForChange?: string; repeatKey?: number } = {},
  ) {
    return server.inject({
      method: "PUT",
      url: `/forms/${fx.formId}/items`,
      payload: {
        itemGroupOid,
        itemOid,
        value,
        ...(options.repeatKey ? { itemGroupRepeatKey: options.repeatKey } : {}),
        ...(options.reasonForChange ? { reasonForChange: options.reasonForChange } : {}),
      },
      headers: { authorization: `Bearer ${fx.token}` },
    });
  }

  async function currentValue(itemOid: string, repeatKey = 1) {
    const rows = await db.execute<{ value: string | null }>(sql`
      SELECT value FROM item_values_current
      WHERE form_instance_id = ${fx.formId} AND item_oid = ${itemOid}
        AND item_group_repeat_key = ${repeatKey}
    `);
    return rows[0]?.value;
  }

  async function openQueries() {
    return db
      .select()
      .from(queries)
      .where(and(eq(queries.formInstanceId, fx.formId), eq(queries.status, "open")));
  }

  it("computes and stores a derived value with the derived audit action", async () => {
    expect((await write("IG.MAIN", "IT.SEX", "F")).statusCode).toBe(201);
    expect((await write("IG.MAIN", "IT.WT", "81")).statusCode).toBe(201);
    expect((await write("IG.MAIN", "IT.HT", "1.8")).statusCode).toBe(201);

    expect(await currentValue("IT.BMI")).toBe("25");
    const trail = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.studyId, fx.studyId), eq(auditEvents.action, "item_value.derived")),
      );
    expect(trail.length).toBeGreaterThanOrEqual(1);
  });

  it("recomputes the derived value when a source changes", async () => {
    expect(
      (await write("IG.MAIN", "IT.WT", "97.2", { reasonForChange: "re-weighed" })).statusCode,
    ).toBe(201);
    expect(await currentValue("IT.BMI")).toBe("30");
  });

  it("rejects direct writes to a derived item", async () => {
    const res = await write("IG.MAIN", "IT.BMI", "22", { reasonForChange: "manual" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/derived item/);
  });

  it("rejects writes to a field skipped by an item-level exception", async () => {
    expect((await write("IG.MAIN", "IT.SMOKER", "N")).statusCode).toBe(201);
    const res = await write("IG.MAIN", "IT.CIGS", "10");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not collected/);

    expect(
      (await write("IG.MAIN", "IT.SMOKER", "Y", { reasonForChange: "mis-keyed" })).statusCode,
    ).toBe(201);
    expect((await write("IG.MAIN", "IT.CIGS", "10")).statusCode).toBe(201);
  });

  it("raises a residual query when a valued field becomes skipped, and closes it on clear", async () => {
    expect(
      (await write("IG.MAIN", "IT.SMOKER", "N", { reasonForChange: "corrected" })).statusCode,
    ).toBe(201);
    const open = await openQueries();
    const residual = open.find((q) => q.checkOid === "SKIP.CD.NONSMOKER.IT.CIGS");
    expect(residual).toBeTruthy();

    // Clearing the skipped value stays allowed and resolves the query.
    expect(
      (await write("IG.MAIN", "IT.CIGS", null, { reasonForChange: "not collected" })).statusCode,
    ).toBe(201);
    const openAfter = await openQueries();
    expect(openAfter.find((q) => q.checkOid === "SKIP.CD.NONSMOKER.IT.CIGS")).toBeUndefined();
  });

  it("rejects writes into a group skipped at group level", async () => {
    expect(
      (await write("IG.MAIN", "IT.SEX", "M", { reasonForChange: "corrected" })).statusCode,
    ).toBe(201);
    const res = await write("IG.PREG", "IT.PREG", "NEG");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not collected/);
    expect(
      (await write("IG.MAIN", "IT.SEX", "F", { reasonForChange: "corrected" })).statusCode,
    ).toBe(201);
  });

  it("rejects a code list value excluded for the current responses", async () => {
    // Subject is female: the NA option is excluded.
    const res = await write("IG.PREG", "IT.PREG", "NA");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not available/);
    expect((await write("IG.PREG", "IT.PREG", "NEG")).statusCode).toBe(201);
  });

  it("applies item-level skips per repeating-group occurrence", async () => {
    expect((await write("IG.VS", "IT.HRMEAS", "true", { repeatKey: 1 })).statusCode).toBe(201);
    expect((await write("IG.VS", "IT.HR", "72", { repeatKey: 1 })).statusCode).toBe(201);
    expect((await write("IG.VS", "IT.HRMEAS", "false", { repeatKey: 2 })).statusCode).toBe(201);
    const res = await write("IG.VS", "IT.HR", "88", { repeatKey: 2 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not collected/);
  });
});
