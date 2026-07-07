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
  console.warn(`⚠ Skipping query lifecycle tests: no database at ${databaseUrl()}.`);
}

const ODM = `<ODM xmlns="http://www.cdisc.org/ns/odm/v2.0" FileOID="QRY" FileType="Snapshot"
    ODMVersion="2.0" CreationDateTime="2026-07-05T00:00:00Z" Granularity="Metadata">
  <Study OID="ST.QRY" StudyName="Query Study">
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

describe.skipIf(!dbAvailable)("manual query lifecycle", () => {
  let server: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const fx = {
    studyId: "",
    formId: "",
    monitorToken: "",
    entryToken: "",
    queryId: "",
  };

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
      .values({ oid: `ST.QRY.${suffix}`, name: "Query Study" })
      .returning();
    if (!study) throw new Error("fixture failed");
    fx.studyId = study.id;
    const [site] = await db
      .insert(sites)
      .values({ studyId: study.id, oid: "SITE.1", name: "Site" })
      .returning();
    if (!site) throw new Error("fixture failed");

    const monitor = await makeUser("mon", "monitor", study.id);
    const entry = await makeUser("ent", "data_entry", study.id);
    fx.monitorToken = monitor.token;
    fx.entryToken = entry.token;

    const imported = await importStudyBuild(db, {
      studyId: study.id,
      content: ODM,
      actorId: monitor.user.id,
    });
    if (!imported.ok) throw new Error(`import failed: ${JSON.stringify(imported.issues)}`);

    const subject = (
      await server.inject({
        method: "POST",
        url: `/studies/${study.id}/subjects`,
        payload: { siteId: site.id, subjectKey: "Q-001" },
        headers: { authorization: `Bearer ${fx.entryToken}` },
      })
    ).json();
    fx.formId = (
      await server.inject({
        method: "POST",
        url: `/subjects/${subject.id}/forms`,
        payload: { eventOid: "SE.V1", formOid: "FO.VS" },
        headers: { authorization: `Bearer ${fx.entryToken}` },
      })
    ).json().id;
  });

  afterAll(async () => {
    await server.close();
    await client.end();
  });

  function act(token: string, method: "GET" | "POST" | "PUT", url: string, payload?: object) {
    return server.inject({
      method,
      url,
      ...(payload ? { payload } : {}),
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it("monitor opens a manual query on an item; data entry cannot", async () => {
    const denied = await act(fx.entryToken, "POST", `/forms/${fx.formId}/queries`, {
      itemGroupOid: "IG.VS",
      itemOid: "IT.SYSBP",
      body: "Please confirm the systolic reading against source.",
    });
    expect(denied.statusCode).toBe(403);

    const res = await act(fx.monitorToken, "POST", `/forms/${fx.formId}/queries`, {
      itemGroupOid: "IG.VS",
      itemOid: "IT.SYSBP",
      body: "Please confirm the systolic reading against source.",
    });
    expect(res.statusCode).toBe(201);
    fx.queryId = res.json().id;
    expect(res.json().origin).toBe("manual");
    expect(res.json().status).toBe("open");
  });

  it("threads are listed on the form with opener and messages", async () => {
    const res = await act(fx.entryToken, "GET", `/forms/${fx.formId}/queries`);
    expect(res.statusCode).toBe(200);
    const thread = res.json().find((q: { id: string }) => q.id === fx.queryId);
    expect(thread.itemOid).toBe("IT.SYSBP");
    expect(thread.openedBy).toBe(`mon-${suffix}`);
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0].body).toMatch(/confirm the systolic/);
  });

  it("data entry answers; monitor cannot answer (no query.answer)", async () => {
    const denied = await act(fx.monitorToken, "POST", `/queries/${fx.queryId}/answer`, {
      body: "should be denied",
    });
    expect(denied.statusCode).toBe(403);

    const res = await act(fx.entryToken, "POST", `/queries/${fx.queryId}/answer`, {
      body: "Confirmed against source: 128 mmHg.",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("answered");

    const again = await act(fx.entryToken, "POST", `/queries/${fx.queryId}/answer`, {
      body: "double answer",
    });
    expect(again.statusCode).toBe(409);
  });

  it("monitor reopens an unsatisfying answer, then closes after a second answer", async () => {
    const reopened = await act(fx.monitorToken, "POST", `/queries/${fx.queryId}/reopen`, {
      body: "Source document not attached — please re-check.",
    });
    expect(reopened.json().status).toBe("open");

    await act(fx.entryToken, "POST", `/queries/${fx.queryId}/answer`, {
      body: "Re-checked; source uploaded.",
    });
    const closed = await act(fx.monitorToken, "POST", `/queries/${fx.queryId}/close`, {
      body: "Resolved, thank you.",
    });
    expect(closed.json().status).toBe("closed");
    expect(closed.json().closedAt).toBeTruthy();

    const reclose = await act(fx.monitorToken, "POST", `/queries/${fx.queryId}/close`, {});
    expect(reclose.statusCode).toBe(409);
  });

  it("audits every transition", async () => {
    const trail = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityType, "query"), eq(auditEvents.entityId, fx.queryId)));
    expect(trail.map((e) => e.action).sort()).toEqual([
      "query.answered",
      "query.answered",
      "query.closed",
      "query.opened",
      "query.reopened",
    ]);
  });

  it("study-level listing returns context and honors status filter", async () => {
    const all = await act(fx.monitorToken, "GET", `/studies/${fx.studyId}/queries`);
    expect(all.statusCode).toBe(200);
    const row = all.json().find((q: { id: string }) => q.id === fx.queryId);
    expect(row.subjectKey).toBe("Q-001");
    expect(row.formOid).toBe("FO.VS");
    expect(row.messages).toHaveLength(5);

    const open = await act(fx.monitorToken, "GET", `/studies/${fx.studyId}/queries?status=open`);
    expect(open.json().find((q: { id: string }) => q.id === fx.queryId)).toBeUndefined();
  });

  it("an answered system query is not duplicated while its check still fires", async () => {
    const write = (itemOid: string, value: string, reasonForChange?: string) =>
      act(fx.entryToken, "PUT", `/forms/${fx.formId}/items`, {
        itemGroupOid: "IG.VS",
        itemOid,
        value,
        ...(reasonForChange ? { reasonForChange } : {}),
      });
    await write("IT.SYSBP", "80");
    await write("IT.DIABP", "95");

    const [systemQuery] = await db
      .select()
      .from(queries)
      .where(
        and(
          eq(queries.formInstanceId, fx.formId),
          eq(queries.origin, "system"),
          eq(queries.status, "open"),
        ),
      );
    expect(systemQuery).toBeTruthy();
    if (!systemQuery) throw new Error("system query missing");

    const answered = await act(fx.entryToken, "POST", `/queries/${systemQuery.id}/answer`, {
      body: "Values transcribed correctly from device.",
    });
    expect(answered.statusCode).toBe(200);

    // Another write with the problem persisting must not open a second query.
    await write("IT.DIABP", "96", "re-measured");
    const systemQueries = await db
      .select()
      .from(queries)
      .where(and(eq(queries.formInstanceId, fx.formId), eq(queries.origin, "system")));
    expect(systemQueries).toHaveLength(1);

    // Fixing the data auto-closes even from answered.
    await write("IT.SYSBP", "128", "transcription error");
    const [after] = await db.select().from(queries).where(eq(queries.id, systemQuery.id));
    expect(after?.status).toBe("closed");
  });

  it("exposes effective permissions for UI gating", async () => {
    const res = await act(fx.monitorToken, "GET", `/studies/${fx.studyId}/permissions`);
    expect(res.json().permissions).toContain("query.manage");
    expect(res.json().permissions).not.toContain("data.enter");

    const entry = await act(fx.entryToken, "GET", `/studies/${fx.studyId}/permissions`);
    expect(entry.json().permissions).toContain("query.answer");
    expect(entry.json().permissions).not.toContain("query.manage");
  });
});
