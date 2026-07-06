import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password.js";
import { grantRole } from "../auth/rbac.js";
import { createDb, databaseUrl } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { roles, sites, studies, users } from "../db/schema/index.js";
import { buildServer } from "../server.js";
import { withLakeReader } from "../services/lake.js";
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
      const demographics = manifest.tables.find((t) => t.itemGroupOid === "IG.DEMOGRAPHICS");
      expect(demographics).toBeDefined();
      expect(demographics?.rows).toBe(1);
      expect(demographics?.columns).toContainEqual(
        expect.objectContaining({ column: "it_dob", dataType: "date" }),
      );

      // The pivoted row is typed: DATE for dob, BIGINT for sex.
      const rows = await withLakeReader(async (conn) => {
        const result = await conn.runAndReadAll(
          `SELECT subject_key, it_dob, it_sex FROM lake."${fx.schema}"."${demographics?.table}"
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
      const [oldRow, newRow] = await withLakeReader(async (conn) => {
        const at = async (version: string) => {
          const result = await conn.runAndReadAll(
            `SELECT it_dob FROM lake."${fx.schema}"."${demographics?.table}"
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
});
