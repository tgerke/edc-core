import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendItemValue } from "./audit.js";
import { createDb, databaseUrl } from "./client.js";
import { runMigrations } from "./migrate.js";
import {
  auditEvents,
  formInstances,
  itemValueVersions,
  signatures,
  sites,
  studies,
  studyEventInstances,
  studyMetadataVersions,
  subjects,
  users,
} from "./schema/index.js";

// Integration tests: require Postgres (compose stack locally, service
// container in CI). Skipped with a warning when the database is unreachable,
// except in CI where they must run.
const { db, client } = createDb();
let dbAvailable = false;
try {
  await client`SELECT 1`;
  dbAvailable = true;
} catch {
  if (process.env.CI) throw new Error(`CI requires a reachable database at ${databaseUrl()}`);
  console.warn(
    `⚠ Skipping db integration tests: no database at ${databaseUrl()}. ` +
      "Start one with: podman compose -f infra/compose.yaml up -d postgres",
  );
}

// Drizzle wraps database errors; the trigger's message lives in the cause
// chain. Assert the rejection reason wherever it sits.
async function expectRejection(promise: Promise<unknown>, pattern: RegExp) {
  const err: unknown = await promise.then(() => null).catch((e: unknown) => e);
  expect(err, "expected query to be rejected").not.toBeNull();
  const messages: string[] = [];
  for (let e = err; e instanceof Error; e = e.cause) messages.push(e.message);
  expect(messages.join(" | ")).toMatch(pattern);
}

describe.skipIf(!dbAvailable)("audit core (integration)", () => {
  // Fixture chain: user → study → site → subject → event → form instance.
  const fx = {
    userId: "",
    studyId: "",
    formInstanceId: "",
  };

  beforeAll(async () => {
    await runMigrations();

    const suffix = randomUUID().slice(0, 8);
    const [user] = await db
      .insert(users)
      .values({
        username: `test-${suffix}`,
        email: `test-${suffix}@example.com`,
        fullName: "Integration Test User",
        passwordHash: "not-a-real-hash",
      })
      .returning();
    const [study] = await db
      .insert(studies)
      .values({ oid: `ST.TEST.${suffix}`, name: "Integration Test Study" })
      .returning();
    if (!user || !study) throw new Error("fixture insert failed");
    const [site] = await db
      .insert(sites)
      .values({ studyId: study.id, oid: "SITE.001", name: "Test Site" })
      .returning();
    const [mdv] = await db
      .insert(studyMetadataVersions)
      .values({ studyId: study.id, version: 1, definition: {}, createdBy: user.id })
      .returning();
    if (!site || !mdv) throw new Error("fixture insert failed");
    const [subject] = await db
      .insert(subjects)
      .values({ studyId: study.id, siteId: site.id, subjectKey: "001-001" })
      .returning();
    if (!subject) throw new Error("fixture insert failed");
    const [event] = await db
      .insert(studyEventInstances)
      .values({ subjectId: subject.id, eventOid: "SE.SCREENING" })
      .returning();
    if (!event) throw new Error("fixture insert failed");
    const [form] = await db
      .insert(formInstances)
      .values({ studyEventInstanceId: event.id, formOid: "FORM.VS", metadataVersionId: mdv.id })
      .returning();
    if (!form) throw new Error("fixture insert failed");

    fx.userId = user.id;
    fx.studyId = study.id;
    fx.formInstanceId = form.id;
  });

  afterAll(async () => {
    await client.end();
  });

  function vitalsWrite(value: string, reasonForChange?: string) {
    return appendItemValue(db, {
      formInstanceId: fx.formInstanceId,
      itemGroupOid: "IG.VS",
      itemOid: "IT.VS.SYSBP",
      value,
      actorId: fx.userId,
      studyId: fx.studyId,
      ...(reasonForChange ? { reasonForChange } : {}),
    });
  }

  it("appends versions and records audit events in the same transaction", async () => {
    const v1 = await vitalsWrite("120");
    expect(v1.version).toBe(1);

    const v2 = await vitalsWrite("124", "transcription error");
    expect(v2.version).toBe(2);

    const events = await db.select().from(auditEvents).where(eq(auditEvents.studyId, fx.studyId));
    expect(events.map((e) => e.action).sort()).toEqual([
      "item_value.changed",
      "item_value.entered",
    ]);
    const changed = events.find((e) => e.action === "item_value.changed");
    expect(changed?.oldValue).toEqual({ value: "120" });
    expect(changed?.newValue).toEqual({ value: "124" });
    expect(changed?.reason).toBe("transcription error");
  });

  it("requires a reason for change on corrections", async () => {
    await expect(vitalsWrite("130")).rejects.toThrow(/reasonForChange is required/);
  });

  it("exposes only the latest value in item_values_current", async () => {
    const rows = await db.execute(
      sql`SELECT value, version FROM item_values_current
          WHERE form_instance_id = ${fx.formInstanceId} AND item_oid = 'IT.VS.SYSBP'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ value: "124", version: 2 });
  });

  it("rejects UPDATE on item_value_versions at the database level", async () => {
    await expectRejection(
      db
        .update(itemValueVersions)
        .set({ value: "tampered" })
        .where(eq(itemValueVersions.formInstanceId, fx.formInstanceId)),
      /append-only/,
    );
  });

  it("rejects DELETE on item_value_versions at the database level", async () => {
    await expectRejection(
      db.delete(itemValueVersions).where(eq(itemValueVersions.formInstanceId, fx.formInstanceId)),
      /append-only/,
    );
  });

  it("rejects UPDATE and DELETE on audit_events at the database level", async () => {
    await expectRejection(
      db.update(auditEvents).set({ reason: "tampered" }).where(eq(auditEvents.studyId, fx.studyId)),
      /append-only/,
    );
    await expectRejection(
      db.delete(auditEvents).where(eq(auditEvents.studyId, fx.studyId)),
      /append-only/,
    );
  });

  it("permits signature invalidation but nothing else", async () => {
    const [sig] = await db
      .insert(signatures)
      .values({
        formInstanceId: fx.formInstanceId,
        signerId: fx.userId,
        meaning: "Investigator approval",
        recordHash: "deadbeef",
      })
      .returning();
    if (!sig) throw new Error("signature insert failed");

    // Tampering with signed content is rejected.
    await expectRejection(
      db.update(signatures).set({ recordHash: "cafebabe" }).where(eq(signatures.id, sig.id)),
      /immutable/,
    );
    // Deletion is rejected.
    await expectRejection(db.delete(signatures).where(eq(signatures.id, sig.id)), /not permitted/);

    // One-way invalidation is allowed…
    await db
      .update(signatures)
      .set({ invalidatedAt: new Date(), invalidatedReason: "data changed after signing" })
      .where(eq(signatures.id, sig.id));

    // …but an invalidated signature can never be altered again.
    await expectRejection(
      db.update(signatures).set({ invalidatedAt: null }).where(eq(signatures.id, sig.id)),
      /immutable/,
    );
  });
});
