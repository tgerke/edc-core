import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseOdm } from "@edc-core/odm";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password.js";
import { grantRole } from "../auth/rbac.js";
import { createDb, databaseUrl } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { roles, studies, users } from "../db/schema/index.js";
import { buildServer } from "../server.js";

const { db, client } = createDb();
let dbAvailable = false;
try {
  await client`SELECT 1`;
  dbAvailable = true;
} catch {
  if (process.env.CI) throw new Error(`CI requires a reachable database at ${databaseUrl()}`);
  console.warn(
    `⚠ Skipping study-build integration tests: no database at ${databaseUrl()}. ` +
      "Start one with: podman compose -f infra/compose.yaml up -d postgres",
  );
}

const fixturePath = path.join(
  fileURLToPath(import.meta.url),
  "../../../../../packages/odm/test/fixtures/cdisc-demographics-race.xml",
);
const demographicsOdm = readFileSync(fixturePath, "utf8");

const PASSWORD = "correct-Horse-battery-7";

describe.skipIf(!dbAvailable)("study build import/export (integration)", () => {
  let server: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const fx = { managerToken: "", outsiderToken: "", studyId: "" };

  beforeAll(async () => {
    await runMigrations();
    server = await buildServer({ db });
    await server.ready();

    const passwordHash = await hashPassword(PASSWORD);
    const [manager] = await db
      .insert(users)
      .values({
        username: `dm-${suffix}`,
        email: `dm-${suffix}@example.com`,
        fullName: "Data Manager",
        passwordHash,
      })
      .returning();
    const [outsider] = await db
      .insert(users)
      .values({
        username: `out-${suffix}`,
        email: `out-${suffix}@example.com`,
        fullName: "Outsider",
        passwordHash,
      })
      .returning();
    const [admin] = await db
      .insert(users)
      .values({
        username: `adm-${suffix}`,
        email: `adm-${suffix}@example.com`,
        fullName: "Admin",
        passwordHash,
        isSystemAdmin: true,
      })
      .returning();
    const [study] = await db
      .insert(studies)
      .values({ oid: `ST.ODM.${suffix}`, name: "ODM Import Study" })
      .returning();
    if (!manager || !outsider || !admin || !study) throw new Error("fixture failed");
    fx.studyId = study.id;

    const [dataManagerRole] = await db.select().from(roles).where(eq(roles.name, "data_manager"));
    if (!dataManagerRole) throw new Error("seeded role missing");
    await grantRole(db, {
      userId: manager.id,
      studyId: study.id,
      roleId: dataManagerRole.id,
      grantedBy: admin.id,
    });

    const login = async (username: string) => {
      const res = await server.inject({
        method: "POST",
        url: "/auth/login",
        payload: { username, password: PASSWORD },
      });
      return res.json().token as string;
    };
    fx.managerToken = await login(`dm-${suffix}`);
    fx.outsiderToken = await login(`out-${suffix}`);
  });

  afterAll(async () => {
    await server.close();
    await client.end();
  });

  function importOdm(token: string, content: string, note?: string) {
    return server.inject({
      method: "POST",
      url: `/studies/${fx.studyId}/metadata-versions`,
      payload: { content, ...(note ? { note } : {}) },
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it("imports a CDISC example and assigns version 1", async () => {
    const res = await importOdm(fx.managerToken, demographicsOdm, "initial import");
    expect(res.statusCode).toBe(201);
    expect(res.json().version).toBe(1);
  });

  it("increments the version on re-import", async () => {
    const res = await importOdm(fx.managerToken, demographicsOdm);
    expect(res.statusCode).toBe(201);
    expect(res.json().version).toBe(2);
  });

  it("requires study.manage to import", async () => {
    const res = await importOdm(fx.outsiderToken, demographicsOdm);
    expect(res.statusCode).toBe(403);
  });

  it("rejects ODM with unresolvable references and reports issues", async () => {
    const broken = `<ODM xmlns="http://www.cdisc.org/ns/odm/v2.0" FileOID="X" FileType="Snapshot"
        ODMVersion="2.0" CreationDateTime="2026-01-01T00:00:00Z">
      <Study OID="ST.X" StudyName="Broken">
        <MetaDataVersion OID="MDV.1" Name="v1">
          <StudyEventDef OID="SE.1" Name="Visit">
            <ItemGroupRef ItemGroupOID="IG.DOES_NOT_EXIST"/>
          </StudyEventDef>
        </MetaDataVersion>
      </Study>
    </ODM>`;
    const res = await importOdm(fx.managerToken, broken);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json().issues)).toContain("IG.DOES_NOT_EXIST");
  });

  it("lists metadata versions for members only", async () => {
    const asManager = await server.inject({
      method: "GET",
      url: `/studies/${fx.studyId}/metadata-versions`,
      headers: { authorization: `Bearer ${fx.managerToken}` },
    });
    expect(asManager.statusCode).toBe(200);
    expect(asManager.json().map((v: { version: number }) => v.version)).toEqual([2, 1]);

    const asOutsider = await server.inject({
      method: "GET",
      url: `/studies/${fx.studyId}/metadata-versions`,
      headers: { authorization: `Bearer ${fx.outsiderToken}` },
    });
    expect(asOutsider.statusCode).toBe(403);
  });

  it("exports ODM XML that round-trips to the imported metadata", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/studies/${fx.studyId}/metadata-versions/1/odm?serialization=xml`,
      headers: { authorization: `Bearer ${fx.managerToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/xml");

    const exported = parseOdm(res.body);
    const original = parseOdm(demographicsOdm);
    expect(exported.study?.metaDataVersions[0]).toEqual(original.study?.metaDataVersions[0]);
    expect(exported.sourceSystem).toBe("edc-core");

    // Full circle: the export is itself importable.
    const reimport = await importOdm(fx.managerToken, res.body);
    expect(reimport.statusCode).toBe(201);
    expect(reimport.json().version).toBe(3);
  });

  it("exports JSON serialization too", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/studies/${fx.studyId}/metadata-versions/1/odm?serialization=json`,
      headers: { authorization: `Bearer ${fx.managerToken}` },
    });
    expect(res.statusCode).toBe(200);
    const parsed = parseOdm(res.body);
    expect(parsed.study?.metaDataVersions[0]?.oid).toBe("MV.1.0");
  });

  it("404s on a missing version", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/studies/${fx.studyId}/metadata-versions/99/odm`,
      headers: { authorization: `Bearer ${fx.managerToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
