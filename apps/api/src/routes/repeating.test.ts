import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password.js";
import { grantRole } from "../auth/rbac.js";
import { createDb, databaseUrl } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { queries, roles, sites, studies, users } from "../db/schema/index.js";
import { buildServer } from "../server.js";
import { importStudyBuild } from "../services/study-builds.js";

const { db, client } = createDb();
let dbAvailable = false;
try {
  await client`SELECT 1`;
  dbAvailable = true;
} catch {
  if (process.env.CI) throw new Error(`CI requires a reachable database at ${databaseUrl()}`);
  console.warn(`⚠ Skipping repeating-group tests: no database at ${databaseUrl()}.`);
}

/** IG.VS repeats; the BP-inverted check must attribute findings per occurrence. */
const REPEATING_ODM = `<ODM xmlns="http://www.cdisc.org/ns/odm/v2.0" FileOID="RPT" FileType="Snapshot"
    ODMVersion="2.0" CreationDateTime="2026-07-07T00:00:00Z" Granularity="Metadata">
  <Study OID="ST.RPT" StudyName="Repeating Study">
    <MetaDataVersion OID="MDV.1" Name="v1">
      <StudyEventDef OID="SE.V1" Name="Visit 1" Repeating="No" Type="Scheduled">
        <ItemGroupRef ItemGroupOID="FO.VS" Mandatory="Yes"/>
      </StudyEventDef>
      <ItemGroupDef OID="FO.VS" Name="Vital Signs" Type="Form" Repeating="No">
        <ItemGroupRef ItemGroupOID="IG.VS" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemGroupDef OID="IG.VS" Name="Blood Pressure" Type="Section" Repeating="Simple">
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

describe.skipIf(!dbAvailable)("repeating item-group capture", () => {
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
        username: `rpt-${suffix}`,
        email: `rpt-${suffix}@example.com`,
        fullName: "Repeater",
        passwordHash: await hashPassword(PASSWORD),
      })
      .returning();
    const [study] = await db
      .insert(studies)
      .values({ oid: `ST.RPT.${suffix}`, name: "Repeating Study" })
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
      content: REPEATING_ODM,
      actorId: user.id,
    });
    if (!imported.ok) throw new Error(`import failed: ${JSON.stringify(imported.issues)}`);

    fx.token = (
      await server.inject({
        method: "POST",
        url: "/auth/login",
        payload: { username: `rpt-${suffix}`, password: PASSWORD },
      })
    ).json().token;

    const subject = (
      await server.inject({
        method: "POST",
        url: `/studies/${study.id}/subjects`,
        payload: { siteId: site.id, subjectKey: "R-001" },
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

  function write(repeatKey: number, itemOid: string, value: string, reasonForChange?: string) {
    return server.inject({
      method: "PUT",
      url: `/forms/${fx.formId}/items`,
      payload: {
        itemGroupOid: "IG.VS",
        itemGroupRepeatKey: repeatKey,
        itemOid,
        value,
        ...(reasonForChange ? { reasonForChange } : {}),
      },
      headers: { authorization: `Bearer ${fx.token}` },
    });
  }

  it("stores values independently per occurrence", async () => {
    await write(1, "IT.SYSBP", "120");
    await write(1, "IT.DIABP", "80");
    await write(2, "IT.SYSBP", "118");
    const res = await write(2, "IT.DIABP", "76");
    expect(res.statusCode).toBe(201);

    const form = (
      await server.inject({
        method: "GET",
        url: `/forms/${fx.formId}`,
        headers: { authorization: `Bearer ${fx.token}` },
      })
    ).json();
    const byKey = new Map(
      form.values.map((v: { item_group_repeat_key: number; item_oid: string; value: string }) => [
        `${v.item_group_repeat_key}:${v.item_oid}`,
        v.value,
      ]),
    );
    expect(byKey.get("1:IT.SYSBP")).toBe("120");
    expect(byKey.get("2:IT.SYSBP")).toBe("118");
    expect(byKey.get("2:IT.DIABP")).toBe("76");
  });

  it("attributes a firing check to its occurrence and opens one query for it", async () => {
    const res = await write(2, "IT.DIABP", "130", "corrected reading");
    expect(res.json().findings).toEqual([
      {
        checkOid: "CHECK.BP_INVERTED",
        message: "Systolic BP must exceed diastolic BP",
        repeatKey: 2,
      },
    ]);

    const open = await db
      .select()
      .from(queries)
      .where(and(eq(queries.formInstanceId, fx.formId), eq(queries.status, "open")));
    expect(open).toHaveLength(1);
    expect(open[0]?.checkOid).toBe("CHECK.BP_INVERTED");
    expect(open[0]?.itemGroupRepeatKey).toBe(2);
  });

  it("keeps the occurrence query while the problem persists, without duplicates", async () => {
    const res = await write(2, "IT.DIABP", "131", "re-measured");
    expect(res.json().findings).toHaveLength(1);
    const open = await db
      .select()
      .from(queries)
      .where(and(eq(queries.formInstanceId, fx.formId), eq(queries.status, "open")));
    expect(open).toHaveLength(1);
  });

  it("can fire the same check in another occurrence as a separate query", async () => {
    const res = await write(1, "IT.DIABP", "125", "corrected reading");
    expect(res.json().findings.map((f: { repeatKey: number | null }) => f.repeatKey)).toEqual([
      1, 2,
    ]);
    const open = await db
      .select()
      .from(queries)
      .where(and(eq(queries.formInstanceId, fx.formId), eq(queries.status, "open")));
    expect(open.map((q) => q.itemGroupRepeatKey).sort()).toEqual([1, 2]);
  });

  it("auto-closes only the fixed occurrence's query", async () => {
    const res = await write(2, "IT.DIABP", "76", "transcription error");
    expect(res.json().findings.map((f: { repeatKey: number | null }) => f.repeatKey)).toEqual([1]);

    const open = await db
      .select()
      .from(queries)
      .where(and(eq(queries.formInstanceId, fx.formId), eq(queries.status, "open")));
    expect(open).toHaveLength(1);
    expect(open[0]?.itemGroupRepeatKey).toBe(1);
  });
});
