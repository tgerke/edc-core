import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SiteFormVariantDefinition } from "@edc-core/odm";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password.js";
import { grantRole } from "../auth/rbac.js";
import { createDb, databaseUrl } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { roles, sites, studies, users } from "../db/schema/index.js";
import { buildServer } from "../server.js";

const { db, client } = createDb();
let dbAvailable = false;
try {
  await client`SELECT 1`;
  dbAvailable = true;
} catch {
  if (process.env.CI) throw new Error(`CI requires a reachable database at ${databaseUrl()}`);
  console.warn(
    `⚠ Skipping site-forms integration tests: no database at ${databaseUrl()}. ` +
      "Start one with: podman compose -f infra/compose.yaml up -d postgres",
  );
}

const fixturePath = path.join(
  fileURLToPath(import.meta.url),
  "../../../../../examples/demo-study.xml",
);
const demoOdm = readFileSync(fixturePath, "utf8");

const PASSWORD = "correct-Horse-battery-7";

describe.skipIf(!dbAvailable)("site form variants (integration)", () => {
  let server: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const fx = {
    managerToken: "",
    coordAToken: "",
    coordBToken: "",
    studyId: "",
    siteAId: "",
    siteBId: "",
    variantId: "",
    versionId: "",
    subjectId: "",
    variantFormOid: "",
    definition: null as SiteFormVariantDefinition | null,
  };

  beforeAll(async () => {
    await runMigrations();
    server = await buildServer({ db });
    await server.ready();

    const passwordHash = await hashPassword(PASSWORD);
    const mkUser = async (username: string, isSystemAdmin = false) => {
      const [user] = await db
        .insert(users)
        .values({
          username,
          email: `${username}@example.com`,
          fullName: username,
          passwordHash,
          isSystemAdmin,
        })
        .returning();
      if (!user) throw new Error("fixture failed");
      return user;
    };
    const manager = await mkUser(`sfm-${suffix}`);
    const coordA = await mkUser(`sfa-${suffix}`);
    const coordB = await mkUser(`sfb-${suffix}`);
    const admin = await mkUser(`sfadm-${suffix}`, true);

    const [study] = await db
      .insert(studies)
      .values({ oid: `ST.SF.${suffix}`, name: "Site Forms Study" })
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
    fx.siteBId = siteB.id;

    const roleId = async (name: string) => {
      const [role] = await db.select().from(roles).where(eq(roles.name, name));
      if (!role) throw new Error(`seeded role ${name} missing`);
      return role.id;
    };
    await grantRole(db, {
      userId: manager.id,
      studyId: study.id,
      roleId: await roleId("data_manager"),
      grantedBy: admin.id,
    });
    await grantRole(db, {
      userId: coordA.id,
      studyId: study.id,
      roleId: await roleId("data_entry"),
      siteId: siteA.id,
      grantedBy: admin.id,
    });
    await grantRole(db, {
      userId: coordB.id,
      studyId: study.id,
      roleId: await roleId("data_entry"),
      siteId: siteB.id,
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
    fx.managerToken = await login(`sfm-${suffix}`);
    fx.coordAToken = await login(`sfa-${suffix}`);
    fx.coordBToken = await login(`sfb-${suffix}`);

    // Publish the demo build.
    const imported = await server.inject({
      method: "POST",
      url: `/studies/${fx.studyId}/metadata-versions`,
      headers: { authorization: `Bearer ${fx.managerToken}` },
      payload: { content: demoOdm, note: "baseline" },
    });
    if (imported.statusCode !== 201) throw new Error(`build import failed: ${imported.body}`);

    // Enroll a subject at site A.
    const enrolled = await server.inject({
      method: "POST",
      url: `/studies/${fx.studyId}/subjects`,
      headers: { authorization: `Bearer ${fx.coordAToken}` },
      payload: { subjectKey: "SF-001", siteId: fx.siteAId },
    });
    if (enrolled.statusCode !== 201) throw new Error(`enroll failed: ${enrolled.body}`);
    fx.subjectId = enrolled.json().id;
  });

  afterAll(async () => {
    // The DB client is shared with the amendment suite below; it closes there.
    await server.close();
  });

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  it("rejects variant authoring for another site (site-scoped RBAC)", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/studies/${fx.studyId}/sites/${fx.siteAId}/form-variants`,
      headers: auth(fx.coordBToken),
      payload: { name: "Not my site" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("creates a variant seeded from the standard layout", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/studies/${fx.studyId}/sites/${fx.siteAId}/form-variants`,
      headers: auth(fx.coordAToken),
      payload: { name: "Screening workflow", seedEventOids: ["SE.SCREENING"] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    fx.variantId = body.variantId;
    fx.versionId = body.versionId;
    fx.definition = body.definition;
    expect(body.issues).toEqual([]);
    expect(body.definition.events[0].eventOid).toBe("SE.SCREENING");
  });

  it("saves a regrouped draft version and reports coverage issues live", async () => {
    if (!fx.definition) throw new Error("no seeded definition");
    const allRefs = fx.definition.events[0]?.forms.flatMap((f) =>
      f.sections.flatMap((s) => s.itemRefs),
    );
    if (!allRefs) throw new Error("unreachable");
    const merged: SiteFormVariantDefinition = {
      events: [
        {
          eventOid: "SE.SCREENING",
          forms: [
            {
              oid: "V.SCREENING_ONE_PAGE",
              name: "Screening (one page)",
              sections: [
                {
                  label: "Clinic order",
                  itemRefs: [...allRefs].reverse().map((ref, index) => ({
                    itemOid: ref.itemOid,
                    mandatory: ref.mandatory,
                    orderNumber: index + 1,
                  })),
                },
              ],
            },
          ],
        },
      ],
    };
    const res = await server.inject({
      method: "POST",
      url: `/studies/${fx.studyId}/sites/${fx.siteAId}/form-variants/${fx.variantId}/versions`,
      headers: auth(fx.coordAToken),
      payload: { definition: merged },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().issues).toEqual([]);
    fx.versionId = res.json().versionId;
    fx.variantFormOid = "V.SCREENING_ONE_PAGE";

    // A broken draft can be saved, but the validator reports it.
    const broken = structuredClone(merged);
    broken.events[0]?.forms[0]?.sections[0]?.itemRefs.pop();
    const brokenRes = await server.inject({
      method: "POST",
      url: `/studies/${fx.studyId}/sites/${fx.siteAId}/form-variants/${fx.variantId}/versions`,
      headers: auth(fx.coordAToken),
      payload: { definition: broken },
    });
    expect(brokenRes.statusCode).toBe(201);
    expect(
      (brokenRes.json().issues as { message: string }[]).some((i) =>
        i.message.includes("missing from the variant"),
      ),
    ).toBe(true);
  });

  it("walks submit → approve with sponsor decision", async () => {
    const submit = await server.inject({
      method: "POST",
      url: `/studies/${fx.studyId}/sites/${fx.siteAId}/form-variants/versions/${fx.versionId}/submit`,
      headers: auth(fx.coordAToken),
    });
    expect(submit.statusCode).toBe(200);
    expect(submit.json().status).toBe("submitted");

    const queue = await server.inject({
      method: "GET",
      url: `/studies/${fx.studyId}/form-variant-approvals`,
      headers: auth(fx.managerToken),
    });
    expect(queue.statusCode).toBe(200);
    expect(queue.json().some((v: { versionId: string }) => v.versionId === fx.versionId)).toBe(
      true,
    );

    const approve = await server.inject({
      method: "POST",
      url: `/studies/${fx.studyId}/form-variants/versions/${fx.versionId}/approve`,
      headers: auth(fx.managerToken),
      payload: { note: "Workflow looks sensible" },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().status).toBe("approved");
  });

  it("serves effective forms per site: variant for A, standard for B", async () => {
    const forA = await server.inject({
      method: "GET",
      url: `/studies/${fx.studyId}/sites/${fx.siteAId}/effective-forms?eventOid=SE.SCREENING`,
      headers: auth(fx.coordAToken),
    });
    expect(forA.statusCode).toBe(200);
    expect(forA.json().source).toBe("variant");
    expect(forA.json().forms[0].oid).toBe("V.SCREENING_ONE_PAGE");

    const forB = await server.inject({
      method: "GET",
      url: `/studies/${fx.studyId}/sites/${fx.siteBId}/effective-forms?eventOid=SE.SCREENING`,
      headers: auth(fx.coordBToken),
    });
    expect(forB.statusCode).toBe(200);
    expect(forB.json().source).toBe("standard");
  });

  it("captures through the variant with the canonical data shape", async () => {
    const ensure = await server.inject({
      method: "POST",
      url: `/subjects/${fx.subjectId}/forms`,
      headers: auth(fx.coordAToken),
      payload: { eventOid: "SE.SCREENING", formOid: fx.variantFormOid },
    });
    expect(ensure.statusCode).toBe(201);
    const formInstanceId = ensure.json().formInstanceId ?? ensure.json().id;

    const form = await server.inject({
      method: "GET",
      url: `/forms/${formInstanceId}`,
      headers: auth(fx.coordAToken),
    });
    expect(form.statusCode).toBe(200);
    expect(form.json().context.siteFormVariantVersionId).toBe(fx.versionId);
    expect(form.json().variantDefinition).not.toBeNull();

    // Writes key on the canonical build group, so the captured shape is
    // identical to a standard-form site.
    const write = await server.inject({
      method: "PUT",
      url: `/forms/${formInstanceId}/items`,
      headers: auth(fx.coordAToken),
      payload: { itemGroupOid: "IG.DM", itemOid: "IT.DM.SEX", value: "M" },
    });
    expect([200, 201]).toContain(write.statusCode);

    const rows = await db.execute<{ item_group_oid: string; value: string }>(
      sql`SELECT item_group_oid, value FROM item_value_versions
          WHERE form_instance_id = ${formInstanceId} AND item_oid = 'IT.DM.SEX'`,
    );
    expect(rows[0]?.item_group_oid).toBe("IG.DM");
    expect(rows[0]?.value).toBe("M");
  });

  it("rejects variant form instances at sites without an approved variant", async () => {
    const enrolled = await server.inject({
      method: "POST",
      url: `/studies/${fx.studyId}/subjects`,
      headers: auth(fx.coordBToken),
      payload: { subjectKey: "SF-002", siteId: fx.siteBId },
    });
    expect(enrolled.statusCode).toBe(201);
    const res = await server.inject({
      method: "POST",
      url: `/subjects/${enrolled.json().id}/forms`,
      headers: auth(fx.coordBToken),
      payload: { eventOid: "SE.SCREENING", formOid: fx.variantFormOid },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe.skipIf(!dbAvailable)("amendment integration for variants (integration)", () => {
  // Reuses the DB from the suite above via fresh fixtures.
  let server: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const fx = { managerToken: "", coordToken: "", studyId: "", siteId: "", versionId: "" };

  beforeAll(async () => {
    await runMigrations();
    server = await buildServer({ db });
    await server.ready();

    const passwordHash = await hashPassword(PASSWORD);
    const mkUser = async (username: string, isSystemAdmin = false) => {
      const [user] = await db
        .insert(users)
        .values({
          username,
          email: `${username}@example.com`,
          fullName: username,
          passwordHash,
          isSystemAdmin,
        })
        .returning();
      if (!user) throw new Error("fixture failed");
      return user;
    };
    const manager = await mkUser(`amm-${suffix}`);
    const coord = await mkUser(`amc-${suffix}`);
    const admin = await mkUser(`amadm-${suffix}`, true);
    const [study] = await db
      .insert(studies)
      .values({ oid: `ST.AM.${suffix}`, name: "Amendment Variants Study" })
      .returning();
    const [site] = await db
      .insert(sites)
      .values({ studyId: study?.id ?? "", oid: "SITE.AM", name: "Amendment Site" })
      .returning();
    if (!study || !site) throw new Error("fixture failed");
    fx.studyId = study.id;
    fx.siteId = site.id;

    const roleId = async (name: string) => {
      const [role] = await db.select().from(roles).where(eq(roles.name, name));
      if (!role) throw new Error(`seeded role ${name} missing`);
      return role.id;
    };
    await grantRole(db, {
      userId: manager.id,
      studyId: study.id,
      roleId: await roleId("data_manager"),
      grantedBy: admin.id,
    });
    await grantRole(db, {
      userId: coord.id,
      studyId: study.id,
      roleId: await roleId("data_entry"),
      siteId: site.id,
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
    fx.managerToken = await login(`amm-${suffix}`);
    fx.coordToken = await login(`amc-${suffix}`);

    const imported = await server.inject({
      method: "POST",
      url: `/studies/${fx.studyId}/metadata-versions`,
      headers: { authorization: `Bearer ${fx.managerToken}` },
      payload: { content: demoOdm, note: "baseline" },
    });
    if (imported.statusCode !== 201) throw new Error(`build import failed: ${imported.body}`);

    // Approved screening variant.
    const created = await server.inject({
      method: "POST",
      url: `/studies/${fx.studyId}/sites/${fx.siteId}/form-variants`,
      headers: { authorization: `Bearer ${fx.coordToken}` },
      payload: { name: "Clinic flow", seedEventOids: ["SE.SCREENING"] },
    });
    if (created.statusCode !== 201) throw new Error(`variant create failed: ${created.body}`);
    fx.versionId = created.json().versionId;
    await server.inject({
      method: "POST",
      url: `/studies/${fx.studyId}/sites/${fx.siteId}/form-variants/versions/${fx.versionId}/submit`,
      headers: { authorization: `Bearer ${fx.coordToken}` },
    });
    const approved = await server.inject({
      method: "POST",
      url: `/studies/${fx.studyId}/form-variants/versions/${fx.versionId}/approve`,
      headers: { authorization: `Bearer ${fx.managerToken}` },
      payload: {},
    });
    if (approved.statusCode !== 200) throw new Error(`approve failed: ${approved.body}`);
  });

  afterAll(async () => {
    await server.close();
    await client.end();
  });

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  it("carries an equivalent variant forward across an untouched amendment", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/studies/${fx.studyId}/metadata-versions`,
      headers: auth(fx.managerToken),
      payload: { content: demoOdm, note: "amendment without screening changes" },
    });
    expect(res.statusCode).toBe(201);

    const effective = await server.inject({
      method: "GET",
      url: `/studies/${fx.studyId}/sites/${fx.siteId}/effective-forms?eventOid=SE.SCREENING`,
      headers: auth(fx.coordToken),
    });
    expect(effective.json().source).toBe("variant");

    const variants = await server.inject({
      method: "GET",
      url: `/studies/${fx.studyId}/sites/${fx.siteId}/form-variants`,
      headers: auth(fx.coordToken),
    });
    const latest = variants.json()[0].latest;
    expect(latest.status).toBe("approved");
    expect(latest.decisionNote).toContain("carried forward");
  });

  it("stales the variant when the amendment changes its events, falling back to standard forms", async () => {
    const amended = demoOdm
      .replace(
        '<ItemRef ItemOID="IT.DM.BRTHDTC" Mandatory="Yes"/>',
        '<ItemRef ItemOID="IT.DM.BRTHDTC" Mandatory="Yes"/>\n        <ItemRef ItemOID="IT.DM.SITEREF" Mandatory="No"/>',
      )
      .replace(
        '<ItemDef DataType="date" Name="Birth Date" OID="IT.DM.BRTHDTC">',
        '<ItemDef DataType="text" Name="Referring Site" OID="IT.DM.SITEREF">\n        <Question><TranslatedText xml:lang="en" Type="text/plain">Referring site</TranslatedText></Question>\n      </ItemDef>\n      <ItemDef DataType="date" Name="Birth Date" OID="IT.DM.BRTHDTC">',
      );
    const res = await server.inject({
      method: "POST",
      url: `/studies/${fx.studyId}/metadata-versions`,
      headers: auth(fx.managerToken),
      payload: { content: amended, note: "amendment adding a screening item" },
    });
    expect(res.statusCode).toBe(201);

    const effective = await server.inject({
      method: "GET",
      url: `/studies/${fx.studyId}/sites/${fx.siteId}/effective-forms?eventOid=SE.SCREENING`,
      headers: auth(fx.coordToken),
    });
    expect(effective.json().source).toBe("standard");

    const variants = await server.inject({
      method: "GET",
      url: `/studies/${fx.studyId}/sites/${fx.siteId}/form-variants`,
      headers: auth(fx.coordToken),
    });
    const versions = variants.json()[0].versions as { status: string }[];
    expect(versions.some((v) => v.status === "stale")).toBe(true);

    const notifications = await server.inject({
      method: "GET",
      url: "/notifications",
      headers: auth(fx.coordToken),
    });
    expect(notifications.statusCode).toBe(200);
    const items = notifications.json().items ?? notifications.json();
    expect(JSON.stringify(items).includes("needs an update")).toBe(true);
  });
});
