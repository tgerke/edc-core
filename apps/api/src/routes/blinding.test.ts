import { randomUUID } from "node:crypto";
import { parseOdm } from "@edc-core/odm";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password.js";
import { grantRole } from "../auth/rbac.js";
import { createDb, databaseUrl } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { rolePermissions, roles, sites, studies, users } from "../db/schema/index.js";
import { buildServer } from "../server.js";
import { collectCasebookData } from "../services/casebook.js";
import { collectDatasets } from "../services/snapshots.js";
import { importStudyBuild } from "../services/study-builds.js";

const { db, client } = createDb();
let dbAvailable = false;
try {
  await client`SELECT 1`;
  dbAvailable = true;
} catch {
  if (process.env.CI) throw new Error(`CI requires a reachable database at ${databaseUrl()}`);
  console.warn(`⚠ Skipping blinding tests: no database at ${databaseUrl()}.`);
}

// IT.DOSE is blinded; CHK.DOSE references it (import should warn).
const ODM = `<ODM xmlns="http://www.cdisc.org/ns/odm/v2.0"
    xmlns:edc="https://github.com/tgerke/edc-core/ns/odm-ext/v1"
    FileOID="BLD" FileType="Snapshot" ODMVersion="2.0"
    CreationDateTime="2026-07-10T00:00:00Z" Granularity="Metadata">
  <Study OID="ST.BLD" StudyName="Blinding Study">
    <MetaDataVersion OID="MDV.1" Name="v1">
      <StudyEventDef OID="SE.V1" Name="Visit 1" Repeating="No" Type="Scheduled">
        <ItemGroupRef ItemGroupOID="FO.DA" Mandatory="Yes"/>
      </StudyEventDef>
      <ItemGroupDef OID="FO.DA" Name="Dosing" Type="Form" Repeating="No">
        <ItemGroupRef ItemGroupOID="IG.DA" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemGroupDef OID="IG.DA" Name="Dose administration" Type="Section" Repeating="No">
        <ItemRef ItemOID="IT.DOSE" Mandatory="Yes"/>
        <ItemRef ItemOID="IT.ROUTE" Mandatory="No"/>
      </ItemGroupDef>
      <ItemDef OID="IT.DOSE" Name="Dose (mg)" DataType="integer" edc:Blinded="Yes"/>
      <ItemDef OID="IT.ROUTE" Name="Route" DataType="text"/>
      <ConditionDef OID="CHK.DOSE" Name="Dose plausible">
        <Description><TranslatedText xml:lang="en" Type="text/plain">Dose outside the expected range.</TranslatedText></Description>
        <FormalExpression Context="jsonata">\`IT.DOSE\` != null and \`IT.DOSE\` &gt; 100</FormalExpression>
      </ConditionDef>
    </MetaDataVersion>
  </Study>
</ODM>`;

const PASSWORD = "correct-Horse-battery-7";

describe.skipIf(!dbAvailable)("role-based blinding (integration)", () => {
  let server: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const fx = {
    studyId: "",
    subjectId: "",
    formId: "",
    adminToken: "",
    dmToken: "",
    beToken: "",
    importWarnings: [] as { path: string; message: string }[],
  };

  async function makeUser(name: string, roleId: string, studyId: string) {
    const [user] = await db
      .insert(users)
      .values({
        username: `${name}-${suffix}`,
        email: `${name}-${suffix}@example.com`,
        fullName: `Dr ${name}`,
        passwordHash: await hashPassword(PASSWORD),
      })
      .returning();
    if (!user) throw new Error("fixture failed");
    await grantRole(db, { userId: user.id, studyId, roleId, grantedBy: user.id });
    const token = (
      await server.inject({
        method: "POST",
        url: "/auth/login",
        payload: { username: `${name}-${suffix}`, password: PASSWORD },
      })
    ).json().token;
    return { user, token };
  }

  function getForm(token: string) {
    return server.inject({
      method: "GET",
      url: `/forms/${fx.formId}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  beforeAll(async () => {
    await runMigrations();
    server = await buildServer({ db });
    await server.ready();

    const [study] = await db
      .insert(studies)
      .values({ oid: `ST.BLD.${suffix}`, name: "Blinding Study" })
      .returning();
    if (!study) throw new Error("fixture failed");
    fx.studyId = study.id;
    const [site] = await db
      .insert(sites)
      .values({ studyId: study.id, oid: "SITE.1", name: "Site" })
      .returning();
    if (!site) throw new Error("fixture failed");

    const roleRows = await db.select().from(roles);
    const roleId = (name: string) => {
      const role = roleRows.find((r) => r.name === name);
      if (!role) throw new Error(`role ${name} missing`);
      return role.id;
    };
    // A role with data.enter but WITHOUT data.unblind, to exercise the write
    // guard (all seeded entry roles legitimately hold data.unblind).
    const [blindedEntry] = await db
      .insert(roles)
      .values({ name: `blinded_entry_${suffix}`, description: "test: enters, cannot unblind" })
      .returning();
    if (!blindedEntry) throw new Error("fixture failed");
    await db.insert(rolePermissions).values([
      { roleId: blindedEntry.id, permission: "data.enter" },
      { roleId: blindedEntry.id, permission: "subject.enroll" },
    ]);

    const admin = await makeUser("bl-admin", roleId("admin"), study.id);
    const dm = await makeUser("bl-dm", roleId("data_manager"), study.id);
    const be = await makeUser("bl-be", blindedEntry.id, study.id);
    fx.adminToken = admin.token;
    fx.dmToken = dm.token;
    fx.beToken = be.token;

    const imported = await importStudyBuild(db, {
      studyId: study.id,
      content: ODM,
      actorId: admin.user.id,
    });
    if (!imported.ok) throw new Error("import failed");
    fx.importWarnings = imported.warnings as { path: string; message: string }[];

    const subject = (
      await server.inject({
        method: "POST",
        url: `/studies/${study.id}/subjects`,
        payload: { siteId: site.id, subjectKey: "S-001" },
        headers: { authorization: `Bearer ${admin.token}` },
      })
    ).json();
    fx.subjectId = subject.id;
    fx.formId = (
      await server.inject({
        method: "POST",
        url: `/subjects/${subject.id}/forms`,
        payload: { eventOid: "SE.V1", formOid: "FO.DA" },
        headers: { authorization: `Bearer ${admin.token}` },
      })
    ).json().id;

    for (const [itemOid, value] of [
      ["IT.DOSE", "50"],
      ["IT.ROUTE", "oral"],
    ] as const) {
      const res = await server.inject({
        method: "PUT",
        url: `/forms/${fx.formId}/items`,
        payload: { itemGroupOid: "IG.DA", itemOid, value },
        headers: { authorization: `Bearer ${admin.token}` },
      });
      if (res.statusCode !== 201) throw new Error(`write failed: ${res.body}`);
    }
  });

  afterAll(async () => {
    await server.close();
    await client.end();
  });

  it("warns at import when a check references a blinded item", () => {
    expect(fx.importWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "ConditionDef[CHK.DOSE]",
          message: expect.stringContaining("IT.DOSE"),
        }),
      ]),
    );
  });

  it("shows blinded values to holders of data.unblind", async () => {
    const form = (await getForm(fx.adminToken)).json();
    expect(form.blindedItems).toEqual([]);
    const dose = form.values.find((v: { item_oid: string }) => v.item_oid === "IT.DOSE");
    expect(dose.value).toBe("50");
    expect(dose.blinded).toBeUndefined();
  });

  it("masks blinded values for everyone else, keeping the row", async () => {
    const form = (await getForm(fx.dmToken)).json();
    expect(form.blindedItems).toEqual(["IT.DOSE"]);
    const dose = form.values.find((v: { item_oid: string }) => v.item_oid === "IT.DOSE");
    expect(dose.value).toBeNull();
    expect(dose.blinded).toBe(true);
    const route = form.values.find((v: { item_oid: string }) => v.item_oid === "IT.ROUTE");
    expect(route.value).toBe("oral");
  });

  it("rejects writes to blinded items by roles without data.unblind", async () => {
    const denied = await server.inject({
      method: "PUT",
      url: `/forms/${fx.formId}/items`,
      payload: { itemGroupOid: "IG.DA", itemOid: "IT.DOSE", value: "60", reasonForChange: "x" },
      headers: { authorization: `Bearer ${fx.beToken}` },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toMatch(/blinded/);

    const allowed = await server.inject({
      method: "PUT",
      url: `/forms/${fx.formId}/items`,
      payload: {
        itemGroupOid: "IG.DA",
        itemOid: "IT.ROUTE",
        value: "iv",
        reasonForChange: "corrected route",
      },
      headers: { authorization: `Bearer ${fx.beToken}` },
    });
    expect(allowed.statusCode).toBe(201);
  });

  it("masks the casebook rendering unless unblinded", async () => {
    const blindedView = await collectCasebookData(db, {
      studyId: fx.studyId,
      subjectId: fx.subjectId,
    });
    const blindedItems = blindedView.events[0]?.forms[0]?.groups[0]?.items ?? [];
    expect(blindedItems.find((i) => i.itemOid === "IT.DOSE")?.value).toBe("[BLINDED]");
    expect(blindedItems.find((i) => i.itemOid === "IT.ROUTE")?.value).toBe("iv");

    const unblindedView = await collectCasebookData(db, {
      studyId: fx.studyId,
      subjectId: fx.subjectId,
      unblind: true,
    });
    const openItems = unblindedView.events[0]?.forms[0]?.groups[0]?.items ?? [];
    expect(openItems.find((i) => i.itemOid === "IT.DOSE")?.value).toBe("50");
  });

  it("masks blinded item values in audit review for blinded roles only", async () => {
    const asDm = (
      await server.inject({
        method: "GET",
        url: `/studies/${fx.studyId}/audit?entityType=item_value&limit=50`,
        headers: { authorization: `Bearer ${fx.dmToken}` },
      })
    ).json();
    const doseEvents = asDm.events.filter(
      (e: { newValue: { value?: string } | null }) => e.newValue?.value === "[BLINDED]",
    );
    expect(doseEvents.length).toBeGreaterThanOrEqual(1);
    // Route values stay visible; who/when survive on masked rows.
    expect(
      asDm.events.some((e: { newValue: { value?: string } | null }) => e.newValue?.value === "iv"),
    ).toBe(true);
    expect(
      asDm.events.some((e: { newValue: { value?: string } | null }) => e.newValue?.value === "50"),
    ).toBe(false);

    const asAdmin = (
      await server.inject({
        method: "GET",
        url: `/studies/${fx.studyId}/audit?entityType=item_value&limit=50`,
        headers: { authorization: `Bearer ${fx.adminToken}` },
      })
    ).json();
    expect(
      asAdmin.events.some(
        (e: { newValue: { value?: string } | null }) => e.newValue?.value === "50",
      ),
    ).toBe(true);
  });

  it("excludes blinded items from analytics dataset specs", () => {
    const mdv = parseOdm(ODM).study?.metaDataVersions[0];
    if (!mdv) throw new Error("fixture failed");
    const datasets = collectDatasets(mdv);
    const columns = datasets.flatMap((d) => d.columns.map((c) => c.itemOid));
    expect(columns).toContain("IT.ROUTE");
    expect(columns).not.toContain("IT.DOSE");
  });
});
