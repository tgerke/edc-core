import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { AuthService, ReauthInput } from "../auth/service.js";
import type { Db } from "../db/client.js";
import { auditEvents, formInstances, signatures, users } from "../db/schema/index.js";
import { CaptureError, type FormContext } from "./capture.js";

export class SignatureError extends Error {
  constructor(
    public readonly code: "reauth_failed" | "locked" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

const SIGNABLE_STATUSES = ["complete", "verified"];

/**
 * The signature binds to the exact record content signed (P11-09): a
 * SHA-256 over the form identity, its pinned build, and every current item
 * value with its version number. Any accepted write after signing changes a
 * version, so a recomputed hash exposes tampering even if invalidation
 * bookkeeping were bypassed.
 */
export async function computeRecordHash(db: Db, formInstanceId: string): Promise<string> {
  const [form] = await db
    .select({ metadataVersionId: formInstances.metadataVersionId })
    .from(formInstances)
    .where(eq(formInstances.id, formInstanceId))
    .limit(1);
  const rows = await db.execute<{
    item_group_oid: string;
    item_group_repeat_key: number;
    item_oid: string;
    version: number;
    value: string | null;
  }>(
    sql`SELECT item_group_oid, item_group_repeat_key, item_oid, version, value
        FROM item_values_current WHERE form_instance_id = ${formInstanceId}
        ORDER BY item_group_oid, item_group_repeat_key, item_oid`,
  );
  const canonical = JSON.stringify({
    formInstanceId,
    metadataVersionId: form?.metadataVersionId ?? null,
    values: rows.map((r) => [
      r.item_group_oid,
      r.item_group_repeat_key,
      r.item_oid,
      r.version,
      r.value,
    ]),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Part 11 e-signature: re-authenticates the signer (password re-entry or a
 * fresh-IdP-login grant, either way resolving to the session user), binds the
 * signature to the current record content, and moves the form to `signed` —
 * all subsequent edits go through transitions that invalidate live
 * signatures.
 */
export async function signForm(
  db: Db,
  auth: AuthService,
  context: FormContext,
  input: { actorId: string; reauth: ReauthInput; meaning: string },
) {
  if (!SIGNABLE_STATUSES.includes(context.status)) {
    throw new CaptureError(
      "conflict",
      `cannot sign a ${context.status} form (allowed from: ${SIGNABLE_STATUSES.join(", ")})`,
    );
  }

  const reauth = await auth.reauthenticate(input.actorId, input.reauth);
  if (!reauth.ok) {
    if (reauth.reason === "locked") {
      throw new SignatureError("locked", "account locked after repeated failed attempts");
    }
    throw new SignatureError("reauth_failed", "credentials do not match the signed-in user");
  }

  const recordHash = await computeRecordHash(db, context.formInstanceId);

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(formInstances)
      .set({ status: "signed" })
      .where(
        and(eq(formInstances.id, context.formInstanceId), eq(formInstances.status, context.status)),
      )
      .returning();
    if (!updated) throw new CaptureError("conflict", "form status changed concurrently; retry");

    const [signature] = await tx
      .insert(signatures)
      .values({
        formInstanceId: context.formInstanceId,
        signerId: input.actorId,
        meaning: input.meaning,
        recordHash,
      })
      .returning();
    if (!signature) throw new Error("signature insert returned no row");

    await tx.insert(auditEvents).values({
      actorId: input.actorId,
      studyId: context.studyId,
      action: "form.signed",
      entityType: "signature",
      entityId: signature.id,
      newValue: {
        formInstanceId: context.formInstanceId,
        meaning: input.meaning,
        recordHash,
        previousStatus: context.status,
        reauthMethod: input.reauth.method,
      },
    });
    return signature;
  });
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Invalidates every live signature on the form. Runs inside the transition
 * that makes a form editable again (P11-11: record changes flag existing
 * signatures rather than silently outliving them).
 */
export async function invalidateLiveSignatures(
  tx: Tx,
  context: FormContext,
  actorId: string,
  reason: string,
): Promise<void> {
  const live = await tx
    .update(signatures)
    .set({ invalidatedAt: new Date(), invalidatedReason: reason })
    .where(
      and(eq(signatures.formInstanceId, context.formInstanceId), isNull(signatures.invalidatedAt)),
    )
    .returning();
  for (const signature of live) {
    await tx.insert(auditEvents).values({
      actorId,
      studyId: context.studyId,
      action: "signature.invalidated",
      entityType: "signature",
      entityId: signature.id,
      oldValue: { meaning: signature.meaning, signedAt: signature.signedAt },
      newValue: { reason },
    });
  }
}

export interface SignatureManifestEntry {
  id: string;
  signerName: string;
  signerUsername: string;
  meaning: string;
  recordHash: string;
  signedAt: Date;
  invalidatedAt: Date | null;
  invalidatedReason: string | null;
}

/** Signature manifest for display and inspection copies (P11-10). */
export async function listFormSignatures(
  db: Db,
  formInstanceId: string,
): Promise<SignatureManifestEntry[]> {
  return db
    .select({
      id: signatures.id,
      signerName: users.fullName,
      signerUsername: users.username,
      meaning: signatures.meaning,
      recordHash: signatures.recordHash,
      signedAt: signatures.signedAt,
      invalidatedAt: signatures.invalidatedAt,
      invalidatedReason: signatures.invalidatedReason,
    })
    .from(signatures)
    .innerJoin(users, eq(signatures.signerId, users.id))
    .where(eq(signatures.formInstanceId, formInstanceId))
    .orderBy(signatures.signedAt);
}
