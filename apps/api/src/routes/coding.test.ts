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
  codingRuns,
  codings,
  dictionaryTerms,
  formInstances,
  rolePermissions,
  roles,
  sites,
  studies,
  users,
} from "../db/schema/index.js";
import { buildServer } from "../server.js";
import { sweepInterruptedCodingRuns } from "../services/coding.js";
import { normalizeTerm } from "../services/dictionaries.js";
import { importStudyBuild } from "../services/study-builds.js";

const { db, client } = createDb();
let dbAvailable = false;
try {
  await client`SELECT 1`;
  dbAvailable = true;
} catch {
  if (process.env.CI) throw new Error(`CI requires a reachable database at ${databaseUrl()}`);
  console.warn(`⚠ Skipping coding tests: no database at ${databaseUrl()}.`);
}

describe("normalizeTerm", () => {
  it("lowercases, trims, and collapses internal whitespace", () => {
    expect(normalizeTerm("  Chest   Pain \n")).toBe("chest pain");
    expect(normalizeTerm("HEADACHE")).toBe("headache");
    expect(normalizeTerm("")).toBe("");
  });
});

/**
 * One event with an AE form (IT.AETERM is the MedDRA target) and a ConMeds
 * form (IT.CMTRT is the WHODrug target). IT.SECRET is blinded AND flagged
 * for coding — the blinded flag must win and keep it out of every coding
 * surface. IT.AEDT is an ordinary date item (not a coding target).
 */
function odm(): string {
  return `<ODM xmlns="http://www.cdisc.org/ns/odm/v2.0"
      xmlns:edc="https://github.com/tgerke/edc-core/ns/odm-ext/v1"
      FileOID="COD1" FileType="Snapshot"
      ODMVersion="2.0" CreationDateTime="2026-07-10T00:00:00Z" Granularity="Metadata">
    <Study OID="ST.COD" StudyName="Coding Study">
      <MetaDataVersion OID="MDV.1" Name="v1">
        <StudyEventDef OID="SE.V1" Name="Visit 1" Repeating="No" Type="Scheduled">
          <ItemGroupRef ItemGroupOID="FO.AE" Mandatory="Yes"/>
          <ItemGroupRef ItemGroupOID="FO.CM" Mandatory="No"/>
        </StudyEventDef>
        <ItemGroupDef OID="FO.AE" Name="Adverse Events" Type="Form" Repeating="No">
          <ItemGroupRef ItemGroupOID="IG.AE" Mandatory="Yes"/>
        </ItemGroupDef>
        <ItemGroupDef OID="IG.AE" Name="Adverse event" Type="Section" Repeating="No">
          <ItemRef ItemOID="IT.AETERM" Mandatory="No"/>
          <ItemRef ItemOID="IT.AEDT" Mandatory="No"/>
          <ItemRef ItemOID="IT.SECRET" Mandatory="No"/>
        </ItemGroupDef>
        <ItemGroupDef OID="FO.CM" Name="Concomitant Medications" Type="Form" Repeating="No">
          <ItemGroupRef ItemGroupOID="IG.CM" Mandatory="Yes"/>
        </ItemGroupDef>
        <ItemGroupDef OID="IG.CM" Name="Medication" Type="Section" Repeating="No">
          <ItemRef ItemOID="IT.CMTRT" Mandatory="No"/>
        </ItemGroupDef>
        <ItemDef OID="IT.AETERM" Name="Reported Term" DataType="text" edc:CodingDictionary="MedDRA"/>
        <ItemDef OID="IT.AEDT" Name="Onset date" DataType="date"/>
        <ItemDef OID="IT.SECRET" Name="Blinded Term" DataType="text" edc:Blinded="Yes" edc:CodingDictionary="MedDRA"/>
        <ItemDef OID="IT.CMTRT" Name="Reported Medication" DataType="text" edc:CodingDictionary="WHODrug"/>
      </MetaDataVersion>
    </Study>
  </ODM>`;
}

const PASSWORD = "correct-Horse-battery-7";
// Dictionaries are global with unique (type, version); suffix the versions
// so test runs never collide with earlier runs' rows.

const MEDDRA_CSV = [
  "llt_code,llt_term,pt_code,pt_term,hlt_code,hlt_term,hlgt_code,hlgt_term,soc_code,soc_term",
  "90000001,Headache,91000001,Headache,92000001,Headaches NEC,93000001,Headaches,94000001,Nervous system disorders",
  "90000002,Abdominal pain,91000002,Abdominal pain,92000002,Gastrointestinal pain,93000002,GI signs and symptoms,94000002,Gastrointestinal disorders",
  "90000003,Migraine,91000003,Migraine,92000001,Headaches NEC,93000001,Headaches,94000001,Nervous system disorders",
].join("\n");

const WHODRUG_CSV = [
  "code,name,atc_code,atc_text",
  "WD-ASP,Aspirin,N02BA01,Acetylsalicylic acid",
  "WD-IBU,Ibuprofen,M01AE01,Ibuprofen",
  "WD-PAN1,Panadol,N02BE01,Paracetamol",
  "WD-PAN2,Panadol,,",
].join("\n");

describe.skipIf(!dbAvailable)("medical coding (integration)", () => {
  let server: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const MEDDRA_VERSION = `27.1-${suffix}`;
  const WHODRUG_VERSION = `2026Mar-${suffix}`;
  const fx = {
    studyId: "",
    siteId: "",
    sysadminToken: "",
    dmToken: "",
    entryToken: "",
    outsiderToken: "",
    dmId: "",
    s1Id: "",
    s2Id: "",
    meddraId: "",
    whodrugId: "",
    s1AeFormId: "",
    s2AeFormId: "",
    s1CmFormId: "",
    s2CmFormId: "",
  };

  function inject(
    token: string,
    opts: { method: "GET" | "POST" | "PUT"; url: string; payload?: object },
  ) {
    return server.inject({ ...opts, headers: { authorization: `Bearer ${token}` } });
  }

  const aeOccurrence = (formInstanceId: string) => ({
    formInstanceId,
    itemGroupOid: "IG.AE",
    itemGroupRepeatKey: 1,
    itemOid: "IT.AETERM",
  });
  const cmOccurrence = (formInstanceId: string) => ({
    formInstanceId,
    itemGroupOid: "IG.CM",
    itemGroupRepeatKey: 1,
    itemOid: "IT.CMTRT",
  });

  async function latestCoding(formInstanceId: string, itemOid: string) {
    const rows = await db
      .select()
      .from(codings)
      .where(and(eq(codings.formInstanceId, formInstanceId), eq(codings.itemOid, itemOid)))
      .orderBy(codings.version);
    return rows[rows.length - 1] ?? null;
  }

  async function queue(token: string, params = "") {
    const res = await inject(token, {
      method: "GET",
      url: `/studies/${fx.studyId}/coding/items${params}`,
    });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      formInstanceId: string;
      itemOid: string;
      verbatim: string;
      status: string;
      dictionaryType: string;
      coding: { code: string; term: string; verbatim: string; origin: string } | null;
    }[];
  }

  async function pollRun(runId: string) {
    for (let i = 0; i < 100; i++) {
      const res = await inject(fx.dmToken, {
        method: "GET",
        url: `/studies/${fx.studyId}/coding/runs/${runId}`,
      });
      const run = res.json();
      if (run.status !== "running") return run;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("coding run did not finish in time");
  }

  async function runAutoCoding() {
    const res = await inject(fx.dmToken, {
      method: "POST",
      url: `/studies/${fx.studyId}/coding/runs`,
    });
    expect(res.statusCode).toBe(202);
    return pollRun(res.json().runId);
  }

  async function search(type: string, q: string) {
    const res = await inject(fx.dmToken, {
      method: "GET",
      url: `/studies/${fx.studyId}/coding/search?type=${type}&q=${encodeURIComponent(q)}`,
    });
    return res;
  }

  beforeAll(async () => {
    await runMigrations();
    server = await buildServer({ db });
    await server.ready();

    const [study] = await db
      .insert(studies)
      .values({ oid: `ST.COD.${suffix}`, name: "Coding Study" })
      .returning();
    if (!study) throw new Error("fixture failed");
    fx.studyId = study.id;
    const [site] = await db
      .insert(sites)
      .values({ studyId: study.id, oid: "SITE.A", name: "Site A" })
      .returning();
    if (!site) throw new Error("fixture failed");
    fx.siteId = site.id;

    const login = async (username: string) =>
      (
        await server.inject({
          method: "POST",
          url: "/auth/login",
          payload: { username, password: PASSWORD },
        })
      ).json().token;

    const mkUser = async (username: string, roleName: string | null, isSystemAdmin = false) => {
      const [user] = await db
        .insert(users)
        .values({
          username,
          email: `${username}@example.com`,
          fullName: username,
          passwordHash: await hashPassword(PASSWORD),
          isSystemAdmin,
        })
        .returning();
      if (!user) throw new Error("fixture failed");
      if (roleName) {
        const [role] = await db.select().from(roles).where(eq(roles.name, roleName));
        if (!role) throw new Error("fixture failed");
        await grantRole(db, {
          userId: user.id,
          studyId: study.id,
          roleId: role.id,
          grantedBy: user.id,
        });
      }
      return { id: user.id, token: await login(username) };
    };

    // sysadmin: dictionary management only (no clinical permissions).
    // data_manager: study.manage + data.code + data.lock, no data.enter.
    // data_entry: data.enter + data.unblind, no data.code.
    // outsider: authenticated but not a member of the study.
    const sysadmin = await mkUser(`cod-sys-${suffix}`, null, true);
    const dm = await mkUser(`cod-dm-${suffix}`, "data_manager");
    const entry = await mkUser(`cod-entry-${suffix}`, "data_entry");
    const outsider = await mkUser(`cod-out-${suffix}`, null);
    fx.sysadminToken = sysadmin.token;
    fx.dmId = dm.id;
    fx.dmToken = dm.token;
    fx.entryToken = entry.token;
    fx.outsiderToken = outsider.token;

    const v1 = await importStudyBuild(db, { studyId: study.id, content: odm(), actorId: dm.id });
    if (!v1.ok) throw new Error(`build import failed: ${JSON.stringify(v1.issues)}`);

    const enroll = async (subjectKey: string) => {
      const res = await inject(fx.entryToken, {
        method: "POST",
        url: `/studies/${study.id}/subjects`,
        payload: { siteId: site.id, subjectKey },
      });
      if (res.statusCode !== 201) throw new Error(`enroll failed: ${res.body}`);
      return res.json().id as string;
    };
    fx.s1Id = await enroll("S-001");
    fx.s2Id = await enroll("S-002");

    const ensureForm = async (subjectId: string, formOid: string) => {
      const res = await inject(fx.entryToken, {
        method: "POST",
        url: `/subjects/${subjectId}/forms`,
        payload: { eventOid: "SE.V1", formOid },
      });
      if (res.statusCode !== 201) throw new Error(`ensure form failed: ${res.body}`);
      return res.json().id as string;
    };
    const writeItem = async (
      formInstanceId: string,
      itemGroupOid: string,
      itemOid: string,
      value: string,
    ) => {
      const res = await inject(fx.entryToken, {
        method: "PUT",
        url: `/forms/${formInstanceId}/items`,
        payload: { itemGroupOid, itemOid, value },
      });
      if (res.statusCode !== 201) throw new Error(`write failed: ${res.body}`);
    };

    fx.s1AeFormId = await ensureForm(fx.s1Id, "FO.AE");
    fx.s2AeFormId = await ensureForm(fx.s2Id, "FO.AE");
    fx.s1CmFormId = await ensureForm(fx.s1Id, "FO.CM");
    fx.s2CmFormId = await ensureForm(fx.s2Id, "FO.CM");
    await writeItem(fx.s1AeFormId, "IG.AE", "IT.AETERM", "Headache");
    await writeItem(fx.s1AeFormId, "IG.AE", "IT.SECRET", "unblinded dose reaction");
    await writeItem(fx.s2AeFormId, "IG.AE", "IT.AETERM", "stomach ake");
    await writeItem(fx.s1CmFormId, "IG.CM", "IT.CMTRT", "Aspirin");
    // fx.s2CmFormId deliberately left empty for the "nothing to code" test;
    // "Panadol" is written later, after the empty-occurrence assertions.
  });

  afterAll(async () => {
    await server.close();
    await client.end();
  });

  it("seeds data.code to admin and data_manager", async () => {
    const rows = await db
      .select({ name: roles.name })
      .from(rolePermissions)
      .innerJoin(roles, eq(rolePermissions.roleId, roles.id))
      .where(eq(rolePermissions.permission, "data.code"));
    expect(rows.map((r) => r.name).sort()).toEqual(["admin", "data_manager"]);
  });

  it("gates dictionary management to system admins and audits loads", async () => {
    const forbidden = await inject(fx.dmToken, {
      method: "POST",
      url: "/dictionaries",
      payload: { type: "MedDRA", version: MEDDRA_VERSION, content: MEDDRA_CSV },
    });
    expect(forbidden.statusCode).toBe(403);
    expect((await inject(fx.dmToken, { method: "GET", url: "/dictionaries" })).statusCode).toBe(
      403,
    );

    const created = await inject(fx.sysadminToken, {
      method: "POST",
      url: "/dictionaries",
      payload: { type: "MedDRA", version: MEDDRA_VERSION, content: MEDDRA_CSV },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().termsCount).toBe(3);
    fx.meddraId = created.json().id;

    const duplicate = await inject(fx.sysadminToken, {
      method: "POST",
      url: "/dictionaries",
      payload: { type: "MedDRA", version: MEDDRA_VERSION, content: MEDDRA_CSV },
    });
    expect(duplicate.statusCode).toBe(409);

    const whodrug = await inject(fx.sysadminToken, {
      method: "POST",
      url: "/dictionaries",
      payload: { type: "WHODrug", version: WHODRUG_VERSION, content: WHODRUG_CSV },
    });
    expect(whodrug.statusCode).toBe(201);
    expect(whodrug.json().termsCount).toBe(4);
    fx.whodrugId = whodrug.json().id;

    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.action, "dictionary.created"), eq(auditEvents.entityId, fx.meddraId)),
      );
    expect(audit?.studyId).toBeNull();
    expect(audit?.newValue).toMatchObject({
      type: "MedDRA",
      version: MEDDRA_VERSION,
      termsCount: 3,
    });
  });

  it("rejects malformed dictionary CSVs whole", async () => {
    const upload = (content: string) =>
      inject(fx.sysadminToken, {
        method: "POST",
        url: "/dictionaries",
        payload: { type: "WHODrug", version: `bad-${suffix}`, content },
      });

    const badHeader = await upload("code,name\nX,Y");
    expect(badHeader.statusCode).toBe(400);
    expect(badHeader.json().error).toContain("header");

    const emptyRequired = await upload("code,name,atc_code,atc_text\nWD-1,,,");
    expect(emptyRequired.statusCode).toBe(400);
    expect(emptyRequired.json().error).toContain('line 2: column "name" is empty');

    const dupCode = await upload("code,name,atc_code,atc_text\nWD-1,A,,\nWD-1,B,,");
    expect(dupCode.statusCode).toBe(400);
    expect(dupCode.json().error).toContain('line 3: duplicate code "WD-1"');
  });

  it("binds dictionaries per study under study.manage, audited", async () => {
    const forbidden = await inject(fx.entryToken, {
      method: "PUT",
      url: `/studies/${fx.studyId}/coding/settings`,
      payload: { dictionaryType: "MedDRA", dictionaryId: fx.meddraId },
    });
    expect(forbidden.statusCode).toBe(403);

    const wrongType = await inject(fx.dmToken, {
      method: "PUT",
      url: `/studies/${fx.studyId}/coding/settings`,
      payload: { dictionaryType: "WHODrug", dictionaryId: fx.meddraId },
    });
    expect(wrongType.statusCode).toBe(400);
    expect(wrongType.json().error).toContain("is MedDRA, not WHODrug");

    const bound = await inject(fx.dmToken, {
      method: "PUT",
      url: `/studies/${fx.studyId}/coding/settings`,
      payload: { dictionaryType: "MedDRA", dictionaryId: fx.meddraId },
    });
    expect(bound.statusCode).toBe(200);
    expect(bound.json().bindings).toHaveLength(1);

    // Any member sees binding metadata (never term content).
    const settings = await inject(fx.entryToken, {
      method: "GET",
      url: `/studies/${fx.studyId}/coding/settings`,
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json().bindings[0]).toMatchObject({ dictionaryType: "MedDRA" });
    expect(settings.json().availableDictionaries.length).toBeGreaterThanOrEqual(2);

    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.studyId, fx.studyId), eq(auditEvents.action, "study_dictionary.bound")),
      );
    expect(audit?.newValue).toMatchObject({ dictionaryId: fx.meddraId, version: MEDDRA_VERSION });
  });

  it("lists uncoded verbatims, excluding blinded targets and empty values", async () => {
    const items = await queue(fx.dmToken);
    expect(items.every((i) => i.status === "uncoded")).toBe(true);
    // Headache, stomach ake (MedDRA) and Aspirin (WHODrug); the blinded
    // IT.SECRET value and the empty S-002 CM form must not appear.
    expect(items.map((i) => i.verbatim).sort()).toEqual(["Aspirin", "Headache", "stomach ake"]);
    expect(items.some((i) => i.itemOid === "IT.SECRET")).toBe(false);

    const meddraOnly = await queue(fx.dmToken, "?type=MedDRA");
    expect(meddraOnly.map((i) => i.verbatim).sort()).toEqual(["Headache", "stomach ake"]);

    const membersSee = await inject(fx.entryToken, {
      method: "GET",
      url: `/studies/${fx.studyId}/coding/items`,
    });
    expect(membersSee.statusCode).toBe(200);

    const outsider = await inject(fx.outsiderToken, {
      method: "GET",
      url: `/studies/${fx.studyId}/coding/items`,
    });
    expect(outsider.statusCode).toBe(403);
  });

  it("searches the bound dictionary, exact matches first", async () => {
    const unbound = await search("WHODrug", "aspirin");
    expect(unbound.statusCode).toBe(400);
    expect(unbound.json().error).toContain("no WHODrug dictionary bound");

    const hits = await search("MedDRA", "  HEADACHE ");
    expect(hits.statusCode).toBe(200);
    expect(hits.json()[0]).toMatchObject({ code: "90000001", term: "Headache" });

    const substring = await search("MedDRA", "pain");
    expect(substring.statusCode).toBe(200);
    expect(substring.json().map((t: { term: string }) => t.term)).toEqual(["Abdominal pain"]);

    const noPermission = await inject(fx.entryToken, {
      method: "GET",
      url: `/studies/${fx.studyId}/coding/search?type=MedDRA&q=headache`,
    });
    expect(noPermission.statusCode).toBe(403);
  });

  it("guards manual assignment: target items, bound terms, non-empty verbatims", async () => {
    const termId = (await search("MedDRA", "headache")).json()[0].id as string;

    const noPermission = await inject(fx.entryToken, {
      method: "POST",
      url: `/studies/${fx.studyId}/coding/assign`,
      payload: { ...aeOccurrence(fx.s1AeFormId), termId },
    });
    expect(noPermission.statusCode).toBe(403);

    const notTarget = await inject(fx.dmToken, {
      method: "POST",
      url: `/studies/${fx.studyId}/coding/assign`,
      payload: { ...aeOccurrence(fx.s1AeFormId), itemOid: "IT.AEDT", termId },
    });
    expect(notTarget.statusCode).toBe(400);
    expect(notTarget.json().error).toContain("not a coding target");

    const nothingToCode = await inject(fx.dmToken, {
      method: "POST",
      url: `/studies/${fx.studyId}/coding/assign`,
      payload: { ...cmOccurrence(fx.s2CmFormId), termId },
    });
    expect(nothingToCode.statusCode).toBe(400);
    expect(nothingToCode.json().error).toContain("no verbatim value");

    const clearUncoded = await inject(fx.dmToken, {
      method: "POST",
      url: `/studies/${fx.studyId}/coding/clear`,
      payload: aeOccurrence(fx.s1AeFormId),
    });
    expect(clearUncoded.statusCode).toBe(400);
    expect(clearUncoded.json().error).toContain("not coded");

    // A term from a dictionary the study is not bound to must be rejected,
    // even if it is the right type.
    const second = await inject(fx.sysadminToken, {
      method: "POST",
      url: "/dictionaries",
      payload: { type: "MedDRA", version: `28.0-${suffix}`, content: MEDDRA_CSV },
    });
    expect(second.statusCode).toBe(201);
    const [foreignTerm] = await db
      .select({ id: dictionaryTerms.id })
      .from(dictionaryTerms)
      .where(eq(dictionaryTerms.dictionaryId, second.json().id))
      .limit(1);
    if (!foreignTerm) throw new Error("fixture failed");
    const foreign = await inject(fx.dmToken, {
      method: "POST",
      url: `/studies/${fx.studyId}/coding/assign`,
      payload: { ...aeOccurrence(fx.s1AeFormId), termId: foreignTerm.id },
    });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().error).toContain("bound dictionary");
  });

  it("assigns, overrides, and clears codings as audited append-only versions", async () => {
    const headache = (await search("MedDRA", "headache")).json()[0].id as string;
    const migraine = (await search("MedDRA", "migraine")).json()[0].id as string;

    const assigned = await inject(fx.dmToken, {
      method: "POST",
      url: `/studies/${fx.studyId}/coding/assign`,
      payload: { ...aeOccurrence(fx.s1AeFormId), termId: headache },
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json()).toMatchObject({
      version: 1,
      code: "90000001",
      term: "Headache",
      ptTerm: "Headache",
      socTerm: "Nervous system disorders",
      dictionaryVersion: MEDDRA_VERSION,
      verbatim: "Headache",
      origin: "manual",
    });

    const overridden = await inject(fx.dmToken, {
      method: "POST",
      url: `/studies/${fx.studyId}/coding/assign`,
      payload: { ...aeOccurrence(fx.s1AeFormId), termId: migraine, reason: "term selection" },
    });
    expect(overridden.statusCode).toBe(200);
    expect(overridden.json()).toMatchObject({ version: 2, code: "90000003" });

    const cleared = await inject(fx.dmToken, {
      method: "POST",
      url: `/studies/${fx.studyId}/coding/clear`,
      payload: aeOccurrence(fx.s1AeFormId),
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ version: 3, code: null, verbatim: "Headache" });

    const trail = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.studyId, fx.studyId), eq(auditEvents.entityType, "coding")));
    expect(trail.map((e) => e.action).sort()).toEqual([
      "coding.assigned",
      "coding.assigned",
      "coding.cleared",
    ]);
    const override = trail.find((e) => e.reason === "term selection");
    expect(override?.oldValue).toMatchObject({ code: "90000001" });
    expect(override?.newValue).toMatchObject({ code: "90000003", origin: "manual" });

    // Cleared reads as uncoded again.
    const items = await queue(fx.dmToken, "?status=uncoded&type=MedDRA");
    expect(items.map((i) => i.verbatim).sort()).toEqual(["Headache", "stomach ake"]);
  });

  it("auto-codes exact matches and reports the rest", async () => {
    // Bind WHODrug and add the ambiguous verbatim now.
    const bind = await inject(fx.dmToken, {
      method: "PUT",
      url: `/studies/${fx.studyId}/coding/settings`,
      payload: { dictionaryType: "WHODrug", dictionaryId: fx.whodrugId },
    });
    expect(bind.statusCode).toBe(200);
    const write = await inject(fx.entryToken, {
      method: "PUT",
      url: `/forms/${fx.s2CmFormId}/items`,
      payload: { itemGroupOid: "IG.CM", itemOid: "IT.CMTRT", value: "Panadol" },
    });
    expect(write.statusCode).toBe(201);

    const run = await runAutoCoding();
    expect(run.status).toBe("completed_with_errors");
    expect(run.totalOccurrences).toBe(4);
    expect(run.counts).toEqual({
      coded_auto: 2, // Headache, Aspirin
      no_match: 1, // stomach ake
      skipped_ambiguous: 1, // Panadol (two WHODrug codes share the name)
    });
    expect(run.issues).toHaveLength(2);

    const headache = await latestCoding(fx.s1AeFormId, "IT.AETERM");
    expect(headache).toMatchObject({
      origin: "auto",
      code: "90000001",
      codingRunId: run.id,
      version: 4, // appended after the manual assign/override/clear history
    });

    const runAudits = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.studyId, fx.studyId), eq(auditEvents.entityType, "coding_run")));
    expect(runAudits.map((e) => e.action).sort()).toEqual([
      "coding_run.completed",
      "coding_run.started",
    ]);
  });

  it("re-running codes nothing new and never touches coded occurrences", async () => {
    const before = await latestCoding(fx.s1AeFormId, "IT.AETERM");
    const run = await runAutoCoding();
    expect(run.totalOccurrences).toBe(2); // stomach ake + Panadol still uncoded
    expect(run.counts.coded_auto).toBeUndefined();
    const after = await latestCoding(fx.s1AeFormId, "IT.AETERM");
    expect(after?.id).toBe(before?.id);
  });

  it("flags codings as stale when the verbatim changes, and auto-run leaves them alone", async () => {
    const change = await inject(fx.entryToken, {
      method: "PUT",
      url: `/forms/${fx.s1AeFormId}/items`,
      payload: {
        itemGroupOid: "IG.AE",
        itemOid: "IT.AETERM",
        value: "Migraine",
        reasonForChange: "site correction",
      },
    });
    expect(change.statusCode).toBe(201);

    const stale = await queue(fx.dmToken, "?status=stale");
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ verbatim: "Migraine", status: "stale" });
    expect(stale[0]?.coding).toMatchObject({ code: "90000001", verbatim: "Headache" });

    // "Migraine" matches the dictionary exactly, but stale occurrences need
    // a human recode — the run must not pick it up.
    const run = await runAutoCoding();
    expect(run.counts.coded_auto).toBeUndefined();
    expect((await queue(fx.dmToken, "?status=stale")).length).toBe(1);

    // A manual recode clears the staleness.
    const migraine = (await search("MedDRA", "migraine")).json()[0].id as string;
    const recode = await inject(fx.dmToken, {
      method: "POST",
      url: `/studies/${fx.studyId}/coding/assign`,
      payload: { ...aeOccurrence(fx.s1AeFormId), termId: migraine },
    });
    expect(recode.statusCode).toBe(200);
    expect((await queue(fx.dmToken, "?status=stale")).length).toBe(0);
  });

  it("codes locked forms without touching workflow state", async () => {
    const complete = await inject(fx.entryToken, {
      method: "POST",
      url: `/forms/${fx.s1CmFormId}/status`,
      payload: { action: "complete" },
    });
    expect(complete.statusCode).toBe(200);
    const lock = await inject(fx.dmToken, {
      method: "POST",
      url: `/forms/${fx.s1CmFormId}/status`,
      payload: { action: "lock" },
    });
    expect(lock.statusCode).toBe(200);

    const ibuprofen = (await search("WHODrug", "ibuprofen")).json()[0].id as string;
    const recode = await inject(fx.dmToken, {
      method: "POST",
      url: `/studies/${fx.studyId}/coding/assign`,
      payload: { ...cmOccurrence(fx.s1CmFormId), termId: ibuprofen, reason: "coding review" },
    });
    expect(recode.statusCode).toBe(200);
    expect(recode.json()).toMatchObject({ code: "WD-IBU", atcCode: "M01AE01" });

    const [form] = await db
      .select({ status: formInstances.status })
      .from(formInstances)
      .where(eq(formInstances.id, fx.s1CmFormId));
    expect(form?.status).toBe("locked");
  });

  it("rejects a second run while one is running, and sweeps interrupted runs", async () => {
    const [running] = await db
      .insert(codingRuns)
      .values({ studyId: fx.studyId, startedBy: fx.dmId, status: "running" })
      .returning();
    if (!running) throw new Error("fixture failed");

    const rejected = await inject(fx.dmToken, {
      method: "POST",
      url: `/studies/${fx.studyId}/coding/runs`,
    });
    expect(rejected.statusCode).toBe(409);

    const swept = await sweepInterruptedCodingRuns(db);
    expect(swept).toBeGreaterThanOrEqual(1);
    const [after] = await db.select().from(codingRuns).where(eq(codingRuns.id, running.id));
    expect(after?.status).toBe("failed");
    expect(after?.finishedAt).not.toBeNull();
  });

  it("enforces append-only codings at the database level", async () => {
    const coding = await latestCoding(fx.s1CmFormId, "IT.CMTRT");
    if (!coding) throw new Error("fixture failed");
    // drizzle wraps the pg error; the trigger's message is on the cause chain.
    const rejection = async (promise: Promise<unknown>) => {
      try {
        await promise;
        return "";
      } catch (err) {
        const messages: string[] = [];
        for (let e = err; e instanceof Error; e = e.cause) messages.push(e.message);
        return messages.join("; ");
      }
    };
    expect(
      await rejection(
        db.update(codings).set({ code: "TAMPERED" }).where(eq(codings.id, coding.id)),
      ),
    ).toContain("append-only");
    expect(await rejection(db.delete(codings).where(eq(codings.id, coding.id)))).toContain(
      "append-only",
    );
    const [unchanged] = await db.select().from(codings).where(eq(codings.id, coding.id));
    expect(unchanged?.code).toBe("WD-IBU");
  });
});
