import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password.js";
import { grantRole } from "../auth/rbac.js";
import { createDb, databaseUrl } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { protocolVersions, roles, studies, users } from "../db/schema/index.js";
import { buildServer } from "../server.js";

const { db, client } = createDb();
let dbAvailable = false;
try {
  await client`SELECT 1`;
  dbAvailable = true;
} catch {
  if (process.env.CI) throw new Error(`CI requires a reachable database at ${databaseUrl()}`);
  console.warn(
    `⚠ Skipping protocol integration tests: no database at ${databaseUrl()}. ` +
      "Start one with: podman compose -f infra/compose.yaml up -d postgres",
  );
}

const fixturePath = path.join(
  fileURLToPath(import.meta.url),
  "../../../../../examples/demo-protocol-usdm.json",
);
const demoProtocol = readFileSync(fixturePath, "utf8");

const PASSWORD = "correct-Horse-battery-7";

describe.skipIf(!dbAvailable)("protocol-first build path (integration)", () => {
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
        username: `pm-${suffix}`,
        email: `pm-${suffix}@example.com`,
        fullName: "Protocol Manager",
        passwordHash,
      })
      .returning();
    const [outsider] = await db
      .insert(users)
      .values({
        username: `pout-${suffix}`,
        email: `pout-${suffix}@example.com`,
        fullName: "Outsider",
        passwordHash,
      })
      .returning();
    const [admin] = await db
      .insert(users)
      .values({
        username: `padm-${suffix}`,
        email: `padm-${suffix}@example.com`,
        fullName: "Admin",
        passwordHash,
        isSystemAdmin: true,
      })
      .returning();
    const [study] = await db
      .insert(studies)
      .values({ oid: `ST.USDM.${suffix}`, name: "USDM Import Study" })
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
    fx.managerToken = await login(`pm-${suffix}`);
    fx.outsiderToken = await login(`pout-${suffix}`);
  });

  afterAll(async () => {
    await server.close();
    await client.end();
  });

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  it("rejects protocol upload from a non-member", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/studies/${fx.studyId}/protocol-versions`,
      headers: auth(fx.outsiderToken),
      payload: { content: demoProtocol },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects malformed USDM with parse issues", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/studies/${fx.studyId}/protocol-versions`,
      headers: auth(fx.managerToken),
      payload: { content: JSON.stringify({ study: { name: "X" } }) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("USDM import failed");
  });

  it("imports the demo protocol and compiles a review candidate", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/studies/${fx.studyId}/protocol-versions`,
      headers: auth(fx.managerToken),
      payload: { content: demoProtocol, note: "initial protocol" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.version).toBe(1);
    expect(body.unresolvedCount).toBe(3);
  });

  it("serves the SoA summary with per-concept resolution status", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/studies/${fx.studyId}/protocol-versions/1`,
      headers: auth(fx.managerToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.usdmVersion).toBe("4.0.0");
    expect(body.compilation.status).toBe("in_review");
    expect(body.soa.encounters.map((e: { label: string }) => e.label)).toEqual([
      "Screening Visit",
      "Baseline Visit",
      "Week 4 Visit",
    ]);
    expect(body.soa.encounters[2].windowLabel).toBe("±3 days");

    const vitals = body.soa.rows.find((r: { label: string }) => r.label === "Vital Signs");
    expect(vitals.concepts.every((c: { status: string }) => c.status === "resolved")).toBe(true);
    const ecg = body.soa.rows.find((r: { label: string }) => r.label === "12-Lead ECG");
    expect(ecg.concepts[0].status).toBe("draft");
    const safety = body.soa.rows.find((r: { label: string }) => r.label === "Safety");
    expect(safety.isGroupHeading).toBe(true);
  });

  it("refuses to publish while draft items remain", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/studies/${fx.studyId}/protocol-versions/1/compilation/publish`,
      headers: auth(fx.managerToken),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("unresolved draft item");
  });

  it("resolves draft items through the compilation PATCH", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: `/studies/${fx.studyId}/protocol-versions/1/compilation`,
      headers: auth(fx.managerToken),
      payload: {
        resolutions: [
          {
            itemOid: "IT.DRAFT_ADVERSE_EVENTS",
            name: "AETERM",
            question: "Adverse event term",
            dataType: "text",
            mandatory: false,
          },
          {
            itemOid: "IT.DRAFT_CONCOMITANT_MEDICATIONS",
            name: "CMTRT",
            question: "Concomitant medication name",
            dataType: "text",
          },
          {
            itemOid: "IT.DRAFT_12_LEAD_ECG",
            name: "EGINTP",
            question: "ECG interpretation",
            dataType: "text",
            codeListTerms: [
              { codedValue: "NORMAL", decode: "Normal" },
              { codedValue: "ABNORMAL", decode: "Abnormal" },
            ],
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().unresolvedCount).toBe(0);
  });

  it("publishes the resolved candidate as a study build with traceability", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/studies/${fx.studyId}/protocol-versions/1/compilation/publish`,
      headers: auth(fx.managerToken),
    });
    expect(res.statusCode).toBe(201);
    const { buildVersion } = res.json();
    expect(buildVersion).toBe(1);

    const builds = await server.inject({
      method: "GET",
      url: `/studies/${fx.studyId}/metadata-versions`,
      headers: auth(fx.managerToken),
    });
    expect(builds.json()).toHaveLength(1);
    expect(builds.json()[0].note).toBe("Published from protocol v1");

    const odm = await server.inject({
      method: "GET",
      url: `/studies/${fx.studyId}/metadata-versions/1/odm?serialization=xml`,
      headers: auth(fx.managerToken),
    });
    expect(odm.statusCode).toBe(200);
    expect(odm.body).toContain('edc:UsdmEncounterId="Encounter_Week4"');
    expect(odm.body).not.toContain("edc:Unresolved");

    const trace = await server.inject({
      method: "GET",
      url: `/studies/${fx.studyId}/metadata-versions/1/traceability`,
      headers: auth(fx.managerToken),
    });
    expect(trace.statusCode).toBe(200);
    const rows = trace.json() as { odmType: string; odmOid: string }[];
    expect(rows.filter((r) => r.odmType === "event")).toHaveLength(3);
    expect(rows.some((r) => r.odmOid === "IT.SYSBP_VSORRES")).toBe(true);
  });

  it("refuses to publish the same compilation twice", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/studies/${fx.studyId}/protocol-versions/1/compilation/publish`,
      headers: auth(fx.managerToken),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("published");
  });

  it("blocks mutation of stored protocol versions (append-only trigger)", async () => {
    await expect(
      db.execute(
        sql`UPDATE protocol_versions SET note = 'tampered' WHERE study_id = ${fx.studyId}`,
      ),
    ).rejects.toThrow();
    const [row] = await db
      .select({ note: protocolVersions.note })
      .from(protocolVersions)
      .where(eq(protocolVersions.studyId, fx.studyId));
    expect(row?.note).toBe("initial protocol");
  });
});
