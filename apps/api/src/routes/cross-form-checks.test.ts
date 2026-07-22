import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password.js";
import { grantRole } from "../auth/rbac.js";
import { createDb, databaseUrl } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { roles, sites, studies, users } from "../db/schema/index.js";
import { buildServer } from "../server.js";
import { importStudyBuild } from "../services/study-builds.js";

const { db, client } = createDb();
let dbAvailable = false;
try {
  await client`SELECT 1`;
  dbAvailable = true;
} catch {
  if (process.env.CI) throw new Error(`CI requires a reachable database at ${databaseUrl()}`);
  console.warn(`⚠ Skipping cross-form check tests: no database at ${databaseUrl()}.`);
}

// A cross-form check homed on the AE form (its unqualified item lives
// there) reading the demographics form's visit date (ADR-0015).
const odm = (expression: string) => `<ODM xmlns="http://www.cdisc.org/ns/odm/v2.0"
    FileOID="XFC" FileType="Snapshot" ODMVersion="2.0"
    CreationDateTime="2026-07-21T00:00:00Z" Granularity="Metadata">
  <Study OID="ST.XFC" StudyName="Cross Form Checks">
    <MetaDataVersion OID="MDV.1" Name="v1">
      <StudyEventDef OID="SE.V1" Name="Visit 1" Repeating="No" Type="Scheduled">
        <ItemGroupRef ItemGroupOID="FO.DM" Mandatory="Yes"/>
        <ItemGroupRef ItemGroupOID="FO.AE" Mandatory="No"/>
      </StudyEventDef>
      <ItemGroupDef OID="FO.DM" Name="Demographics" Type="Form" Repeating="No">
        <ItemGroupRef ItemGroupOID="IG.DM" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemGroupDef OID="IG.DM" Name="Demographics section" Type="Section" Repeating="No">
        <ItemRef ItemOID="IT.VISDT" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemGroupDef OID="FO.AE" Name="Adverse Events" Type="Form" Repeating="No">
        <ItemGroupRef ItemGroupOID="IG.AEINFO" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemGroupDef OID="IG.AEINFO" Name="AE details" Type="Section" Repeating="No">
        <ItemRef ItemOID="IT.AESTDT" Mandatory="Yes"/>
        <ItemRef ItemOID="IT.AETERM" Mandatory="No"/>
      </ItemGroupDef>
      <ItemDef OID="IT.VISDT" Name="Visit date" DataType="date"/>
      <ItemDef OID="IT.AESTDT" Name="AE onset date" DataType="date"/>
      <ItemDef OID="IT.AETERM" Name="AE term" DataType="text"/>
      <ConditionDef OID="CHECK.AE_BEFORE_VISIT" Name="AE onset before visit">
        <Description><TranslatedText xml:lang="en">AE onset date is before the visit date</TranslatedText></Description>
        <FormalExpression Context="jsonata">${expression}</FormalExpression>
      </ConditionDef>
    </MetaDataVersion>
  </Study>
</ODM>`;

const CROSS_FORM = "`IT.AESTDT` != null and `IT.AESTDT` &lt; `FO.DM`.`IT.VISDT`";

const PASSWORD = "correct-Horse-battery-7";

describe.skipIf(!dbAvailable)("cross-form edit checks (integration)", () => {
  let server: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const fx = {
    studyId: "",
    siteId: "",
    entryToken: "",
    actorId: "",
    dmFormId: "",
    aeFormId: "",
  };

  beforeAll(async () => {
    await runMigrations();
    server = await buildServer({ db });
    await server.ready();

    const [study] = await db
      .insert(studies)
      .values({ oid: `ST.XFC.${suffix}`, name: "Cross Form Checks" })
      .returning();
    if (!study) throw new Error("fixture failed");
    fx.studyId = study.id;
    const [site] = await db
      .insert(sites)
      .values({ studyId: study.id, oid: "SITE.1", name: "Site" })
      .returning();
    if (!site) throw new Error("fixture failed");
    fx.siteId = site.id;

    const [user] = await db
      .insert(users)
      .values({
        username: `xfc-ent-${suffix}`,
        email: `xfc-ent-${suffix}@example.com`,
        fullName: "Entry",
        passwordHash: await hashPassword(PASSWORD),
      })
      .returning();
    const [role] = await db.select().from(roles).where(eq(roles.name, "data_entry"));
    if (!user || !role) throw new Error("fixture failed");
    await grantRole(db, {
      userId: user.id,
      studyId: study.id,
      roleId: role.id,
      grantedBy: user.id,
    });
    fx.actorId = user.id;
    fx.entryToken = (
      await server.inject({
        method: "POST",
        url: "/auth/login",
        payload: { username: `xfc-ent-${suffix}`, password: PASSWORD },
      })
    ).json().token;

    const imported = await importStudyBuild(db, {
      studyId: study.id,
      content: odm(CROSS_FORM),
      actorId: user.id,
    });
    if (!imported.ok) throw new Error(`import failed: ${JSON.stringify(imported.issues)}`);

    const subject = (
      await server.inject({
        method: "POST",
        url: `/studies/${study.id}/subjects`,
        payload: { siteId: site.id, subjectKey: "XFC-001" },
        headers: { authorization: `Bearer ${fx.entryToken}` },
      })
    ).json();
    for (const [formOid, key] of [
      ["FO.DM", "dmFormId"],
      ["FO.AE", "aeFormId"],
    ] as const) {
      fx[key] = (
        await server.inject({
          method: "POST",
          url: `/subjects/${subject.id}/forms`,
          payload: { eventOid: "SE.V1", formOid },
          headers: { authorization: `Bearer ${fx.entryToken}` },
        })
      ).json().id;
    }
  });

  afterAll(async () => {
    await server.close();
    await client.end();
  });

  async function write(
    formId: string,
    itemGroupOid: string,
    itemOid: string,
    value: string,
    reasonForChange?: string,
  ) {
    const res = await server.inject({
      method: "PUT",
      url: `/forms/${formId}/items`,
      payload: { itemGroupOid, itemOid, value, ...(reasonForChange ? { reasonForChange } : {}) },
      headers: { authorization: `Bearer ${fx.entryToken}` },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json();
  }

  async function aeQueries() {
    const res = await server.inject({
      method: "GET",
      url: `/forms/${fx.aeFormId}/queries`,
      headers: { authorization: `Bearer ${fx.entryToken}` },
    });
    return (res.json() as { checkOid: string | null; status: string }[]).filter(
      (q) => q.checkOid === "CHECK.AE_BEFORE_VISIT",
    );
  }

  it("a write to the referenced form fires the check on its home form", async () => {
    await write(fx.dmFormId, "IG.DM", "IT.VISDT", "2026-06-01");
    expect(await aeQueries()).toEqual([]);

    // AE onset before the visit: the check fires on the AE form itself.
    await write(fx.aeFormId, "IG.AEINFO", "IT.AESTDT", "2026-05-20");
    const afterAe = await aeQueries();
    expect(afterAe.map((q) => q.status)).toEqual(["open"]);
  });

  it("a correcting write to the referenced form auto-closes it", async () => {
    // Visit date moved before the AE onset: problem gone, query closes —
    // triggered by a write to the OTHER form.
    await write(fx.dmFormId, "IG.DM", "IT.VISDT", "2026-05-01", "date corrected");
    const statuses = (await aeQueries()).map((q) => q.status);
    expect(statuses).toEqual(["closed"]);
  });

  it("re-fires on the home form when the referenced data regresses, without duplicates", async () => {
    await write(fx.dmFormId, "IG.DM", "IT.VISDT", "2026-06-15", "date corrected");
    let open = (await aeQueries()).filter((q) => q.status === "open");
    expect(open.length).toBe(1);

    // Same problem re-asserted: reconciliation must not duplicate.
    await write(fx.dmFormId, "IG.DM", "IT.VISDT", "2026-06-20", "date corrected");
    open = (await aeQueries()).filter((q) => q.status === "open");
    expect(open.length).toBe(1);
  });

  it("a missing home-form instance evaluates nothing", async () => {
    const subject = (
      await server.inject({
        method: "POST",
        url: `/studies/${fx.studyId}/subjects`,
        payload: { siteId: fx.siteId, subjectKey: "XFC-002" },
        headers: { authorization: `Bearer ${fx.entryToken}` },
      })
    ).json();
    const dmOnly = (
      await server.inject({
        method: "POST",
        url: `/subjects/${subject.id}/forms`,
        payload: { eventOid: "SE.V1", formOid: "FO.DM" },
        headers: { authorization: `Bearer ${fx.entryToken}` },
      })
    ).json().id;
    const body = await write(dmOnly, "IG.DM", "IT.VISDT", "2026-06-01");
    expect(body.findings ?? []).toEqual([]);
  });

  it("publish rejects a qualified reference to an item not on that form", async () => {
    const [study] = await db
      .insert(studies)
      .values({ oid: `ST.XFC.BAD.${suffix}`, name: "Bad Cross Form" })
      .returning();
    if (!study) throw new Error("fixture failed");
    const result = await importStudyBuild(db, {
      studyId: study.id,
      content: odm("`IT.AESTDT` != null and `IT.AESTDT` &lt; `FO.DM`.`IT.BOGUS`"),
      actorId: fx.actorId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(JSON.stringify(result.issues)).toContain("cross-form reference");
    }
  });
});
