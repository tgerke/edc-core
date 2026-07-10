import { and, desc, eq } from "drizzle-orm";
import type { Permission } from "../auth/permissions.js";
import { appendItemValue, type ItemValueWrite } from "../db/audit.js";
import type { Db } from "../db/client.js";
import {
  auditEvents,
  formInstances,
  sites,
  studyEventInstances,
  studyMetadataVersions,
  subjects,
} from "../db/schema/index.js";
import { notifyPermissionHolders } from "./notifications.js";
import { invalidateLiveSignatures } from "./signatures.js";

export type FormStatus =
  | "not_started"
  | "in_progress"
  | "complete"
  | "verified"
  | "signed"
  | "locked";

export class CaptureError extends Error {
  constructor(
    public readonly code: "conflict" | "not_found" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

/**
 * The entry-workflow state machine (P11-13). Signing is not listed here —
 * it is its own path (services/signatures.ts) because it demands Part 11
 * re-authentication. Any transition back into `in_progress` invalidates
 * live signatures: a record never becomes editable while a signature
 * silently continues to vouch for it (P11-11).
 */
export const FORM_TRANSITIONS: Record<
  string,
  { from: FormStatus[]; to: FormStatus; permission: Permission }
> = {
  complete: { from: ["in_progress"], to: "complete", permission: "data.enter" },
  reopen: { from: ["complete", "signed"], to: "in_progress", permission: "data.enter" },
  verify: { from: ["complete"], to: "verified", permission: "data.verify" },
  unverify: { from: ["verified"], to: "complete", permission: "data.verify" },
  lock: { from: ["complete", "verified", "signed"], to: "locked", permission: "data.lock" },
  unlock: { from: ["locked"], to: "complete", permission: "data.lock" },
};

export type FormTransitionAction = keyof typeof FORM_TRANSITIONS;

const WRITABLE_STATUSES: FormStatus[] = ["not_started", "in_progress"];

export async function latestMetadataVersion(db: Db, studyId: string) {
  const [row] = await db
    .select()
    .from(studyMetadataVersions)
    .where(eq(studyMetadataVersions.studyId, studyId))
    .orderBy(desc(studyMetadataVersions.version))
    .limit(1);
  return row ?? null;
}

export async function enrollSubject(
  db: Db,
  input: { studyId: string; siteId: string; subjectKey: string; actorId: string },
) {
  const [site] = await db
    .select()
    .from(sites)
    .where(and(eq(sites.id, input.siteId), eq(sites.studyId, input.studyId)))
    .limit(1);
  if (!site) throw new CaptureError("invalid", "site does not belong to this study");

  return db.transaction(async (tx) => {
    const [subject] = await tx
      .insert(subjects)
      .values({
        studyId: input.studyId,
        siteId: input.siteId,
        subjectKey: input.subjectKey,
        status: "enrolled",
      })
      .returning();
    if (!subject) throw new Error("subject insert returned no row");
    await tx.insert(auditEvents).values({
      actorId: input.actorId,
      studyId: input.studyId,
      action: "subject.enrolled",
      entityType: "subject",
      entityId: subject.id,
      newValue: { subjectKey: input.subjectKey, siteId: input.siteId },
    });
    return subject;
  });
}

/** Everything permission checks and guards need to know about a form. */
export interface FormContext {
  formInstanceId: string;
  formOid: string;
  status: FormStatus;
  metadataVersionId: string;
  subjectId: string;
  subjectKey: string;
  studyId: string;
  siteId: string;
  eventOid: string;
  eventRepeatKey: number;
}

export async function resolveFormContext(
  db: Db,
  formInstanceId: string,
): Promise<FormContext | null> {
  const [row] = await db
    .select({
      formInstanceId: formInstances.id,
      formOid: formInstances.formOid,
      status: formInstances.status,
      metadataVersionId: formInstances.metadataVersionId,
      subjectId: subjects.id,
      subjectKey: subjects.subjectKey,
      studyId: subjects.studyId,
      siteId: subjects.siteId,
      eventOid: studyEventInstances.eventOid,
      eventRepeatKey: studyEventInstances.repeatKey,
    })
    .from(formInstances)
    .innerJoin(studyEventInstances, eq(formInstances.studyEventInstanceId, studyEventInstances.id))
    .innerJoin(subjects, eq(studyEventInstances.subjectId, subjects.id))
    .where(eq(formInstances.id, formInstanceId))
    .limit(1);
  return (row as FormContext | undefined) ?? null;
}

/**
 * Idempotently creates the event instance and form instance for a subject.
 * The form is pinned to the latest study build at creation time; existing
 * instances keep the build they were captured under.
 */
export async function ensureFormInstance(
  db: Db,
  input: {
    subjectId: string;
    eventOid: string;
    eventRepeatKey?: number;
    formOid: string;
    formRepeatKey?: number;
    actorId: string;
  },
) {
  const eventRepeatKey = input.eventRepeatKey ?? 1;
  const formRepeatKey = input.formRepeatKey ?? 1;

  const [subject] = await db
    .select()
    .from(subjects)
    .where(eq(subjects.id, input.subjectId))
    .limit(1);
  if (!subject) throw new CaptureError("not_found", "subject not found");

  const mdv = await latestMetadataVersion(db, subject.studyId);
  if (!mdv) throw new CaptureError("invalid", "study has no published build");

  return db.transaction(async (tx) => {
    let [event] = await tx
      .select()
      .from(studyEventInstances)
      .where(
        and(
          eq(studyEventInstances.subjectId, input.subjectId),
          eq(studyEventInstances.eventOid, input.eventOid),
          eq(studyEventInstances.repeatKey, eventRepeatKey),
        ),
      )
      .limit(1);
    if (!event) {
      [event] = await tx
        .insert(studyEventInstances)
        .values({
          subjectId: input.subjectId,
          eventOid: input.eventOid,
          repeatKey: eventRepeatKey,
        })
        .returning();
      if (!event) throw new Error("event insert returned no row");
      await tx.insert(auditEvents).values({
        actorId: input.actorId,
        studyId: subject.studyId,
        action: "event_instance.created",
        entityType: "study_event_instance",
        entityId: event.id,
        newValue: { subjectKey: subject.subjectKey, eventOid: input.eventOid, eventRepeatKey },
      });
    }

    let [form] = await tx
      .select()
      .from(formInstances)
      .where(
        and(
          eq(formInstances.studyEventInstanceId, event.id),
          eq(formInstances.formOid, input.formOid),
          eq(formInstances.repeatKey, formRepeatKey),
        ),
      )
      .limit(1);
    if (!form) {
      [form] = await tx
        .insert(formInstances)
        .values({
          studyEventInstanceId: event.id,
          formOid: input.formOid,
          repeatKey: formRepeatKey,
          metadataVersionId: mdv.id,
        })
        .returning();
      if (!form) throw new Error("form insert returned no row");
      await tx.insert(auditEvents).values({
        actorId: input.actorId,
        studyId: subject.studyId,
        action: "form_instance.created",
        entityType: "form_instance",
        entityId: form.id,
        newValue: {
          subjectKey: subject.subjectKey,
          eventOid: input.eventOid,
          formOid: input.formOid,
          buildVersion: mdv.version,
        },
      });
    }
    return form;
  });
}

/**
 * The route-facing item write: enforces the workflow guard (writes only on
 * not_started / in_progress forms — corrections to completed forms require
 * an audited reopen first) and auto-starts entry on the first value.
 */
export async function writeItemValue(
  db: Db,
  context: FormContext,
  write: Omit<ItemValueWrite, "formInstanceId" | "studyId">,
) {
  if (!WRITABLE_STATUSES.includes(context.status)) {
    throw new CaptureError("conflict", `form is ${context.status}; reopen it before changing data`);
  }

  return db.transaction(async (tx) => {
    if (context.status === "not_started") {
      await tx
        .update(formInstances)
        .set({ status: "in_progress" })
        .where(
          and(
            eq(formInstances.id, context.formInstanceId),
            eq(formInstances.status, "not_started"),
          ),
        );
      await tx.insert(auditEvents).values({
        actorId: write.actorId,
        studyId: context.studyId,
        action: "form.status_changed",
        entityType: "form_instance",
        entityId: context.formInstanceId,
        oldValue: { status: "not_started" },
        newValue: { status: "in_progress" },
      });
    }
    return appendItemValue(tx as unknown as Db, {
      ...write,
      formInstanceId: context.formInstanceId,
      studyId: context.studyId,
    });
  });
}

export async function transitionForm(
  db: Db,
  context: FormContext,
  action: FormTransitionAction,
  actorId: string,
) {
  const transition = FORM_TRANSITIONS[action];
  if (!transition) throw new CaptureError("invalid", `unknown action "${action}"`);
  if (!transition.from.includes(context.status)) {
    throw new CaptureError(
      "conflict",
      `cannot ${action} a ${context.status} form (allowed from: ${transition.from.join(", ")})`,
    );
  }

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(formInstances)
      .set({ status: transition.to })
      .where(
        and(eq(formInstances.id, context.formInstanceId), eq(formInstances.status, context.status)),
      )
      .returning();
    if (!updated) {
      throw new CaptureError("conflict", "form status changed concurrently; retry");
    }
    if (transition.to === "in_progress") {
      await invalidateLiveSignatures(tx, context, actorId, `form reopened for correction`);
    }
    await tx.insert(auditEvents).values({
      actorId,
      studyId: context.studyId,
      action: "form.status_changed",
      entityType: "form_instance",
      entityId: context.formInstanceId,
      oldValue: { status: context.status },
      newValue: { status: transition.to, action },
    });
    // There is no signature-request object: "awaiting signature" is derived
    // from the transition into a signable state, and signers hear about it.
    if (transition.to === "complete" || transition.to === "verified") {
      await notifyPermissionHolders(tx as unknown as Db, {
        permission: "data.sign",
        scope: { studyId: context.studyId, siteId: context.siteId },
        excludeUserId: actorId,
        notification: {
          studyId: context.studyId,
          type: "form.awaiting_signature",
          title: `Form ready to sign: ${context.subjectKey}`,
          body: `${context.formOid} marked ${transition.to}`,
          payload: {
            formInstanceId: context.formInstanceId,
            subjectKey: context.subjectKey,
            formOid: context.formOid,
          },
        },
      });
    }
    return updated;
  });
}
