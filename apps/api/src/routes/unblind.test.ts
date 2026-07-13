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
  rolePermissions,
  roles,
  sites,
  studies,
  subjectUnblindings,
  users,
} from "../db/schema/index.js";
import { buildServer } from "../server.js";
import { collectCasebookData } from "../services/casebook.js";

const { db, client } = createDb();
let dbAvailable = false;
try {
  await client`SELECT 1`;
  dbAvailable = true;
} catch {
  if (process.env.CI) throw new Error(`CI requires a reachable database at ${databaseUrl()}`);
  console.warn(`⚠ Skipping unblind tests: no database at ${databaseUrl()}.`);
}

const ODM = `<ODM xmlns="http://www.cdisc.org/ns/odm/v2.0"
    FileOID="UNB" FileType="Snapshot" ODMVersion="2.0"
    CreationDateTime="2026-07-13T00:00:00Z" Granularity="Metadata">
  <Study OID="ST.UNB" StudyName="Unblind Study">
    <MetaDataVersion OID="MDV.1" Name="v1">
      <StudyEventDef OID="SE.V1" Name="Visit 1" Repeating="No" Type="Scheduled">
        <ItemGroupRef ItemGroupOID="FO.GEN" Mandatory="Yes"/>
      </StudyEventDef>
      <ItemGroupDef OID="FO.GEN" Name="General" Type="Form" Repeating="No">
        <ItemGroupRef ItemGroupOID="IG.GEN" Mandatory="Yes"/>
      </ItemGroupDef>
      <ItemGroupDef OID="IG.GEN" Name="General" Type="Section" Repeating="No">
        <ItemRef ItemOID="IT.NOTE" Mandatory="No"/>
      </ItemGroupDef>
      <ItemDef OID="IT.NOTE" Name="Note" DataType="text"/>
    </MetaDataVersion>
  </Study>
</ODM>`;

const PASSWORD = "correct-Horse-battery-7";

// Drizzle wraps database errors; the trigger's message lives in the cause
// chain. Assert the rejection reason wherever it sits.
async function expectRejection(promise: Promise<unknown>, pattern: RegExp) {
  const err: unknown = await promise.then(() => null).catch((e: unknown) => e);
  expect(err, "expected query to be rejected").not.toBeNull();
  const messages: string[] = [];
  for (let e = err; e instanceof Error; e = e.cause) messages.push(e.message);
  expect(messages.join(" | ")).toMatch(pattern);
}

describe.skipIf(!dbAvailable)("break-the-blind (integration)", () => {
  let server: FastifyInstance;
  const suffix = randomUUID().slice(0, 8);
  const fx = {
    studyId: "",
    subjectId: "",
    adminToken: "",
    beToken: "",
    unblindingId: "",
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

  function unblind(token: string, subjectId: string, payload: Record<string, string>) {
    return server.inject({
      method: "POST",
      url: `/subjects/${subjectId}/unblind`,
      payload,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  beforeAll(async () => {
    await runMigrations();
    server = await buildServer({ db });
    await server.ready();

    const [study] = await db
      .insert(studies)
      .values({ oid: `ST.UNB.${suffix}`, name: "Unblind Study" })
      .returning();
    if (!study) throw new Error("fixture failed");
    fx.studyId = study.id;
    const [site] = await db
      .insert(sites)
      .values({ studyId: study.id, oid: "SITE.1", name: "Site" })
      .returning();
    if (!site) throw new Error("fixture failed");

    const roleRows = await db.select().from(roles);
    const adminRole = roleRows.find((r) => r.name === "admin");
    if (!adminRole) throw new Error("role admin missing");
    // A member role WITHOUT data.unblind, to exercise the guard.
    const [blindedEntry] = await db
      .insert(roles)
      .values({ name: `blinded_entry_${suffix}`, description: "test: member, cannot unblind" })
      .returning();
    if (!blindedEntry) throw new Error("fixture failed");
    await db.insert(rolePermissions).values([
      { roleId: blindedEntry.id, permission: "data.enter" },
      { roleId: blindedEntry.id, permission: "subject.enroll" },
    ]);

    const admin = await makeUser("unb-admin", adminRole.id, study.id);
    const be = await makeUser("unb-be", blindedEntry.id, study.id);
    fx.adminToken = admin.token;
    fx.beToken = be.token;

    const buildRes = await server.inject({
      method: "POST",
      url: `/studies/${study.id}/metadata-versions`,
      payload: { content: ODM },
      headers: { authorization: `Bearer ${admin.token}` },
    });
    if (buildRes.statusCode !== 201) throw new Error(`import failed: ${buildRes.body}`);

    const subject = (
      await server.inject({
        method: "POST",
        url: `/studies/${study.id}/subjects`,
        payload: { siteId: site.id, subjectKey: "S-001" },
        headers: { authorization: `Bearer ${admin.token}` },
      })
    ).json();
    fx.subjectId = subject.id;
  });

  afterAll(async () => {
    await server?.close();
    await client.end();
  });

  it("rejects a user without data.unblind and writes nothing", async () => {
    const res = await unblind(fx.beToken, fx.subjectId, {
      category: "emergency",
      reason: "SAE, treatment needed",
    });
    expect(res.statusCode).toBe(403);
    const rows = await db
      .select()
      .from(subjectUnblindings)
      .where(eq(subjectUnblindings.subjectId, fx.subjectId));
    expect(rows).toHaveLength(0);
  });

  it("requires a reason and a known category", async () => {
    const noReason = await unblind(fx.adminToken, fx.subjectId, { category: "emergency" });
    expect(noReason.statusCode).toBe(400);
    const blankReason = await unblind(fx.adminToken, fx.subjectId, {
      category: "emergency",
      reason: "   ",
    });
    expect(blankReason.statusCode).toBe(400);
    const badCategory = await unblind(fx.adminToken, fx.subjectId, {
      category: "curiosity",
      reason: "let me see",
    });
    expect(badCategory.statusCode).toBe(400);
  });

  it("404s on an unknown subject", async () => {
    const res = await unblind(fx.adminToken, randomUUID(), {
      category: "emergency",
      reason: "SAE",
    });
    expect(res.statusCode).toBe(404);
  });

  it("records the event and audits it as subject.unblinded", async () => {
    const res = await unblind(fx.adminToken, fx.subjectId, {
      category: "emergency",
      reason: "SAE on 2026-07-13; treating physician required the assignment",
    });
    expect(res.statusCode).toBe(201);
    const event = res.json();
    expect(event.category).toBe("emergency");
    fx.unblindingId = event.id;

    const audits = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.entityId, fx.subjectId), eq(auditEvents.action, "subject.unblinded")),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.reason).toContain("SAE on 2026-07-13");
    expect(audits[0]?.newValue).toMatchObject({ category: "emergency", unblindingId: event.id });
  });

  it("is append-only at the database level", async () => {
    await expectRejection(
      db
        .update(subjectUnblindings)
        .set({ reason: "tampered" })
        .where(eq(subjectUnblindings.id, fx.unblindingId)),
      /append-only/,
    );
    await expectRejection(
      db.delete(subjectUnblindings).where(eq(subjectUnblindings.id, fx.unblindingId)),
      /append-only/,
    );
  });

  it("lists events for study members, including blinded ones", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/subjects/${fx.subjectId}/unblindings`,
      headers: { authorization: `Bearer ${fx.beToken}` },
    });
    expect(res.statusCode).toBe(200);
    const events = res.json();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ category: "emergency", actorName: "Dr unb-admin" });
    expect(events[0].reason).toContain("SAE on 2026-07-13");
  });

  it("flags the subject in the matrix", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/studies/${fx.studyId}/matrix`,
      headers: { authorization: `Bearer ${fx.adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const subject = res.json().subjects.find((s: { id: string }) => s.id === fx.subjectId) as {
      unblinded: boolean;
    };
    expect(subject.unblinded).toBe(true);
  });

  it("surfaces the event in the casebook", async () => {
    const data = await collectCasebookData(db, {
      studyId: fx.studyId,
      subjectId: fx.subjectId,
    });
    expect(data.unblindings).toHaveLength(1);
    expect(data.unblindings[0]).toMatchObject({
      category: "emergency",
      actorName: "Dr unb-admin",
    });
  });
});
