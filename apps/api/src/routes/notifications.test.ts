import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password.js";
import { grantRole } from "../auth/rbac.js";
import { createDb, databaseUrl } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import {
  notifications,
  roles,
  sites,
  studies,
  studyEventInstances,
  users,
} from "../db/schema/index.js";
import { buildServer } from "../server.js";
import { importStudyBuild } from "../services/study-builds.js";
import { dispatchEmails, scanOverdueForms } from "../worker/scheduler.js";

const { db, client } = createDb();
let dbAvailable = false;
try {
  await client`SELECT 1`;
  dbAvailable = true;
} catch {
  if (process.env.CI) throw new Error(`CI requires a reachable database at ${databaseUrl()}`);
  console.warn(`⚠ Skipping notification tests: no database at ${databaseUrl()}.`);
}

// CHK.HR fires above 220 so a single write can open a *system* query.
const ODM = `<ODM xmlns="http://www.cdisc.org/ns/odm/v2.0" FileOID="NTF" FileType="Snapshot"
    ODMVersion="2.0" CreationDateTime="2026-07-10T00:00:00Z" Granularity="Metadata">
  <Study OID="ST.NTF" StudyName="Notification Study">
    <MetaDataVersion OID="MDV.1" Name="v1">
      <StudyEventDef OID="SE.V1" Name="Visit 1" Repeating="No" Type="Scheduled">
        <ItemGroupRef ItemGroupOID="FO.VS" Mandatory="Yes"/>
      </StudyEventDef>
      <ItemGroupDef OID="FO.VS" Name="Vital Signs" Type="Form" Repeating="No">
        <ItemGroupRef ItemGroupOID="IG.VS" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemGroupDef OID="IG.VS" Name="Vitals" Type="Section" Repeating="No">
        <ItemRef ItemOID="IT.HR" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemDef OID="IT.HR" Name="Heart rate" DataType="integer"/>
      <ConditionDef OID="CHK.HR" Name="HR plausible">
        <Description><TranslatedText xml:lang="en" Type="text/plain">Heart rate above 220.</TranslatedText></Description>
        <FormalExpression Context="jsonata">\`IT.HR\` != null and \`IT.HR\` &gt; 220</FormalExpression>
      </ConditionDef>
    </MetaDataVersion>
  </Study>
</ODM>`;

const PASSWORD = "correct-Horse-battery-7";

describe.skipIf(!dbAvailable)("notifications (integration)", () => {
  let server: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const fx = {
    studyId: "",
    subjectId: "",
    formId: "",
    dm: { id: "", token: "" },
    inv: { id: "", token: "" },
    inv2: { id: "", token: "" },
    invOtherSite: { id: "", token: "" },
  };
  const allUserIds = () => [fx.dm.id, fx.inv.id, fx.inv2.id, fx.invOtherSite.id];

  async function makeUser(name: string, roleName: string, studyId: string, siteId?: string) {
    const [user] = await db
      .insert(users)
      .values({
        username: `${name}-${suffix}`,
        email: `${name}-${suffix}@example.com`,
        fullName: `Dr ${name}`,
        passwordHash: await hashPassword(PASSWORD),
      })
      .returning();
    const [role] = await db.select().from(roles).where(eq(roles.name, roleName));
    if (!user || !role) throw new Error("fixture failed");
    await grantRole(db, {
      userId: user.id,
      studyId,
      roleId: role.id,
      grantedBy: user.id,
      ...(siteId ? { siteId } : {}),
    });
    const token = (
      await server.inject({
        method: "POST",
        url: "/auth/login",
        payload: { username: `${name}-${suffix}`, password: PASSWORD },
      })
    ).json().token;
    return { id: user.id, token };
  }

  async function myNotifications(userId: string) {
    return db
      .select()
      .from(notifications)
      .where(and(eq(notifications.studyId, fx.studyId), eq(notifications.userId, userId)));
  }

  beforeAll(async () => {
    await runMigrations();
    server = await buildServer({ db });
    await server.ready();

    const [study] = await db
      .insert(studies)
      .values({ oid: `ST.NTF.${suffix}`, name: "Notification Study" })
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

    fx.dm = await makeUser("nt-dm", "data_manager", study.id);
    fx.inv = await makeUser("nt-inv", "investigator", study.id, siteA.id);
    fx.inv2 = await makeUser("nt-inv2", "investigator", study.id, siteA.id);
    fx.invOtherSite = await makeUser("nt-inv3", "investigator", study.id, siteB.id);

    const imported = await importStudyBuild(db, {
      studyId: study.id,
      content: ODM,
      actorId: fx.dm.id,
    });
    if (!imported.ok) throw new Error("import failed");

    const subject = (
      await server.inject({
        method: "POST",
        url: `/studies/${study.id}/subjects`,
        payload: { siteId: siteA.id, subjectKey: "S-001" },
        headers: { authorization: `Bearer ${fx.inv.token}` },
      })
    ).json();
    fx.subjectId = subject.id;
    fx.formId = (
      await server.inject({
        method: "POST",
        url: `/subjects/${subject.id}/forms`,
        payload: { eventOid: "SE.V1", formOid: "FO.VS" },
        headers: { authorization: `Bearer ${fx.inv.token}` },
      })
    ).json().id;
  });

  afterAll(async () => {
    await server.close();
    await client.end();
  });

  it("system queries from edit checks emit no notifications", async () => {
    const res = await server.inject({
      method: "PUT",
      url: `/forms/${fx.formId}/items`,
      payload: { itemGroupOid: "IG.VS", itemOid: "IT.HR", value: "250" },
      headers: { authorization: `Bearer ${fx.inv.token}` },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().findings).toHaveLength(1);

    const rows = await db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.studyId, fx.studyId), inArray(notifications.userId, allUserIds())),
      );
    expect(rows).toHaveLength(0);
  });

  it("manual query open notifies site query.answer holders, not the actor or other sites", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/forms/${fx.formId}/queries`,
      payload: { itemOid: "IT.HR", body: "Please confirm this heart rate." },
      headers: { authorization: `Bearer ${fx.dm.token}` },
    });
    expect(res.statusCode).toBe(201);

    const invRows = await myNotifications(fx.inv.id);
    expect(invRows).toHaveLength(1);
    expect(invRows[0]).toMatchObject({ type: "query.opened", title: "New query on S-001" });
    expect((await myNotifications(fx.inv2.id)).map((n) => n.type)).toEqual(["query.opened"]);
    expect(await myNotifications(fx.dm.id)).toHaveLength(0);
    expect(await myNotifications(fx.invOtherSite.id)).toHaveLength(0);
  });

  it("answering notifies query.manage holders", async () => {
    const [query] = (
      await server.inject({
        method: "GET",
        url: `/forms/${fx.formId}/queries`,
        headers: { authorization: `Bearer ${fx.inv.token}` },
      })
    )
      .json()
      .filter((q: { origin: string }) => q.origin === "manual");
    const res = await server.inject({
      method: "POST",
      url: `/queries/${query.id}/answer`,
      payload: { body: "Confirmed with a second reading." },
      headers: { authorization: `Bearer ${fx.inv.token}` },
    });
    expect(res.statusCode).toBe(200);

    const dmRows = await myNotifications(fx.dm.id);
    expect(dmRows).toHaveLength(1);
    expect(dmRows[0]).toMatchObject({ type: "query.answered", title: "Query answered on S-001" });
  });

  it("completing a form notifies signers at the site, excluding the actor", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/forms/${fx.formId}/status`,
      payload: { action: "complete" },
      headers: { authorization: `Bearer ${fx.inv.token}` },
    });
    expect(res.statusCode).toBe(200);

    const inv2Types = (await myNotifications(fx.inv2.id)).map((n) => n.type).sort();
    expect(inv2Types).toEqual(["form.awaiting_signature", "query.opened"]);
    // The actor holds data.sign too but performed the transition.
    expect((await myNotifications(fx.inv.id)).map((n) => n.type)).toEqual(["query.opened"]);
    expect(await myNotifications(fx.invOtherSite.id)).toHaveLength(0);
  });

  it("self-scoped inbox: list, unread count, mark read, mark all", async () => {
    const count = (
      await server.inject({
        method: "GET",
        url: "/notifications/unread-count",
        headers: { authorization: `Bearer ${fx.inv2.token}` },
      })
    ).json();
    expect(count.count).toBe(2);

    const list = (
      await server.inject({
        method: "GET",
        url: "/notifications?unread=true",
        headers: { authorization: `Bearer ${fx.inv2.token}` },
      })
    ).json();
    expect(list).toHaveLength(2);

    // Someone else's notification id is invisible to me.
    const foreign = await server.inject({
      method: "POST",
      url: `/notifications/${list[0].id}/read`,
      headers: { authorization: `Bearer ${fx.inv.token}` },
    });
    expect(foreign.statusCode).toBe(404);

    const mine = await server.inject({
      method: "POST",
      url: `/notifications/${list[0].id}/read`,
      headers: { authorization: `Bearer ${fx.inv2.token}` },
    });
    expect(mine.statusCode).toBe(200);

    const all = await server.inject({
      method: "POST",
      url: "/notifications/read-all",
      headers: { authorization: `Bearer ${fx.inv2.token}` },
    });
    expect(all.json().marked).toBe(1);
    const after = (
      await server.inject({
        method: "GET",
        url: "/notifications/unread-count",
        headers: { authorization: `Bearer ${fx.inv2.token}` },
      })
    ).json();
    expect(after.count).toBe(0);
  });

  it("overdue scan notifies once per form per user, and 0 days disables it", async () => {
    // The dev database is shared across concurrently-running test files and
    // accumulates their debris, so both the scan and the backdate below are
    // confined to this study — an unscoped scan walks every leftover form.
    const scanScope = { studyId: fx.studyId };
    const myOverdue = async (userId: string) =>
      (await myNotifications(userId)).filter((n) => n.type === "form.overdue");

    expect(await scanOverdueForms(db, 0, scanScope)).toBe(0);
    await scanOverdueForms(db, 1, scanScope);
    // Nothing in this study is a day old yet.
    expect(await myOverdue(fx.inv.id)).toHaveLength(0);

    // Backdate the event instance (operational row, deliberately mutable).
    await db
      .update(studyEventInstances)
      .set({ createdAt: new Date(Date.now() - 3 * 86_400_000) })
      .where(
        and(
          eq(studyEventInstances.subjectId, fx.subjectId),
          eq(studyEventInstances.eventOid, "SE.V1"),
        ),
      );
    // Reopen so the form counts as in_progress again.
    await server.inject({
      method: "POST",
      url: `/forms/${fx.formId}/status`,
      payload: { action: "reopen" },
      headers: { authorization: `Bearer ${fx.inv.token}` },
    });

    await scanOverdueForms(db, 1, scanScope);
    const invOverdue = await myOverdue(fx.inv.id);
    expect(invOverdue).toHaveLength(1);
    expect(invOverdue[0]?.dedupeKey).toBe(fx.formId);

    await scanOverdueForms(db, 1, scanScope); // dedupe: re-scan is a no-op
    expect(await myOverdue(fx.inv.id)).toHaveLength(1);

    // Cross-site isolation for the scan too.
    expect(await myOverdue(fx.invOtherSite.id)).toHaveLength(0);
  });

  it("email outbox sends pending mail once and caps failed attempts", async () => {
    const sentTo: string[] = [];
    const transport = {
      sendMail: async (mail: { to: string }) => {
        if (mail.to.startsWith(`nt-inv2-`)) throw new Error("mailbox on fire");
        sentTo.push(mail.to);
      },
    };
    const config = { from: "edc <no-reply@test>", baseUrl: "http://localhost:5173" };

    // The outbox pool is shared with concurrently-running test files and
    // dispatch reads it in LIMIT-200 windows, so drain it rather than assume
    // one pass covers this study's rows.
    for (let i = 0; i < 20; i++) {
      if ((await dispatchEmails(db, transport, config)) === 0) break;
    }
    const invRows = await myNotifications(fx.inv.id);
    expect(invRows.every((n) => n.emailedAt !== null)).toBe(true);
    expect(sentTo).toContain(`nt-inv-${suffix}@example.com`);

    // Failures increment attempts and are retried on later ticks, capped at 3.
    for (let i = 0; i < 4; i++) await dispatchEmails(db, transport, config);
    const inv2Rows = await myNotifications(fx.inv2.id);
    expect(inv2Rows.every((n) => n.emailedAt === null)).toBe(true);
    expect(inv2Rows.every((n) => n.emailAttempts === 3)).toBe(true);
  });
});
