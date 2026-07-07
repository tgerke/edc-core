import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password.js";
import { grantRole } from "../auth/rbac.js";
import { createDb, databaseUrl } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { auditEvents, roles, signatures, sites, studies, users } from "../db/schema/index.js";
import { buildServer } from "../server.js";
import { computeRecordHash } from "../services/signatures.js";
import { importStudyBuild } from "../services/study-builds.js";

const { db, client } = createDb();
let dbAvailable = false;
try {
  await client`SELECT 1`;
  dbAvailable = true;
} catch {
  if (process.env.CI) throw new Error(`CI requires a reachable database at ${databaseUrl()}`);
  console.warn(`⚠ Skipping signature tests: no database at ${databaseUrl()}.`);
}

const ODM = `<ODM xmlns="http://www.cdisc.org/ns/odm/v2.0" FileOID="SIG" FileType="Snapshot"
    ODMVersion="2.0" CreationDateTime="2026-07-05T00:00:00Z" Granularity="Metadata">
  <Study OID="ST.SIG" StudyName="Signature Study">
    <MetaDataVersion OID="MDV.1" Name="v1">
      <StudyEventDef OID="SE.V1" Name="Visit 1" Repeating="No" Type="Scheduled">
        <ItemGroupRef ItemGroupOID="FO.VS" Mandatory="Yes"/>
      </StudyEventDef>
      <ItemGroupDef OID="FO.VS" Name="Vital Signs" Type="Form" Repeating="No">
        <ItemGroupRef ItemGroupOID="IG.VS" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemGroupDef OID="IG.VS" Name="Vitals" Type="Section" Repeating="No">
        <ItemRef ItemOID="IT.HR" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemDef OID="IT.HR" Name="Heart rate" DataType="integer"/>
    </MetaDataVersion>
  </Study>
</ODM>`;

const PASSWORD = "correct-Horse-battery-7";

describe.skipIf(!dbAvailable)("Part 11 e-signatures", () => {
  let server: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const fx = { studyId: "", formId: "", invToken: "", invId: "", entryToken: "" };

  async function makeUser(name: string, roleName: string, studyId: string) {
    const [user] = await db
      .insert(users)
      .values({
        username: `${name}-${suffix}`,
        email: `${name}-${suffix}@example.com`,
        fullName: `Dr ${name}`,
        passwordHash: await hashPassword(PASSWORD),
      })
      .returning();
    const [role] = await db.select().from(roles).where(eq(roles.name, roleName));
    if (!user || !role) throw new Error("fixture failed");
    await grantRole(db, { userId: user.id, studyId, roleId: role.id, grantedBy: user.id });
    const token = (
      await server.inject({
        method: "POST",
        url: "/auth/login",
        payload: { username: `${name}-${suffix}`, password: PASSWORD },
      })
    ).json().token;
    return { user, token };
  }

  function sign(payload: object) {
    return server.inject({
      method: "POST",
      url: `/forms/${fx.formId}/sign`,
      payload,
      headers: { authorization: `Bearer ${fx.invToken}` },
    });
  }

  beforeAll(async () => {
    await runMigrations();
    server = await buildServer({ db });
    await server.ready();

    const [study] = await db
      .insert(studies)
      .values({ oid: `ST.SIG.${suffix}`, name: "Signature Study" })
      .returning();
    if (!study) throw new Error("fixture failed");
    fx.studyId = study.id;
    const [site] = await db
      .insert(sites)
      .values({ studyId: study.id, oid: "SITE.1", name: "Site" })
      .returning();
    if (!site) throw new Error("fixture failed");

    const inv = await makeUser("inv", "investigator", study.id);
    const entry = await makeUser("de", "data_entry", study.id);
    fx.invToken = inv.token;
    fx.invId = inv.user.id;
    fx.entryToken = entry.token;

    const imported = await importStudyBuild(db, {
      studyId: study.id,
      content: ODM,
      actorId: inv.user.id,
    });
    if (!imported.ok) throw new Error(`import failed: ${JSON.stringify(imported.issues)}`);

    const subject = (
      await server.inject({
        method: "POST",
        url: `/studies/${study.id}/subjects`,
        payload: { siteId: site.id, subjectKey: "S-001" },
        headers: { authorization: `Bearer ${fx.invToken}` },
      })
    ).json();
    fx.formId = (
      await server.inject({
        method: "POST",
        url: `/subjects/${subject.id}/forms`,
        payload: { eventOid: "SE.V1", formOid: "FO.VS" },
        headers: { authorization: `Bearer ${fx.invToken}` },
      })
    ).json().id;

    await server.inject({
      method: "PUT",
      url: `/forms/${fx.formId}/items`,
      payload: { itemGroupOid: "IG.VS", itemOid: "IT.HR", value: "72" },
      headers: { authorization: `Bearer ${fx.invToken}` },
    });
    await server.inject({
      method: "POST",
      url: `/forms/${fx.formId}/status`,
      payload: { action: "complete" },
      headers: { authorization: `Bearer ${fx.invToken}` },
    });
  });

  afterAll(async () => {
    await server.close();
    await client.end();
  });

  it("rejects signing without valid re-authentication", async () => {
    const wrongPassword = await sign({
      username: `inv-${suffix}`,
      password: "wrong-password-1",
      meaning: "Investigator approval",
    });
    expect(wrongPassword.statusCode).toBe(403);

    // Someone else's (valid) credentials cannot sign for the session user.
    const wrongUser = await sign({
      username: `de-${suffix}`,
      password: PASSWORD,
      meaning: "Investigator approval",
    });
    expect(wrongUser.statusCode).toBe(403);

    const trail = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.actorId, fx.invId), eq(auditEvents.action, "signature.reauth_failed")),
      );
    expect(trail.length).toBeGreaterThanOrEqual(2);
  });

  it("data entry role lacks data.sign", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/forms/${fx.formId}/sign`,
      payload: { username: `de-${suffix}`, password: PASSWORD, meaning: "Approval" },
      headers: { authorization: `Bearer ${fx.entryToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("signs a complete form with re-auth, binding hash and manifest", async () => {
    const expectedHash = await computeRecordHash(db, fx.formId);
    const res = await sign({
      username: `inv-${suffix}`,
      password: PASSWORD,
      meaning: "Investigator approval",
    });
    expect(res.statusCode).toBe(201);

    const form = (
      await server.inject({
        method: "GET",
        url: `/forms/${fx.formId}`,
        headers: { authorization: `Bearer ${fx.invToken}` },
      })
    ).json();
    expect(form.context.status).toBe("signed");
    expect(form.signatures).toHaveLength(1);
    expect(form.signatures[0].signerName).toBe("Dr inv");
    expect(form.signatures[0].meaning).toBe("Investigator approval");
    expect(form.signatures[0].recordHash).toBe(expectedHash);
    expect(form.signatures[0].invalidatedAt).toBeNull();
  });

  it("cannot sign twice or write to a signed form", async () => {
    const again = await sign({
      username: `inv-${suffix}`,
      password: PASSWORD,
      meaning: "Approval",
    });
    expect(again.statusCode).toBe(409);

    const write = await server.inject({
      method: "PUT",
      url: `/forms/${fx.formId}/items`,
      payload: { itemGroupOid: "IG.VS", itemOid: "IT.HR", value: "80", reasonForChange: "x" },
      headers: { authorization: `Bearer ${fx.invToken}` },
    });
    expect(write.statusCode).toBe(409);
  });

  it("reopening for correction invalidates the signature with audit", async () => {
    const reopen = await server.inject({
      method: "POST",
      url: `/forms/${fx.formId}/status`,
      payload: { action: "reopen" },
      headers: { authorization: `Bearer ${fx.invToken}` },
    });
    expect(reopen.statusCode).toBe(200);
    expect(reopen.json().status).toBe("in_progress");

    const [signature] = await db
      .select()
      .from(signatures)
      .where(eq(signatures.formInstanceId, fx.formId));
    expect(signature?.invalidatedAt).toBeTruthy();
    expect(signature?.invalidatedReason).toBe("form reopened for correction");

    const trail = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityType, "signature"),
          eq(auditEvents.action, "signature.invalidated"),
        ),
      );
    expect(trail.length).toBeGreaterThanOrEqual(1);
  });

  it("a corrected record carries a different hash when re-signed", async () => {
    const before = await computeRecordHash(db, fx.formId);
    await server.inject({
      method: "PUT",
      url: `/forms/${fx.formId}/items`,
      payload: {
        itemGroupOid: "IG.VS",
        itemOid: "IT.HR",
        value: "80",
        reasonForChange: "re-measured",
      },
      headers: { authorization: `Bearer ${fx.invToken}` },
    });
    const after = await computeRecordHash(db, fx.formId);
    expect(after).not.toBe(before);

    await server.inject({
      method: "POST",
      url: `/forms/${fx.formId}/status`,
      payload: { action: "complete" },
      headers: { authorization: `Bearer ${fx.invToken}` },
    });
    const res = await sign({
      username: `inv-${suffix}`,
      password: PASSWORD,
      meaning: "Investigator approval",
    });
    expect(res.statusCode).toBe(201);

    const manifest = await db
      .select()
      .from(signatures)
      .where(eq(signatures.formInstanceId, fx.formId));
    expect(manifest).toHaveLength(2);
    expect(manifest.filter((s) => s.invalidatedAt === null)).toHaveLength(1);
  });
});
