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
  itemValueVersions,
  labImportRuns,
  queries,
  roles,
  sites,
  studies,
  studyEventInstances,
  users,
} from "../db/schema/index.js";
import { buildServer } from "../server.js";
import { parseCsv, sweepInterruptedLabImports } from "../services/lab-imports.js";
import { importStudyBuild } from "../services/study-builds.js";

const { db, client } = createDb();
let dbAvailable = false;
try {
  await client`SELECT 1`;
  dbAvailable = true;
} catch {
  if (process.env.CI) throw new Error(`CI requires a reachable database at ${databaseUrl()}`);
  console.warn(`⚠ Skipping lab import tests: no database at ${databaseUrl()}.`);
}

describe("parseCsv", () => {
  it("parses quoted fields, escapes, and embedded separators", () => {
    const { header, rows } = parseCsv(
      'a,b,c\r\n1,"two, with comma","she said ""hi"""\n4,"multi\nline",6\n',
    );
    expect(header).toEqual(["a", "b", "c"]);
    expect(rows).toEqual([
      { line: 2, fields: ["1", "two, with comma", 'she said "hi"'] },
      { line: 3, fields: ["4", "multi\nline", "6"] },
    ]);
  });

  it("skips blank lines and tolerates a missing trailing newline", () => {
    const { rows } = parseCsv("a,b\n\n1,2\n3,4");
    expect(rows.map((r) => r.fields)).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("rejects ragged rows, unterminated quotes, and empty files", () => {
    expect(() => parseCsv("a,b\n1,2,3\n")).toThrow(/expected 2 fields, got 3/);
    expect(() => parseCsv('a,b\n1,"unterminated\n')).toThrow(/quoted field/);
    expect(() => parseCsv("")).toThrow(/empty/);
  });
});

/**
 * One lab form on two events. IT.ALT is the result (float) with IT.ALTU as
 * its unit; IT.LBDT holds the collection date; IT.TOX is blinded; CHK.ALT
 * fires above 200 so an imported out-of-range value opens a system query.
 */
function odm(): string {
  return `<ODM xmlns="http://www.cdisc.org/ns/odm/v2.0"
      xmlns:edc="https://github.com/tgerke/edc-core/ns/odm-ext/v1"
      FileOID="LAB1" FileType="Snapshot"
      ODMVersion="2.0" CreationDateTime="2026-07-10T00:00:00Z" Granularity="Metadata">
    <Study OID="ST.LAB" StudyName="Lab Import Study">
      <MetaDataVersion OID="MDV.1" Name="v1">
        <StudyEventDef OID="SE.SCR" Name="Screening" Repeating="No" Type="Scheduled">
          <ItemGroupRef ItemGroupOID="FO.LAB" Mandatory="Yes"/>
        </StudyEventDef>
        <StudyEventDef OID="SE.W4" Name="Week 4" Repeating="No" Type="Scheduled">
          <ItemGroupRef ItemGroupOID="FO.LAB" Mandatory="Yes"/>
        </StudyEventDef>
        <ItemGroupDef OID="FO.LAB" Name="Local Labs" Type="Form" Repeating="No">
          <ItemGroupRef ItemGroupOID="IG.LAB" Mandatory="Yes"/>
        </ItemGroupDef>
        <ItemGroupDef OID="IG.LAB" Name="Chemistry" Type="Section" Repeating="No">
          <ItemRef ItemOID="IT.ALT" Mandatory="No"/>
          <ItemRef ItemOID="IT.ALTU" Mandatory="No"/>
          <ItemRef ItemOID="IT.LBDT" Mandatory="No"/>
          <ItemRef ItemOID="IT.TOX" Mandatory="No"/>
        </ItemGroupDef>
        <ItemDef OID="IT.ALT" Name="ALT" DataType="float"/>
        <ItemDef OID="IT.ALTU" Name="ALT unit" DataType="text"/>
        <ItemDef OID="IT.LBDT" Name="Collection date" DataType="date"/>
        <ItemDef OID="IT.TOX" Name="Toxin level" DataType="integer" edc:Blinded="Yes"/>
        <ConditionDef OID="CHK.ALT" Name="ALT plausible">
          <Description><TranslatedText xml:lang="en" Type="text/plain">ALT above 200.</TranslatedText></Description>
          <FormalExpression Context="jsonata">\`IT.ALT\` != null and \`IT.ALT\` &gt; 200</FormalExpression>
        </ConditionDef>
      </MetaDataVersion>
    </Study>
  </ODM>`;
}

const PASSWORD = "correct-Horse-battery-7";
const HEADER = "USUBJID,SITEID,VISIT,LBTESTCD,LBORRES,LBORRESU,LBDTC";

const mappingConfig = {
  formOid: "FO.LAB",
  columns: {
    subjectKey: "USUBJID",
    siteOid: "SITEID",
    visit: "VISIT",
    testCode: "LBTESTCD",
    result: "LBORRES",
    unit: "LBORRESU",
    collectionDate: "LBDTC",
  },
  visitMap: { SCREENING: "SE.SCR", "WEEK 4": "SE.W4" },
  tests: {
    ALT: { itemGroupOid: "IG.LAB", itemOid: "IT.ALT", unitItemOid: "IT.ALTU" },
    TOX: { itemGroupOid: "IG.LAB", itemOid: "IT.TOX" },
  },
  collectionDateItem: { itemGroupOid: "IG.LAB", itemOid: "IT.LBDT" },
};

describe.skipIf(!dbAvailable)("lab data import (integration)", () => {
  let server: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const fx = {
    studyId: "",
    siteAId: "",
    mappingId: "",
    adminToken: "",
    dmToken: "",
    entryToken: "",
    adminId: "",
    dmId: "",
    s1Id: "",
    s2Id: "",
  };

  function inject(
    token: string,
    opts: { method: "GET" | "POST" | "PUT"; url: string; payload?: object },
  ) {
    return server.inject({ ...opts, headers: { authorization: `Bearer ${token}` } });
  }

  async function pollRun(runId: string) {
    for (let i = 0; i < 100; i++) {
      const res = await inject(fx.dmToken, {
        method: "GET",
        url: `/studies/${fx.studyId}/lab-import/runs/${runId}`,
      });
      const run = res.json();
      if (run.status !== "running") return run;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("lab import run did not finish in time");
  }

  async function importCsv(token: string, csv: string) {
    const res = await inject(token, {
      method: "POST",
      url: `/studies/${fx.studyId}/lab-import/runs`,
      payload: { mappingId: fx.mappingId, content: csv, fileName: "labs.csv" },
    });
    expect(res.statusCode).toBe(202);
    return pollRun(res.json().runId);
  }

  async function formInstance(subjectId: string, eventOid: string) {
    const [row] = await db
      .select({ id: formInstances.id, status: formInstances.status })
      .from(formInstances)
      .innerJoin(
        studyEventInstances,
        eq(formInstances.studyEventInstanceId, studyEventInstances.id),
      )
      .where(
        and(
          eq(studyEventInstances.subjectId, subjectId),
          eq(studyEventInstances.eventOid, eventOid),
          eq(formInstances.formOid, "FO.LAB"),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async function importAuditCount() {
    const rows = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(
        and(eq(auditEvents.studyId, fx.studyId), eq(auditEvents.action, "item_value.imported")),
      );
    return rows.length;
  }

  beforeAll(async () => {
    await runMigrations();
    server = await buildServer({ db });
    await server.ready();

    const [study] = await db
      .insert(studies)
      .values({ oid: `ST.LAB.${suffix}`, name: "Lab Import Study" })
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
    fx.siteAId = siteA.id;

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

    // admin: data.import + data.unblind; data_manager: data.import only
    // (0010 does not seed data.unblind to data_manager); data_entry: no
    // data.import at all.
    const admin = await mkUser(`li-admin-${suffix}`, "admin");
    const dm = await mkUser(`li-dm-${suffix}`, "data_manager");
    const entry = await mkUser(`li-entry-${suffix}`, "data_entry");
    fx.adminId = admin.id;
    fx.adminToken = admin.token;
    fx.dmId = dm.id;
    fx.dmToken = dm.token;
    fx.entryToken = entry.token;

    const v1 = await importStudyBuild(db, { studyId: study.id, content: odm(), actorId: admin.id });
    if (!v1.ok) throw new Error(`build import failed: ${JSON.stringify(v1.issues)}`);

    for (const [key, ref] of [
      ["S-001", "s1Id"],
      ["S-002", "s2Id"],
    ] as const) {
      const res = await inject(fx.adminToken, {
        method: "POST",
        url: `/studies/${study.id}/subjects`,
        payload: { siteId: siteA.id, subjectKey: key },
      });
      if (res.statusCode !== 201) throw new Error(`enroll failed: ${res.body}`);
      fx[ref] = res.json().id;
    }
  });

  afterAll(async () => {
    await server.close();
    await client.end();
  });

  it("mapping CRUD is permission-gated and audited", async () => {
    const forbidden = await inject(fx.entryToken, {
      method: "POST",
      url: `/studies/${fx.studyId}/lab-import/mappings`,
      payload: { name: "Central Lab", config: mappingConfig },
    });
    expect(forbidden.statusCode).toBe(403);

    const bad = await inject(fx.dmToken, {
      method: "POST",
      url: `/studies/${fx.studyId}/lab-import/mappings`,
      payload: { name: "Central Lab", config: { columns: {} } },
    });
    expect(bad.statusCode).toBe(400);

    const created = await inject(fx.dmToken, {
      method: "POST",
      url: `/studies/${fx.studyId}/lab-import/mappings`,
      payload: { name: "Central Lab", config: mappingConfig },
    });
    expect(created.statusCode).toBe(201);
    fx.mappingId = created.json().id;

    const duplicate = await inject(fx.dmToken, {
      method: "POST",
      url: `/studies/${fx.studyId}/lab-import/mappings`,
      payload: { name: "Central Lab", config: mappingConfig },
    });
    expect(duplicate.statusCode).toBe(409);

    const renamed = await inject(fx.dmToken, {
      method: "PUT",
      url: `/studies/${fx.studyId}/lab-import/mappings/${fx.mappingId}`,
      payload: { name: "Central Lab (Q3)" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().name).toBe("Central Lab (Q3)");

    const trail = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.studyId, fx.studyId), eq(auditEvents.entityId, fx.mappingId)));
    expect(trail.map((e) => e.action).sort()).toEqual([
      "lab_import_mapping.created",
      "lab_import_mapping.updated",
    ]);
    const updated = trail.find((e) => e.action === "lab_import_mapping.updated");
    expect(updated?.oldValue).toMatchObject({ name: "Central Lab" });
    expect(updated?.newValue).toMatchObject({ name: "Central Lab (Q3)" });

    // Members without data.import can still see mappings (they contain
    // OIDs and column names, not clinical values).
    const list = await inject(fx.entryToken, {
      method: "GET",
      url: `/studies/${fx.studyId}/lab-import/mappings`,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
  });

  it("dry-run classifies every row and writes nothing", async () => {
    const csv = [
      HEADER,
      "S-001,SITE.A,SCREENING,ALT,42.5,U/L,2026-07-01", // would import
      "S-001,SITE.A,SCREENING,TOX,3,,2026-07-01", // blinded; dm lacks data.unblind
      "S-999,SITE.A,SCREENING,ALT,10,U/L,2026-07-01", // unknown subject
      "S-002,SITE.B,SCREENING,ALT,10,U/L,2026-07-01", // wrong site
      "S-002,SITE.A,WEEK 9,ALT,10,U/L,2026-07-01", // unmapped visit
      "S-002,SITE.A,SCREENING,XYZ,10,,", // unknown test
      "S-002,SITE.A,SCREENING,ALT,abc,U/L,2026-07-01", // uncastable result
    ].join("\n");

    const res = await inject(fx.dmToken, {
      method: "POST",
      url: `/studies/${fx.studyId}/lab-import/validate`,
      payload: { mappingId: fx.mappingId, content: csv },
    });
    expect(res.statusCode).toBe(200);
    const preview = res.json();
    expect(preview.totalRows).toBe(7);
    expect(preview.counts).toEqual({
      imported: 1,
      skipped_blinded: 1,
      error_no_subject: 1,
      error_site_mismatch: 1,
      error_no_event: 1,
      error_unknown_test: 1,
      error_bad_value: 1,
    });
    expect(preview.formsTouched).toBe(1);
    expect(preview.formInstancesToCreate).toBe(1);
    expect(preview.issues).toHaveLength(6);

    // Nothing was written: no form instances, no imported values.
    expect(await formInstance(fx.s1Id, "SE.SCR")).toBeNull();
    expect(await importAuditCount()).toBe(0);

    const forbidden = await inject(fx.entryToken, {
      method: "POST",
      url: `/studies/${fx.studyId}/lab-import/validate`,
      payload: { mappingId: fx.mappingId, content: csv },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("imports a clean file, creating instances and firing edit checks", async () => {
    const run = await importCsv(
      fx.dmToken,
      [
        HEADER,
        "S-001,SITE.A,SCREENING,ALT,42.5,U/L,2026-07-01",
        "S-002,SITE.A,WEEK 4,ALT,250,U/L,2026-07-02", // fires CHK.ALT (> 200)
      ].join("\n"),
    );
    expect(run.status).toBe("completed");
    expect(run.counts).toEqual({ imported: 2 });
    expect(run.processedRows).toBe(2);

    // Instances were auto-created and started.
    const s1Form = await formInstance(fx.s1Id, "SE.SCR");
    expect(s1Form?.status).toBe("in_progress");
    if (!s1Form) throw new Error("form missing");

    // All three targets landed: result, unit, collection date.
    const values = await db
      .select({ itemOid: itemValueVersions.itemOid, value: itemValueVersions.value })
      .from(itemValueVersions)
      .where(eq(itemValueVersions.formInstanceId, s1Form.id));
    expect(Object.fromEntries(values.map((v) => [v.itemOid, v.value]))).toEqual({
      "IT.ALT": "42.5",
      "IT.ALTU": "U/L",
      "IT.LBDT": "2026-07-01",
    });

    // Origin is visible in the trail: 6 imported values, no "entered" rows,
    // and exactly one status transition per touched form.
    expect(await importAuditCount()).toBe(6);
    const statusChanges = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.studyId, fx.studyId), eq(auditEvents.action, "form.status_changed")),
      );
    expect(statusChanges).toHaveLength(2);

    // The imported out-of-range ALT opened a system query, like typed data.
    const s2Form = await formInstance(fx.s2Id, "SE.W4");
    if (!s2Form) throw new Error("form missing");
    const open = await db
      .select()
      .from(queries)
      .where(and(eq(queries.formInstanceId, s2Form.id), eq(queries.status, "open")));
    expect(open.map((q) => q.checkOid)).toEqual(["CHK.ALT"]);

    // Run-level audit trail.
    const runTrail = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.studyId, fx.studyId), eq(auditEvents.entityType, "lab_import_run")),
      );
    expect(runTrail.map((e) => e.action).sort()).toEqual([
      "lab_import.completed",
      "lab_import.started",
    ]);
  });

  it("re-importing the same file is idempotent", async () => {
    const run = await importCsv(
      fx.dmToken,
      [
        HEADER,
        "S-001,SITE.A,SCREENING,ALT,42.5,U/L,2026-07-01",
        "S-002,SITE.A,WEEK 4,ALT,250,U/L,2026-07-02",
      ].join("\n"),
    );
    expect(run.status).toBe("completed");
    expect(run.counts).toEqual({ skipped_unchanged: 2 });
    expect(await importAuditCount()).toBe(6); // unchanged
  });

  it("reports conflicts without touching existing values", async () => {
    const run = await importCsv(
      fx.dmToken,
      [HEADER, "S-001,SITE.A,SCREENING,ALT,43.0,U/L,2026-07-01"].join("\n"),
    );
    expect(run.status).toBe("completed_with_errors");
    expect(run.counts).toEqual({ conflict_existing_value: 1 });
    expect(run.issues[0].message).toMatch(/differs from existing "42.5"/);

    const s1Form = await formInstance(fx.s1Id, "SE.SCR");
    if (!s1Form) throw new Error("form missing");
    const versions = await db
      .select()
      .from(itemValueVersions)
      .where(
        and(
          eq(itemValueVersions.formInstanceId, s1Form.id),
          eq(itemValueVersions.itemOid, "IT.ALT"),
        ),
      );
    expect(versions).toHaveLength(1);
    expect(versions[0]?.value).toBe("42.5");
  });

  it("skips rows targeting forms past data entry", async () => {
    const s1Form = await formInstance(fx.s1Id, "SE.SCR");
    if (!s1Form) throw new Error("form missing");
    const completed = await inject(fx.adminToken, {
      method: "POST",
      url: `/forms/${s1Form.id}/status`,
      payload: { action: "complete" },
    });
    expect(completed.statusCode).toBe(200);

    const run = await importCsv(
      fx.dmToken,
      [HEADER, "S-001,SITE.A,SCREENING,ALT,99,U/L,2026-07-09"].join("\n"),
    );
    expect(run.status).toBe("completed_with_errors");
    expect(run.counts).toEqual({ skipped_form_status: 1 });
    expect(run.issues[0].message).toMatch(/form is complete/);
  });

  it("blinded items import only with data.unblind", async () => {
    const skipped = await importCsv(fx.dmToken, [HEADER, "S-002,SITE.A,WEEK 4,TOX,3,,"].join("\n"));
    expect(skipped.counts).toEqual({ skipped_blinded: 1 });

    const imported = await importCsv(
      fx.adminToken,
      [HEADER, "S-002,SITE.A,WEEK 4,TOX,3,,"].join("\n"),
    );
    expect(imported.status).toBe("completed");
    expect(imported.counts).toEqual({ imported: 1 });

    const s2Form = await formInstance(fx.s2Id, "SE.W4");
    if (!s2Form) throw new Error("form missing");
    const [tox] = await db
      .select()
      .from(itemValueVersions)
      .where(
        and(
          eq(itemValueVersions.formInstanceId, s2Form.id),
          eq(itemValueVersions.itemOid, "IT.TOX"),
        ),
      );
    expect(tox?.value).toBe("3");
  });

  it("requires data.import to run and membership to observe", async () => {
    const forbidden = await inject(fx.entryToken, {
      method: "POST",
      url: `/studies/${fx.studyId}/lab-import/runs`,
      payload: { mappingId: fx.mappingId, content: `${HEADER}\n` },
    });
    expect(forbidden.statusCode).toBe(403);

    const list = await inject(fx.entryToken, {
      method: "GET",
      url: `/studies/${fx.studyId}/lab-import/runs`,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().length).toBeGreaterThan(0);
  });

  it("rejects a second import while one is running", async () => {
    const [blocker] = await db
      .insert(labImportRuns)
      .values({
        studyId: fx.studyId,
        mappingId: fx.mappingId,
        mappingConfig,
        startedBy: fx.dmId,
        status: "running",
      })
      .returning();
    if (!blocker) throw new Error("fixture failed");

    const res = await inject(fx.dmToken, {
      method: "POST",
      url: `/studies/${fx.studyId}/lab-import/runs`,
      payload: { mappingId: fx.mappingId, content: `${HEADER}\nS-001,SITE.A,SCREENING,ALT,1,,` },
    });
    expect(res.statusCode).toBe(409);

    // The boot sweep marks interrupted runs failed.
    const swept = await sweepInterruptedLabImports(db);
    expect(swept).toBeGreaterThan(0);
    const [after] = await db.select().from(labImportRuns).where(eq(labImportRuns.id, blocker.id));
    expect(after?.status).toBe("failed");
    expect(after?.finishedAt).not.toBeNull();
  });
});
