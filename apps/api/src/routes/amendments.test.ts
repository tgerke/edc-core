import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password.js";
import { grantRole } from "../auth/rbac.js";
import { createDb, databaseUrl } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import {
  auditEvents,
  migrationRuns,
  queries,
  roles,
  sites,
  studies,
  studyMetadataVersions,
  users,
} from "../db/schema/index.js";
import { buildServer } from "../server.js";
import { runMigrationDriver } from "../services/amendments.js";
import { importStudyBuild } from "../services/study-builds.js";

const { db, client } = createDb();
let dbAvailable = false;
try {
  await client`SELECT 1`;
  dbAvailable = true;
} catch {
  if (process.env.CI) throw new Error(`CI requires a reachable database at ${databaseUrl()}`);
  console.warn(`⚠ Skipping amendment tests: no database at ${databaseUrl()}.`);
}

/**
 * v1: items IT.HR + IT.WT; CHK.HR fires above 220; CHK.WT fires above 500.
 * v2 (the amendment): removes IT.WT and CHK.WT, tightens CHK.HR to fire
 * above 200, and adds IT.BMI.
 */
function odm(version: 1 | 2): string {
  const items =
    version === 1
      ? `<ItemRef ItemOID="IT.HR" Mandatory="Yes"/><ItemRef ItemOID="IT.WT" Mandatory="No"/>`
      : `<ItemRef ItemOID="IT.HR" Mandatory="Yes"/><ItemRef ItemOID="IT.BMI" Mandatory="No"/>`;
  const defs =
    version === 1
      ? `<ItemDef OID="IT.HR" Name="Heart rate" DataType="integer"/>
         <ItemDef OID="IT.WT" Name="Weight" DataType="integer"/>`
      : `<ItemDef OID="IT.HR" Name="Heart rate" DataType="integer"/>
         <ItemDef OID="IT.BMI" Name="BMI" DataType="float"/>`;
  const checks =
    version === 1
      ? `<ConditionDef OID="CHK.HR" Name="HR plausible">
           <Description><TranslatedText xml:lang="en" Type="text/plain">Heart rate above 220.</TranslatedText></Description>
           <FormalExpression Context="jsonata">\`IT.HR\` != null and \`IT.HR\` &gt; 220</FormalExpression>
         </ConditionDef>
         <ConditionDef OID="CHK.WT" Name="Weight plausible">
           <Description><TranslatedText xml:lang="en" Type="text/plain">Weight above 500.</TranslatedText></Description>
           <FormalExpression Context="jsonata">\`IT.WT\` != null and \`IT.WT\` &gt; 500</FormalExpression>
         </ConditionDef>`
      : `<ConditionDef OID="CHK.HR" Name="HR plausible">
           <Description><TranslatedText xml:lang="en" Type="text/plain">Heart rate above 200.</TranslatedText></Description>
           <FormalExpression Context="jsonata">\`IT.HR\` != null and \`IT.HR\` &gt; 200</FormalExpression>
         </ConditionDef>`;
  return `<ODM xmlns="http://www.cdisc.org/ns/odm/v2.0" FileOID="AMD${version}" FileType="Snapshot"
      ODMVersion="2.0" CreationDateTime="2026-07-10T00:00:00Z" Granularity="Metadata">
    <Study OID="ST.AMD" StudyName="Amendment Study">
      <MetaDataVersion OID="MDV.${version}" Name="v${version}">
        <StudyEventDef OID="SE.V1" Name="Visit 1" Repeating="No" Type="Scheduled">
          <ItemGroupRef ItemGroupOID="FO.VS" Mandatory="Yes"/>
        </StudyEventDef>
        <ItemGroupDef OID="FO.VS" Name="Vital Signs" Type="Form" Repeating="No">
          <ItemGroupRef ItemGroupOID="IG.VS" Mandatory="Yes"/>
        </ItemGroupDef>
        <ItemGroupDef OID="IG.VS" Name="Vitals" Type="Section" Repeating="No">
          ${items}
        </ItemGroupDef>
        ${defs}
        ${checks}
      </MetaDataVersion>
    </Study>
  </ODM>`;
}

const PASSWORD = "correct-Horse-battery-7";

describe.skipIf(!dbAvailable)("amendment migration (integration)", () => {
  let server: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const fx = {
    studyId: "",
    token: "",
    userId: "",
    signedFormId: "",
    inFlightFormId: "",
    username: `amd-admin-${suffix}`,
  };

  function inject(opts: { method: "GET" | "POST" | "PUT"; url: string; payload?: object }) {
    return server.inject({
      ...opts,
      headers: { authorization: `Bearer ${fx.token}` },
    });
  }

  async function pollRun(runId: string) {
    for (let i = 0; i < 100; i++) {
      const res = await inject({
        method: "GET",
        url: `/studies/${fx.studyId}/migrations/${runId}`,
      });
      const run = res.json();
      if (run.status !== "running") return run;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("migration run did not finish in time");
  }

  beforeAll(async () => {
    await runMigrations();
    server = await buildServer({ db });
    await server.ready();

    const [study] = await db
      .insert(studies)
      .values({ oid: `ST.AMD.${suffix}`, name: "Amendment Study" })
      .returning();
    if (!study) throw new Error("fixture failed");
    fx.studyId = study.id;
    const [site] = await db
      .insert(sites)
      .values({ studyId: study.id, oid: "SITE.1", name: "Site" })
      .returning();
    const [user] = await db
      .insert(users)
      .values({
        username: fx.username,
        email: `${fx.username}@example.com`,
        fullName: "Dr Admin",
        passwordHash: await hashPassword(PASSWORD),
      })
      .returning();
    const [role] = await db.select().from(roles).where(eq(roles.name, "admin"));
    if (!site || !user || !role) throw new Error("fixture failed");
    fx.userId = user.id;
    await grantRole(db, {
      userId: user.id,
      studyId: study.id,
      roleId: role.id,
      grantedBy: user.id,
    });
    fx.token = (
      await server.inject({
        method: "POST",
        url: "/auth/login",
        payload: { username: fx.username, password: PASSWORD },
      })
    ).json().token;

    const v1 = await importStudyBuild(db, { studyId: study.id, content: odm(1), actorId: user.id });
    if (!v1.ok) throw new Error("v1 import failed");

    // Subject 1: enter data, complete, sign — must stay pinned to v1.
    const s1 = (
      await inject({
        method: "POST",
        url: `/studies/${study.id}/subjects`,
        payload: { siteId: site.id, subjectKey: "S-001" },
      })
    ).json();
    fx.signedFormId = (
      await inject({
        method: "POST",
        url: `/subjects/${s1.id}/forms`,
        payload: { eventOid: "SE.V1", formOid: "FO.VS" },
      })
    ).json().id;
    await inject({
      method: "PUT",
      url: `/forms/${fx.signedFormId}/items`,
      payload: { itemGroupOid: "IG.VS", itemOid: "IT.HR", value: "72" },
    });
    await inject({
      method: "POST",
      url: `/forms/${fx.signedFormId}/status`,
      payload: { action: "complete" },
    });
    const signed = await inject({
      method: "POST",
      url: `/forms/${fx.signedFormId}/sign`,
      payload: { username: fx.username, password: PASSWORD, meaning: "Investigator approval" },
    });
    if (signed.statusCode !== 201) throw new Error(`sign failed: ${signed.body}`);

    // Subject 2: in flight. HR=210 passes the v1 check (fires only under
    // v2's tightened bound); WT=600 fires v1's CHK.WT (removed in v2).
    const s2 = (
      await inject({
        method: "POST",
        url: `/studies/${study.id}/subjects`,
        payload: { siteId: site.id, subjectKey: "S-002" },
      })
    ).json();
    fx.inFlightFormId = (
      await inject({
        method: "POST",
        url: `/subjects/${s2.id}/forms`,
        payload: { eventOid: "SE.V1", formOid: "FO.VS" },
      })
    ).json().id;
    await inject({
      method: "PUT",
      url: `/forms/${fx.inFlightFormId}/items`,
      payload: { itemGroupOid: "IG.VS", itemOid: "IT.HR", value: "210" },
    });
    await inject({
      method: "PUT",
      url: `/forms/${fx.inFlightFormId}/items`,
      payload: { itemGroupOid: "IG.VS", itemOid: "IT.WT", value: "600" },
    });

    const v2 = await importStudyBuild(db, { studyId: study.id, content: odm(2), actorId: user.id });
    if (!v2.ok) throw new Error("v2 import failed");
  });

  afterAll(async () => {
    await server.close();
    await client.end();
  });

  it("blocks direct mutation of published builds at the database level", async () => {
    // Drizzle wraps the postgres error; the trigger message is in the cause.
    const rejection = await db
      .execute(
        sql`UPDATE study_metadata_versions SET note = 'tampered' WHERE study_id = ${fx.studyId}`,
      )
      .then(() => null)
      .catch((err: unknown) => {
        for (let e: unknown = err; e instanceof Error; e = e.cause) {
          if (/append-only/.test(e.message)) return e.message;
        }
        return "wrong error";
      });
    expect(rejection).toMatch(/append-only/);
  });

  it("diffs two builds", async () => {
    const res = await inject({
      method: "GET",
      url: `/studies/${fx.studyId}/builds/diff?from=1&to=2`,
    });
    expect(res.statusCode).toBe(200);
    const { diff } = res.json();
    expect(diff.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemOid: "IT.WT", kind: "removed" }),
        expect.objectContaining({ itemOid: "IT.BMI", kind: "added" }),
      ]),
    );
    expect(diff.editChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ oid: "CHK.HR", kind: "changed" }),
        expect.objectContaining({ oid: "CHK.WT", kind: "removed" }),
      ]),
    );
  });

  it("impact analysis counts eligible and excluded forms and finds orphans", async () => {
    const res = await inject({
      method: "POST",
      url: `/studies/${fx.studyId}/migrations/analyze`,
      payload: { targetVersion: 2 },
    });
    expect(res.statusCode).toBe(200);
    const impact = res.json();
    expect(impact.eligible.total).toBe(1);
    expect(impact.eligible.byStatus.in_progress).toBe(1);
    expect(impact.excluded.signed).toBe(1);
    expect(impact.diffs).toHaveLength(1);
    expect(impact.diffs[0].fromVersion).toBe(1);
    expect(impact.orphanedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemGroupOid: "IG.VS", itemOid: "IT.WT", valueCount: 1 }),
      ]),
    );
    expect(impact.checksAddedOrChanged).toContain("CHK.HR");

    const missing = await inject({
      method: "POST",
      url: `/studies/${fx.studyId}/migrations/analyze`,
      payload: { targetVersion: 99 },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("rejects a second migration while one is running", async () => {
    const [v2] = await db
      .select()
      .from(studyMetadataVersions)
      .where(
        and(eq(studyMetadataVersions.studyId, fx.studyId), eq(studyMetadataVersions.version, 2)),
      );
    if (!v2) throw new Error("fixture failed");
    const [blocker] = await db
      .insert(migrationRuns)
      .values({
        studyId: fx.studyId,
        targetMetadataVersionId: v2.id,
        startedBy: fx.userId,
        status: "running",
      })
      .returning();
    if (!blocker) throw new Error("fixture failed");

    const res = await inject({
      method: "POST",
      url: `/studies/${fx.studyId}/migrations`,
      payload: { targetVersion: 2 },
    });
    expect(res.statusCode).toBe(409);

    await db
      .update(migrationRuns)
      .set({ status: "failed", finishedAt: new Date() })
      .where(eq(migrationRuns.id, blocker.id));
  });

  it("migrates unsigned forms, keeps signed forms pinned, reconciles queries", async () => {
    // Before: CHK.WT query open (from the WT=600 write), no CHK.HR query.
    const before = await db
      .select()
      .from(queries)
      .where(and(eq(queries.formInstanceId, fx.inFlightFormId), eq(queries.status, "open")));
    expect(before.map((q) => q.checkOid)).toEqual(["CHK.WT"]);

    const started = await inject({
      method: "POST",
      url: `/studies/${fx.studyId}/migrations`,
      payload: { targetVersion: 2 },
    });
    expect(started.statusCode).toBe(202);
    const { runId, totalForms } = started.json();
    expect(totalForms).toBe(1);

    const run = await pollRun(runId);
    expect(run.status).toBe("completed");
    expect(run.processedForms).toBe(1);
    expect(run.failedForms).toBe(0);

    // The signed form still renders v1; the migrated one renders v2.
    const signedForm = (await inject({ method: "GET", url: `/forms/${fx.signedFormId}` })).json();
    expect(signedForm.buildVersion).toBe(1);
    expect(signedForm.context.status).toBe("signed");

    const migratedForm = (
      await inject({ method: "GET", url: `/forms/${fx.inFlightFormId}` })
    ).json();
    expect(migratedForm.buildVersion).toBe(2);

    // Query reconciliation under the new build: the tightened CHK.HR now
    // fires (HR=210 > 200) and the removed CHK.WT auto-closed.
    const after = await db
      .select()
      .from(queries)
      .where(and(eq(queries.formInstanceId, fx.inFlightFormId), eq(queries.status, "open")));
    expect(after.map((q) => q.checkOid)).toEqual(["CHK.HR"]);
    const closed = await db
      .select()
      .from(queries)
      .where(and(eq(queries.formInstanceId, fx.inFlightFormId), eq(queries.status, "closed")));
    expect(closed.map((q) => q.checkOid)).toEqual(["CHK.WT"]);

    // Audit: exactly one form.migrated row, for the in-flight form.
    const trail = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.studyId, fx.studyId), eq(auditEvents.action, "form.migrated")));
    expect(trail).toHaveLength(1);
    expect(trail[0]?.entityId).toBe(fx.inFlightFormId);

    // Idempotent: a second run finds nothing eligible.
    const again = await inject({
      method: "POST",
      url: `/studies/${fx.studyId}/migrations`,
      payload: { targetVersion: 2 },
    });
    expect(again.statusCode).toBe(202);
    const secondRun = await pollRun(again.json().runId);
    expect(secondRun.status).toBe("completed");
    expect(secondRun.totalForms).toBe(0);
    expect(secondRun.processedForms).toBe(0);
  });

  it("driver is a no-op on a finished run", async () => {
    const [latest] = await db
      .select()
      .from(migrationRuns)
      .where(eq(migrationRuns.studyId, fx.studyId))
      .limit(1);
    if (!latest) throw new Error("fixture failed");
    await runMigrationDriver(db, latest.id);
    const [unchanged] = await db
      .select()
      .from(migrationRuns)
      .where(eq(migrationRuns.id, latest.id));
    expect(unchanged?.status).not.toBe("running");
  });
});
