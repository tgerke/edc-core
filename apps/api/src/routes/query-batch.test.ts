import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password.js";
import { grantRole } from "../auth/rbac.js";
import { createDb, databaseUrl } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import {
  auditEvents,
  formInstances,
  notifications,
  queries,
  roles,
  sites,
  snapshots,
  studies,
  users,
  workbenchExecutions,
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
  console.warn(`⚠ Skipping query batch tests: no database at ${databaseUrl()}.`);
}

// Two events share the vitals form so an eventOid-less target can be
// ambiguous for a subject with instances in both.
const ODM = `<ODM xmlns="http://www.cdisc.org/ns/odm/v2.0" FileOID="QB" FileType="Snapshot"
    ODMVersion="2.0" CreationDateTime="2026-07-21T00:00:00Z" Granularity="Metadata">
  <Study OID="ST.QB" StudyName="Batch Study">
    <MetaDataVersion OID="MDV.1" Name="v1">
      <StudyEventDef OID="SE.V1" Name="Visit 1" Repeating="No" Type="Scheduled">
        <ItemGroupRef ItemGroupOID="FO.VS" Mandatory="Yes"/>
      </StudyEventDef>
      <StudyEventDef OID="SE.V2" Name="Visit 2" Repeating="No" Type="Scheduled">
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
    </MetaDataVersion>
  </Study>
</ODM>`;

const PASSWORD = "correct-Horse-battery-7";

describe.skipIf(!dbAvailable)("batch query creation from listing rows", () => {
  let server: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const fx = {
    studyId: "",
    site1Id: "",
    site2Id: "",
    monitorToken: "",
    siteMonitorToken: "",
    entryToken: "",
    entryUserId: "",
    outsiderToken: "",
    lockedFormId: "",
    executionId: "",
  };

  async function makeUser(name: string, roleName: string | null, studyId: string, siteId?: string) {
    const [user] = await db
      .insert(users)
      .values({
        username: `${name}-${suffix}`,
        email: `${name}-${suffix}@example.com`,
        fullName: name,
        passwordHash: await hashPassword(PASSWORD),
      })
      .returning();
    if (!user) throw new Error("fixture failed");
    if (roleName) {
      const [role] = await db.select().from(roles).where(eq(roles.name, roleName));
      if (!role) throw new Error("fixture failed");
      await grantRole(db, {
        userId: user.id,
        studyId,
        roleId: role.id,
        ...(siteId ? { siteId } : {}),
        grantedBy: user.id,
      });
    }
    const token = (
      await server.inject({
        method: "POST",
        url: "/auth/login",
        payload: { username: `${name}-${suffix}`, password: PASSWORD },
      })
    ).json().token;
    return { user, token };
  }

  async function enrollWithForm(subjectKey: string, siteId: string, eventOid = "SE.V1") {
    const subject = (
      await server.inject({
        method: "POST",
        url: `/studies/${fx.studyId}/subjects`,
        payload: { siteId, subjectKey },
        headers: { authorization: `Bearer ${fx.entryToken}` },
      })
    ).json();
    const form = (
      await server.inject({
        method: "POST",
        url: `/subjects/${subject.id}/forms`,
        payload: { eventOid, formOid: "FO.VS" },
        headers: { authorization: `Bearer ${fx.entryToken}` },
      })
    ).json();
    return { subjectId: subject.id as string, formId: form.id as string };
  }

  beforeAll(async () => {
    await runMigrations();
    server = await buildServer({ db });
    await server.ready();

    const [study] = await db
      .insert(studies)
      .values({ oid: `ST.QB.${suffix}`, name: "Batch Study" })
      .returning();
    if (!study) throw new Error("fixture failed");
    fx.studyId = study.id;
    const [site1] = await db
      .insert(sites)
      .values({ studyId: study.id, oid: "SITE.1", name: "Site One" })
      .returning();
    const [site2] = await db
      .insert(sites)
      .values({ studyId: study.id, oid: "SITE.2", name: "Site Two" })
      .returning();
    if (!site1 || !site2) throw new Error("fixture failed");
    fx.site1Id = site1.id;
    fx.site2Id = site2.id;

    const monitor = await makeUser("mon", "monitor", study.id);
    const siteMonitor = await makeUser("site-mon", "monitor", study.id, site1.id);
    const entry = await makeUser("ent", "data_entry", study.id);
    const outsider = await makeUser("out", null, study.id);
    fx.monitorToken = monitor.token;
    fx.siteMonitorToken = siteMonitor.token;
    fx.entryToken = entry.token;
    fx.entryUserId = entry.user.id;
    fx.outsiderToken = outsider.token;

    const imported = await importStudyBuild(db, {
      studyId: study.id,
      content: ODM,
      actorId: monitor.user.id,
    });
    if (!imported.ok) throw new Error(`import failed: ${JSON.stringify(imported.issues)}`);

    // Q1-001 (site 1): values on file so stale detection has a live value.
    const q1 = await enrollWithForm("Q1-001", site1.id);
    for (const [itemOid, value] of [
      ["IT.SYSBP", "120"],
      ["IT.DIABP", "80"],
    ]) {
      const write = await server.inject({
        method: "PUT",
        url: `/forms/${q1.formId}/items`,
        payload: { itemGroupOid: "IG.VS", itemOid, value },
        headers: { authorization: `Bearer ${fx.entryToken}` },
      });
      if (write.statusCode !== 201) throw new Error(`value fixture failed: ${write.body}`);
    }

    // Q1-003 (site 1): the same form in two events → ambiguous without an
    // eventOid.
    const q3 = await enrollWithForm("Q1-003", site1.id);
    await server.inject({
      method: "POST",
      url: `/subjects/${q3.subjectId}/forms`,
      payload: { eventOid: "SE.V2", formOid: "FO.VS" },
      headers: { authorization: `Bearer ${fx.entryToken}` },
    });

    // Q1-004 (site 1): locked form (fixture shortcut; the transition
    // machinery has its own tests).
    const q4 = await enrollWithForm("Q1-004", site1.id);
    await db.update(formInstances).set({ status: "locked" }).where(eq(formInstances.id, q4.formId));
    fx.lockedFormId = q4.formId;

    // Q2-001 (site 2): out of the site-scoped monitor's reach.
    await enrollWithForm("Q2-001", site2.id);

    // A published snapshot and an execution to carry provenance.
    const [snapshot] = await db
      .insert(snapshots)
      .values({
        studyId: study.id,
        status: "published",
        schemaName: `study_st_qb_${suffix}`,
        lakeVersion: 7n,
        manifest: { schema: `study_st_qb_${suffix}`, tables: [] },
        createdBy: monitor.user.id,
      })
      .returning();
    if (!snapshot) throw new Error("fixture failed");
    const [execution] = await db
      .insert(workbenchExecutions)
      .values({
        studyId: study.id,
        snapshotId: snapshot.id,
        language: "sql",
        content: "SELECT subject_key FROM ig_vs WHERE it_sysbp > 100",
        status: "succeeded",
        elapsedMs: 12,
        executedBy: monitor.user.id,
      })
      .returning();
    if (!execution) throw new Error("fixture failed");
    fx.executionId = execution.id;
  });

  afterAll(async () => {
    await server.close();
    await client.end();
  });

  function batch(token: string, payload: object) {
    return server.inject({
      method: "POST",
      url: `/studies/${fx.studyId}/queries/batch`,
      payload,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  const listingTargets = [
    {
      subjectKey: "Q1-001",
      formOid: "FO.VS",
      eventOid: "SE.V1",
      itemGroupOid: "IG.VS",
      itemOid: "IT.SYSBP",
      snapshotValue: "120",
    },
    { subjectKey: "NOPE", formOid: "FO.VS" },
    { subjectKey: "Q1-001", formOid: "FO.VS", eventOid: "SE.V9" },
    { subjectKey: "Q1-003", formOid: "FO.VS" },
    { subjectKey: "Q1-003", formOid: "FO.VS", eventOid: "SE.V2" },
    { subjectKey: "Q1-001", formOid: "FO.VS", eventOid: "SE.V1", itemOid: "IT.NOPE" },
    { subjectKey: "Q1-004", formOid: "FO.VS", eventOid: "SE.V1" },
    {
      subjectKey: "Q1-001",
      formOid: "FO.VS",
      eventOid: "SE.V1",
      itemGroupOid: "IG.VS",
      itemOid: "IT.DIABP",
      snapshotValue: "999",
    },
  ];
  const expectedOutcomes = (create: "created" | "would_create") => [
    create,
    "skipped:subject_not_found",
    "skipped:event_not_found",
    "skipped:ambiguous_target",
    create,
    "skipped:unknown_item",
    "skipped:form_locked",
    "skipped:value_changed",
  ];
  const shape = (r: { outcome: string; reason?: string }) =>
    r.reason ? `${r.outcome}:${r.reason}` : r.outcome;

  it("previews with dryRun, then creates with identical resolution", async () => {
    const before = await db.select().from(queries).where(eq(queries.studyId, fx.studyId));

    const preview = await batch(fx.monitorToken, {
      dryRun: true,
      message: "Please verify against source",
      executionId: fx.executionId,
      targets: listingTargets,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().results.map(shape)).toEqual(expectedOutcomes("would_create"));

    // Dry run wrote nothing.
    const after = await db.select().from(queries).where(eq(queries.studyId, fx.studyId));
    expect(after.length).toBe(before.length);

    const real = await batch(fx.monitorToken, {
      message: "Please verify against source",
      executionId: fx.executionId,
      targets: listingTargets,
    });
    expect(real.statusCode).toBe(201);
    const body = real.json();
    expect(body.results.map(shape)).toEqual(expectedOutcomes("created"));
    expect(body.created).toBe(2);
    expect(body.skipped).toBe(6);

    // Provenance: row FK + audit event carry the execution and batch.
    const createdId = body.results[0].queryId as string;
    const [created] = await db.select().from(queries).where(eq(queries.id, createdId));
    expect(created?.sourceExecutionId).toBe(fx.executionId);
    expect(created?.origin).toBe("manual");
    expect(created?.itemOid).toBe("IT.SYSBP");
    const [opened] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "query.opened"), eq(auditEvents.entityId, createdId)));
    const provenance = (opened?.newValue as { provenance?: Record<string, unknown> }).provenance;
    expect(provenance?.batchId).toBe(body.batchId);
    expect(provenance?.sourceExecutionId).toBe(fx.executionId);
    expect(provenance?.lakeVersion).toBe("7");

    // One aggregate notification per affected site, not one per query.
    const bells = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, fx.entryUserId), eq(notifications.type, "query.opened")));
    const batchBells = bells.filter(
      (n) => (n.payload as { batchId?: string })?.batchId === body.batchId,
    );
    expect(batchBells.length).toBe(1);
    expect(batchBells[0]?.title).toContain("2 new queries");
  });

  it("dedups against open and answered queries on the same target", async () => {
    const target = listingTargets[0];
    const rerun = await batch(fx.monitorToken, { message: "again", targets: [target] });
    const [row] = rerun.json().results;
    expect(shape(row)).toBe("skipped:duplicate_open_query");
    expect(row.queryId).toBeTruthy();

    // An answered query still blocks a duplicate (checks.ts convention).
    await server.inject({
      method: "POST",
      url: `/queries/${row.queryId}/answer`,
      payload: { body: "Checked source, value is right" },
      headers: { authorization: `Bearer ${fx.entryToken}` },
    });
    const again = await batch(fx.monitorToken, { message: "again", targets: [target] });
    expect(shape(again.json().results[0])).toBe("skipped:duplicate_open_query");
  });

  it("force downgrades value_changed to created", async () => {
    const stale = listingTargets[7];
    const forced = await batch(fx.monitorToken, {
      message: "Verify diastolic",
      force: true,
      targets: [stale],
    });
    expect(shape(forced.json().results[0])).toBe("created");
  });

  it("checks query.manage per target site; membership gates the route", async () => {
    // Site-scoped monitor cannot reach the other site's subject.
    const crossSite = await batch(fx.siteMonitorToken, {
      message: "cross-site",
      targets: [{ subjectKey: "Q2-001", formOid: "FO.VS", eventOid: "SE.V1" }],
    });
    expect(shape(crossSite.json().results[0])).toBe("skipped:site_forbidden");

    // Members without query.manage anywhere get skips, not queries.
    const entry = await batch(fx.entryToken, {
      message: "entry",
      targets: [{ subjectKey: "Q1-001", formOid: "FO.VS", eventOid: "SE.V1" }],
    });
    expect(shape(entry.json().results[0])).toBe("skipped:site_forbidden");

    // Non-members are rejected outright.
    const outsider = await batch(fx.outsiderToken, {
      message: "outsider",
      targets: [{ subjectKey: "Q1-001", formOid: "FO.VS", eventOid: "SE.V1" }],
    });
    expect(outsider.statusCode).toBe(403);
  });

  it("rejects foreign executions and oversized batches", async () => {
    const foreign = await batch(fx.monitorToken, {
      message: "x",
      executionId: randomUUID(),
      targets: [{ subjectKey: "Q1-001", formOid: "FO.VS", eventOid: "SE.V1" }],
    });
    expect(foreign.statusCode).toBe(404);

    const oversized = await batch(fx.monitorToken, {
      message: "x",
      targets: Array.from({ length: 501 }, (_, i) => ({
        subjectKey: `S-${i}`,
        formOid: "FO.VS",
      })),
    });
    expect(oversized.statusCode).toBe(400);
  });
});
