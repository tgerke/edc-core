import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password.js";
import { grantRole } from "../auth/rbac.js";
import { createDb, databaseUrl } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { auditEvents, roles, sites, studies, users } from "../db/schema/index.js";
import { buildServer } from "../server.js";
import { lakeRef, withLakeReader } from "../services/lake.js";
import type { SnapshotManifest, SnapshotTable } from "../services/snapshots.js";
import { importStudyBuild } from "../services/study-builds.js";

const { db, client } = createDb();
let dbAvailable = false;
try {
  await client`SELECT 1`;
  dbAvailable = true;
} catch {
  if (process.env.CI) throw new Error(`CI requires a reachable database at ${databaseUrl()}`);
  console.warn(`⚠ Skipping snapshot tests: no database at ${databaseUrl()}.`);
}

const odmFixture = readFileSync(
  path.join(
    fileURLToPath(import.meta.url),
    "../../../../../packages/odm/test/fixtures/cdisc-demographics-race.xml",
  ),
  "utf8",
);

const PASSWORD = "correct-Horse-battery-7";
// First publish in a fresh environment downloads DuckDB extensions.
const LAKE_TIMEOUT = 120_000;

describe.skipIf(!dbAvailable)("DuckLake snapshots (integration)", () => {
  let server: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const fx = {
    studyId: "",
    emptyStudyId: "",
    formId: "",
    dmToken: "",
    entryToken: "",
    emptyDmToken: "",
    firstLakeVersion: "",
    schema: "",
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
    const login = await server.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: `${name}-${suffix}`, password: PASSWORD },
    });
    return { user, token: login.json().token as string };
  }

  beforeAll(async () => {
    await runMigrations();
    server = await buildServer({ db });
    await server.ready();

    const [study] = await db
      .insert(studies)
      .values({ oid: `ST.SNAP.${suffix}`, name: "Snapshot Study", status: "active" })
      .returning();
    const [emptyStudy] = await db
      .insert(studies)
      .values({ oid: `ST.SNAP.EMPTY.${suffix}`, name: "No Build", status: "design" })
      .returning();
    if (!study || !emptyStudy) throw new Error("study fixture failed");
    fx.studyId = study.id;
    fx.emptyStudyId = emptyStudy.id;
    const [site] = await db
      .insert(sites)
      .values({ studyId: study.id, oid: "SITE.1", name: "Site One" })
      .returning();
    if (!site) throw new Error("site fixture failed");

    const dm = await makeUser("dm", "data_manager", study.id);
    const entry = await makeUser("de", "data_entry", study.id);
    fx.dmToken = dm.token;
    fx.entryToken = entry.token;
    const emptyDm = await makeUser("dm-empty", "data_manager", emptyStudy.id);
    fx.emptyDmToken = emptyDm.token;

    const imported = await importStudyBuild(db, {
      studyId: study.id,
      content: odmFixture,
      actorId: dm.user.id,
    });
    if (!imported.ok) throw new Error("fixture import failed");

    // Enroll a subject and enter demographics as the site user.
    const subject = (
      await server.inject({
        method: "POST",
        url: `/studies/${study.id}/subjects`,
        payload: { siteId: site.id, subjectKey: "SNAP-001" },
        headers: { authorization: `Bearer ${fx.entryToken}` },
      })
    ).json();
    const form = (
      await server.inject({
        method: "POST",
        url: `/subjects/${subject.id}/forms`,
        payload: { eventOid: "SE.SCREENING", formOid: "FO.DEMOGRAPHICS" },
        headers: { authorization: `Bearer ${fx.entryToken}` },
      })
    ).json();
    fx.formId = form.id;
    for (const [itemOid, value] of [
      ["IT.DOB", "1957-05-07"],
      ["IT.SEX", "2"],
    ]) {
      const write = await server.inject({
        method: "PUT",
        url: `/forms/${form.id}/items`,
        payload: { itemGroupOid: "IG.DEMOGRAPHICS", itemOid, value },
        headers: { authorization: `Bearer ${fx.entryToken}` },
      });
      if (write.statusCode !== 201) throw new Error(`value fixture failed: ${write.body}`);
    }
  }, LAKE_TIMEOUT);

  afterAll(async () => {
    await server.close();
    await client.end();
  });

  it("requires export.data to publish or list", async () => {
    const publish = await server.inject({
      method: "POST",
      url: `/studies/${fx.studyId}/snapshots`,
      payload: {},
      headers: { authorization: `Bearer ${fx.entryToken}` },
    });
    expect(publish.statusCode).toBe(403);
    const list = await server.inject({
      method: "GET",
      url: `/studies/${fx.studyId}/snapshots`,
      headers: { authorization: `Bearer ${fx.entryToken}` },
    });
    expect(list.statusCode).toBe(403);
  });

  it("rejects publishing a study with no build", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/studies/${fx.emptyStudyId}/snapshots`,
      payload: {},
      headers: { authorization: `Bearer ${fx.emptyDmToken}` },
    });
    expect(res.statusCode).toBe(409);
  });

  it(
    "publishes typed, analysis-ready tables and pins a lake version",
    async () => {
      const res = await server.inject({
        method: "POST",
        url: `/studies/${fx.studyId}/snapshots`,
        payload: { note: "first extract" },
        headers: { authorization: `Bearer ${fx.dmToken}` },
      });
      expect(res.statusCode).toBe(201);
      const snapshot = res.json();
      expect(snapshot.status).toBe("published");
      expect(snapshot.lakeVersion).toMatch(/^\d+$/);
      fx.firstLakeVersion = snapshot.lakeVersion;
      fx.schema = snapshot.schemaName;

      const manifest = snapshot.manifest as SnapshotManifest;
      const names = manifest.tables.map((t: SnapshotTable) => t.table);
      expect(names).toContain("subjects");
      expect(names).toContain("queries");
      expect(names).toContain("codings");
      const demographics = manifest.tables.find((t) => t.itemGroupOid === "IG.DEMOGRAPHICS");
      expect(demographics).toBeDefined();
      expect(demographics?.rows).toBe(1);
      expect(demographics?.columns).toContainEqual(
        expect.objectContaining({ column: "it_dob", dataType: "date" }),
      );

      // The pivoted row is typed: DATE for dob, BIGINT for sex.
      const rows = await withLakeReader(lakeRef(fx.schema), async (conn) => {
        const result = await conn.runAndReadAll(
          `SELECT subject_key, it_dob, it_sex FROM lake."${demographics?.table}"
           AT (VERSION => ${fx.firstLakeVersion})`,
        );
        return result.getRowObjects();
      });
      expect(rows).toHaveLength(1);
      expect(String(rows[0]?.subject_key)).toBe("SNAP-001");
      expect(String(rows[0]?.it_dob)).toBe("1957-05-07");
      expect(rows[0]?.it_sex).toBe(2n);
    },
    LAKE_TIMEOUT,
  );

  it(
    "later data changes never alter a published snapshot (E6-07)",
    async () => {
      const write = await server.inject({
        method: "PUT",
        url: `/forms/${fx.formId}/items`,
        payload: {
          itemGroupOid: "IG.DEMOGRAPHICS",
          itemOid: "IT.DOB",
          value: "1957-05-08",
          reasonForChange: "transcription error",
        },
        headers: { authorization: `Bearer ${fx.entryToken}` },
      });
      expect(write.statusCode).toBe(201);

      const res = await server.inject({
        method: "POST",
        url: `/studies/${fx.studyId}/snapshots`,
        payload: { note: "after correction" },
        headers: { authorization: `Bearer ${fx.dmToken}` },
      });
      expect(res.statusCode).toBe(201);
      const second = res.json();
      expect(Number(second.lakeVersion)).toBeGreaterThan(Number(fx.firstLakeVersion));

      const demographics = (second.manifest as SnapshotManifest).tables.find(
        (t) => t.itemGroupOid === "IG.DEMOGRAPHICS",
      );
      const [oldRow, newRow] = await withLakeReader(lakeRef(fx.schema), async (conn) => {
        const at = async (version: string) => {
          const result = await conn.runAndReadAll(
            `SELECT it_dob FROM lake."${demographics?.table}"
             AT (VERSION => ${version})`,
          );
          return result.getRowObjects()[0];
        };
        return [await at(fx.firstLakeVersion), await at(second.lakeVersion)];
      });
      expect(String(oldRow?.it_dob)).toBe("1957-05-07");
      expect(String(newRow?.it_dob)).toBe("1957-05-08");
    },
    LAKE_TIMEOUT,
  );

  it("lists snapshots newest-first with manifest and creator", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/studies/${fx.studyId}/snapshots`,
      headers: { authorization: `Bearer ${fx.dmToken}` },
    });
    expect(res.statusCode).toBe(200);
    const { snapshots } = res.json();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].note).toBe("after correction");
    expect(snapshots[0].createdBy).toBe(`dm-${suffix}`);
    expect(snapshots.every((s: { status: string }) => s.status === "published")).toBe(true);
  });

  it(
    "exports Dataset-JSON v1.1, CSV, and Parquet pinned to the snapshot",
    async () => {
      const list = (
        await server.inject({
          method: "GET",
          url: `/studies/${fx.studyId}/snapshots`,
          headers: { authorization: `Bearer ${fx.dmToken}` },
        })
      ).json().snapshots;
      const [second, first] = list; // newest-first

      const get = (snapshotId: string, qs: string, token = fx.dmToken) =>
        server.inject({
          method: "GET",
          url: `/snapshots/${snapshotId}/export?${qs}`,
          headers: { authorization: `Bearer ${token}` },
        });

      // Site users cannot export; unknown tables 404.
      expect(
        (await get(first.id, "table=ig_demographics&format=csv", fx.entryToken)).statusCode,
      ).toBe(403);
      expect((await get(first.id, "table=nope&format=csv")).statusCode).toBe(404);
      // Dataset-JSON is only defined for datasets, not core tables.
      expect((await get(first.id, "table=subjects&format=dataset-json")).statusCode).toBe(409);

      // Dataset-JSON from the FIRST snapshot still carries the original DOB.
      const dsj = await get(first.id, "table=ig_demographics&format=dataset-json");
      expect(dsj.statusCode).toBe(200);
      expect(dsj.headers["content-disposition"]).toContain("attachment");
      const doc = dsj.json();
      expect(doc.datasetJSONVersion).toBe("1.1.0");
      expect(doc.itemGroupOID).toBe("IG.DEMOGRAPHICS");
      expect(doc.records).toBe(1);
      expect(doc.columns[0].itemOID).toBe("ITEMGROUPDATASEQ");
      const dobIndex = doc.columns.findIndex((c: { itemOID: string }) => c.itemOID === "IT.DOB");
      expect(doc.columns[dobIndex].dataType).toBe("date");
      expect(doc.rows[0][dobIndex]).toBe("1957-05-07");

      // CSV from the SECOND snapshot has the corrected value.
      const csv = await get(second.id, "table=ig_demographics&format=csv");
      expect(csv.statusCode).toBe(200);
      expect(csv.headers["content-type"]).toContain("text/csv");
      const [header, row] = csv.body.trim().split("\n");
      expect(header).toContain("it_dob");
      expect(row).toContain("1957-05-08");

      // Parquet round-trips (magic bytes PAR1).
      const parquet = await get(second.id, "table=ig_demographics&format=parquet");
      expect(parquet.statusCode).toBe(200);
      expect(parquet.rawPayload.subarray(0, 4).toString("ascii")).toBe("PAR1");
    },
    LAKE_TIMEOUT,
  );

  it(
    "runs sandboxed workbench SQL against pinned snapshot views",
    async () => {
      const list = (
        await server.inject({
          method: "GET",
          url: `/studies/${fx.studyId}/snapshots`,
          headers: { authorization: `Bearer ${fx.dmToken}` },
        })
      ).json().snapshots;
      const [second, first] = list;

      const run = (sql: string, snapshotId = first.id, token = fx.dmToken) =>
        server.inject({
          method: "POST",
          url: `/studies/${fx.studyId}/workbench/sql`,
          payload: { snapshotId, sql },
          headers: { authorization: `Bearer ${token}` },
        });

      // data_entry lacks analytics.run.
      expect((await run("SELECT 1", first.id, fx.entryToken)).statusCode).toBe(403);

      // Tables are plain names, pinned to the chosen snapshot's version:
      // the first snapshot still shows the pre-correction DOB.
      const joined = await run(
        `SELECT d.subject_key, d.it_dob, s.site_name
         FROM ig_demographics d JOIN subjects s USING (subject_key)`,
      );
      expect(joined.statusCode).toBe(200);
      const body = joined.json();
      expect(body.columns).toEqual(["subject_key", "it_dob", "site_name"]);
      expect(body.rows).toEqual([["SNAP-001", "1957-05-07", "Site One"]]);
      expect(body.lakeVersion).toBe(first.lakeVersion);
      const corrected = await run("SELECT it_dob FROM ig_demographics", second.id);
      expect(corrected.json().rows).toEqual([["1957-05-08"]]);

      // Sandbox: no filesystem, no ATTACH, no config changes.
      for (const sql of [
        "SELECT * FROM read_csv('/etc/passwd')",
        "COPY (SELECT 1) TO '/tmp/evil.csv'",
        "ATTACH 'postgres://x@y/z' AS pg (TYPE postgres)",
        "SET enable_external_access=true",
      ]) {
        expect((await run(sql)).statusCode, sql).toBe(400);
      }

      // Results are capped and flagged as truncated.
      const big = await run("SELECT * FROM range(10000)");
      expect(big.json().rowCount).toBe(5000);
      expect(big.json().truncated).toBe(true);

      // Snapshots from another study are unreachable through this route.
      const foreign = await server.inject({
        method: "POST",
        url: `/studies/${fx.emptyStudyId}/workbench/sql`,
        payload: { snapshotId: first.id, sql: "SELECT 1" },
        headers: { authorization: `Bearer ${fx.emptyDmToken}` },
      });
      expect(foreign.statusCode).toBe(404);

      // Executions are audited with the SQL text (E6-04).
      const audit = await db.select().from(auditEvents).where(eq(auditEvents.studyId, fx.studyId));
      const executed = audit.filter((e) => e.action === "workbench.executed");
      expect(executed.length).toBeGreaterThanOrEqual(2);
      expect(
        executed.some((e) => (e.newValue as { sql?: string }).sql?.includes("USING (subject_key)")),
      ).toBe(true);
    },
    LAKE_TIMEOUT,
  );

  it("versions saved scripts and records R executions with logs and outputs", async () => {
    // Fake R engine: asserts the API sends a pinned, study-scoped payload
    // without needing R in CI; the real engine is services/r-engine.
    const received: unknown[] = [];
    const engine = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const payload = JSON.parse(body) as { script: string };
        received.push(payload);
        res.setHeader("content-type", "application/json");
        if (payload.script.includes("stop(")) {
          res.end(JSON.stringify({ ok: false, stdout: "", error: "boom: forced failure" }));
        } else {
          res.end(
            JSON.stringify({
              ok: true,
              stdout: "[1] 42",
              resultColumns: ["subject_key", "n"],
              resultJson: '[["SNAP-001",1]]',
              elapsedMs: 5,
            }),
          );
        }
      });
    });
    await new Promise<void>((resolve) => engine.listen(0, resolve));
    const address = engine.address() as AddressInfo;
    process.env.R_ENGINE_URL = `http://127.0.0.1:${address.port}`;

    try {
      const snapshot = (
        await server.inject({
          method: "GET",
          url: `/studies/${fx.studyId}/snapshots`,
          headers: { authorization: `Bearer ${fx.dmToken}` },
        })
      ).json().snapshots[0];

      // Saving twice under one name appends versions.
      const save = (content: string) =>
        server.inject({
          method: "PUT",
          url: `/studies/${fx.studyId}/workbench/scripts`,
          payload: { name: "enrollment-summary", language: "r", content },
          headers: { authorization: `Bearer ${fx.dmToken}` },
        });
      expect((await save("lake_read('subjects')")).json().version).toBe(1);
      const v2 = (await save("dplyr::count(lake_read('subjects'))")).json();
      expect(v2.version).toBe(2);
      const scripts = (
        await server.inject({
          method: "GET",
          url: `/studies/${fx.studyId}/workbench/scripts`,
          headers: { authorization: `Bearer ${fx.dmToken}` },
        })
      ).json().scripts;
      expect(scripts).toHaveLength(1);
      expect(scripts[0].version).toBe(2);

      // data_entry lacks analytics.run.
      const denied = await server.inject({
        method: "POST",
        url: `/studies/${fx.studyId}/workbench/r`,
        payload: { snapshotId: snapshot.id, content: "1 + 1" },
        headers: { authorization: `Bearer ${fx.entryToken}` },
      });
      expect(denied.statusCode).toBe(403);

      const run = await server.inject({
        method: "POST",
        url: `/studies/${fx.studyId}/workbench/r`,
        payload: {
          snapshotId: snapshot.id,
          content: v2.content,
          scriptId: v2.id,
          scriptVersion: 2,
        },
        headers: { authorization: `Bearer ${fx.dmToken}` },
      });
      expect(run.statusCode).toBe(200);
      const execution = run.json();
      expect(execution.status).toBe("succeeded");
      expect(execution.stdout).toBe("[1] 42");
      expect(execution.result).toEqual({ columns: ["subject_key", "n"], rows: [["SNAP-001", 1]] });

      // The engine got a study-scoped, version-pinned payload.
      const payload = received.at(-1) as {
        metadataSchema: string;
        version: number;
        tables: string[];
      };
      expect(payload.metadataSchema).toBe(fx.schema);
      expect(String(payload.version)).toBe(snapshot.lakeVersion);
      expect(payload.tables).toContain("ig_demographics");

      // Failures are recorded, not lost.
      const failed = (
        await server.inject({
          method: "POST",
          url: `/studies/${fx.studyId}/workbench/r`,
          payload: { snapshotId: snapshot.id, content: "stop('x')" },
          headers: { authorization: `Bearer ${fx.dmToken}` },
        })
      ).json();
      expect(failed.status).toBe("failed");
      expect(failed.error).toContain("boom");

      // History lists both runs, newest first, with script attribution.
      const executions = (
        await server.inject({
          method: "GET",
          url: `/studies/${fx.studyId}/workbench/executions`,
          headers: { authorization: `Bearer ${fx.dmToken}` },
        })
      ).json().executions;
      expect(executions.length).toBeGreaterThanOrEqual(2);
      expect(executions[0].status).toBe("failed");
      expect(executions[1].scriptVersion).toBe(2);

      // Engine down → 502, nothing recorded as succeeded.
      process.env.R_ENGINE_URL = "http://127.0.0.1:1";
      const down = await server.inject({
        method: "POST",
        url: `/studies/${fx.studyId}/workbench/r`,
        payload: { snapshotId: snapshot.id, content: "1 + 1" },
        headers: { authorization: `Bearer ${fx.dmToken}` },
      });
      expect(down.statusCode).toBe(502);
    } finally {
      delete process.env.R_ENGINE_URL;
      engine.close();
    }
  });

  it(
    "exports a self-contained study archive zip (P11-06)",
    async () => {
      const denied = await server.inject({
        method: "GET",
        url: `/studies/${fx.studyId}/archive`,
        headers: { authorization: `Bearer ${fx.entryToken}` },
      });
      expect(denied.statusCode).toBe(403);

      // No published snapshot yet on the empty study → 409.
      const noSnapshot = await server.inject({
        method: "GET",
        url: `/studies/${fx.emptyStudyId}/archive`,
        headers: { authorization: `Bearer ${fx.emptyDmToken}` },
      });
      expect(noSnapshot.statusCode).toBe(409);

      const res = await server.inject({
        method: "GET",
        url: `/studies/${fx.studyId}/archive`,
        headers: { authorization: `Bearer ${fx.dmToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("application/zip");
      expect(res.headers["content-disposition"]).toContain(".zip");
      // Zip magic bytes.
      expect(res.rawPayload.subarray(0, 2).toString("ascii")).toBe("PK");

      // The zip's central directory lists every expected entry.
      const raw = res.rawPayload.toString("latin1");
      for (const entry of [
        "MANIFEST.json",
        "metadata/odm-v1.xml",
        "metadata/odm-v1.json",
        "data/ig_demographics.dataset.json",
        "data/ig_demographics.csv",
        "data/subjects.csv",
        "data/queries.csv",
        "audit/audit-trail.csv",
        "signatures/signatures.json",
      ]) {
        expect(raw, entry).toContain(entry);
      }

      // Archiving is itself audited.
      const audit = await db.select().from(auditEvents).where(eq(auditEvents.studyId, fx.studyId));
      expect(audit.some((e) => e.action === "study.archive_exported")).toBe(true);
    },
    LAKE_TIMEOUT,
  );
});
