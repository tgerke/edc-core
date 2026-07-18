import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Permission } from "../auth/permissions.js";
import { hasPermission, isStudyMember } from "../auth/rbac.js";
import type { AuthenticatedUser } from "../auth/service.js";
import {
  auditEvents,
  formInstances,
  queries,
  siteFormVariantVersions,
  sites,
  studyEventInstances,
  studyMetadataVersions,
  subjects,
} from "../db/schema/index.js";
import {
  blindedItemOids,
  breakBlind,
  canUnblind,
  listUnblindings,
  maskItemValues,
  UNBLINDING_CATEGORIES,
  unblindedSubjectIds,
} from "../services/blinding.js";
import {
  CaptureError,
  enrollSubject,
  ensureFormInstance,
  FORM_TRANSITIONS,
  type FormTransitionAction,
  latestMetadataVersion,
  resolveFormContext,
  SUBJECT_TRANSITIONS,
  type SubjectTransitionAction,
  transitionForm,
  transitionSubject,
  writeItemValue,
} from "../services/capture.js";
import { generateSubjectCasebook } from "../services/casebook.js";
import { evaluateFormChecks } from "../services/checks.js";
import { ExportError } from "../services/exports.js";
import { listFormSignatures, SignatureError, signForm } from "../services/signatures.js";
import type { StudyBuildDefinition } from "../services/study-builds.js";

const enrollSchema = z.object({
  siteId: z.uuid(),
  subjectKey: z.string().min(1),
  /** "screening" registers a candidate; omitted = enrolled (back-compat). */
  status: z.enum(["screening", "enrolled"]).optional(),
});
const subjectTransitionSchema = z.object({
  action: z.enum(Object.keys(SUBJECT_TRANSITIONS) as [SubjectTransitionAction]),
  reason: z.string().min(1).optional(),
});
const unblindSchema = z.object({
  category: z.enum(UNBLINDING_CATEGORIES),
  reason: z.string().min(1),
});
const ensureFormSchema = z.object({
  eventOid: z.string().min(1),
  eventRepeatKey: z.number().int().positive().optional(),
  formOid: z.string().min(1),
  formRepeatKey: z.number().int().positive().optional(),
});
const writeItemSchema = z.object({
  itemGroupOid: z.string().min(1),
  itemGroupRepeatKey: z.number().int().positive().optional(),
  itemOid: z.string().min(1),
  value: z.string().nullable(),
  reasonForChange: z.string().min(1).optional(),
});
const transitionSchema = z.object({
  action: z.enum(Object.keys(FORM_TRANSITIONS) as [FormTransitionAction]),
});
// Two re-auth mechanisms (P11 §11.200(a)): password re-entry, or a
// single-use grant minted by a fresh interactive IdP login.
const signSchema = z.union([
  z.object({
    username: z.string().min(1),
    password: z.string().min(1),
    meaning: z.string().min(1),
  }),
  z.object({
    reauthGrant: z.string().min(1),
    meaning: z.string().min(1),
  }),
]);

function sendCaptureError(reply: FastifyReply, err: unknown) {
  if (err instanceof CaptureError) {
    const status = { conflict: 409, not_found: 404, invalid: 400 }[err.code];
    return reply.code(status).send({ error: err.message });
  }
  throw err;
}

export const captureRoutes: FastifyPluginAsync = async (app) => {
  async function guard(
    request: FastifyRequest,
    reply: FastifyReply,
    permission: Permission,
    scope: { studyId: string; siteId?: string },
  ): Promise<AuthenticatedUser | null> {
    if (!request.user) {
      await reply.code(401).send({ error: "authentication required" });
      return null;
    }
    if (!(await hasPermission(app.db, request.user.id, permission, scope))) {
      await reply.code(403).send({ error: `missing permission: ${permission}` });
      return null;
    }
    return request.user;
  }

  async function member(
    request: FastifyRequest,
    reply: FastifyReply,
    studyId: string,
  ): Promise<AuthenticatedUser | null> {
    if (!request.user) {
      await reply.code(401).send({ error: "authentication required" });
      return null;
    }
    if (!request.user.isSystemAdmin && !(await isStudyMember(app.db, request.user.id, studyId))) {
      await reply.code(403).send({ error: "not a member of this study" });
      return null;
    }
    return request.user;
  }

  app.post("/studies/:studyId/subjects", async (request, reply) => {
    const { studyId } = request.params as { studyId: string };
    const parsed = enrollSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const user = await guard(request, reply, "subject.enroll", {
      studyId,
      siteId: parsed.data.siteId,
    });
    if (!user) return;
    try {
      const subject = await enrollSubject(app.db, {
        studyId,
        siteId: parsed.data.siteId,
        subjectKey: parsed.data.subjectKey,
        actorId: user.id,
        ...(parsed.data.status ? { status: parsed.data.status } : {}),
      });
      return reply.code(201).send(subject);
    } catch (err) {
      return sendCaptureError(reply, err);
    }
  });

  // Lifecycle transitions are a site act, like enrollment. Statuses are
  // disposition, not locks: forms stay editable after withdrawal.
  app.post("/subjects/:subjectId/status", async (request, reply) => {
    const { subjectId } = request.params as { subjectId: string };
    const parsed = subjectTransitionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const [subject] = await app.db
      .select({ studyId: subjects.studyId, siteId: subjects.siteId })
      .from(subjects)
      .where(eq(subjects.id, subjectId))
      .limit(1);
    if (!subject) return reply.code(404).send({ error: "subject not found" });
    const user = await guard(request, reply, "subject.enroll", {
      studyId: subject.studyId,
      siteId: subject.siteId,
    });
    if (!user) return;

    try {
      return await transitionSubject(app.db, {
        subjectId,
        action: parsed.data.action,
        ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
        actorId: user.id,
      });
    } catch (err) {
      return sendCaptureError(reply, err);
    }
  });

  // The explicit break-the-blind event (E6(R3) Annex 1 §4.1.4). Gated by
  // data.unblind: whoever breaks the blind sees treatment by definition, so
  // the act rides the same audited grant workflow as unblinded access.
  // Recording only — masking of blinded values is unchanged.
  app.post("/subjects/:subjectId/unblind", async (request, reply) => {
    const { subjectId } = request.params as { subjectId: string };
    const parsed = unblindSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const [subject] = await app.db
      .select({ studyId: subjects.studyId, siteId: subjects.siteId })
      .from(subjects)
      .where(eq(subjects.id, subjectId))
      .limit(1);
    if (!subject) return reply.code(404).send({ error: "subject not found" });
    const user = await guard(request, reply, "data.unblind", {
      studyId: subject.studyId,
      siteId: subject.siteId,
    });
    if (!user) return;

    try {
      const event = await breakBlind(app.db, {
        studyId: subject.studyId,
        subjectId,
        category: parsed.data.category,
        reason: parsed.data.reason,
        actorId: user.id,
      });
      return reply.code(201).send(event);
    } catch (err) {
      return sendCaptureError(reply, err);
    }
  });

  // The events carry no treatment values (who/when/why the blind was
  // broken), so they are member-visible like the team grant history.
  app.get("/subjects/:subjectId/unblindings", async (request, reply) => {
    const { subjectId } = request.params as { subjectId: string };
    const [subject] = await app.db
      .select({ studyId: subjects.studyId })
      .from(subjects)
      .where(eq(subjects.id, subjectId))
      .limit(1);
    if (!subject) return reply.code(404).send({ error: "subject not found" });
    if (!(await member(request, reply, subject.studyId))) return;
    return listUnblindings(app.db, subject.studyId, subjectId);
  });

  app.get("/studies/:studyId/subjects", async (request, reply) => {
    const { studyId } = request.params as { studyId: string };
    if (!(await member(request, reply, studyId))) return;
    return app.db
      .select({
        id: subjects.id,
        subjectKey: subjects.subjectKey,
        status: subjects.status,
        siteId: subjects.siteId,
        siteName: sites.name,
        createdAt: subjects.createdAt,
      })
      .from(subjects)
      .innerJoin(sites, eq(subjects.siteId, sites.id))
      .where(eq(subjects.studyId, studyId))
      .orderBy(subjects.subjectKey);
  });

  // Subject matrix: study design (events × forms from the latest build)
  // crossed with per-subject form statuses. Latest is deliberate here — the
  // matrix is the skeleton for *creating* instances (which pin latest); an
  // existing instance renders from its own pinned build on the form page.
  app.get("/studies/:studyId/matrix", async (request, reply) => {
    const { studyId } = request.params as { studyId: string };
    if (!(await member(request, reply, studyId))) return;

    const mdv = await latestMetadataVersion(app.db, studyId);
    if (!mdv) return { buildVersion: null, events: [], subjects: [] };
    const definition = mdv.definition as unknown as StudyBuildDefinition;
    const metadata = definition.metaDataVersion;
    const formsByOid = new Map(metadata.itemGroupDefs.map((g) => [g.oid, g]));
    const events = metadata.studyEventDefs.map((event) => ({
      oid: event.oid,
      name: event.name,
      forms: event.itemGroupRefs
        .map((ref) => formsByOid.get(ref.itemGroupOid))
        .filter((g) => g !== undefined)
        .map((g) => ({ oid: g.oid, name: g.name })),
    }));

    const subjectRows = await app.db
      .select({
        id: subjects.id,
        subjectKey: subjects.subjectKey,
        status: subjects.status,
        siteId: subjects.siteId,
        siteName: sites.name,
      })
      .from(subjects)
      .innerJoin(sites, eq(subjects.siteId, sites.id))
      .where(eq(subjects.studyId, studyId))
      .orderBy(subjects.subjectKey);

    const subjectIds = subjectRows.map((s) => s.id);
    const unblinded = await unblindedSubjectIds(app.db, subjectIds);
    const instanceRows = subjectIds.length
      ? await app.db
          .select({
            subjectId: studyEventInstances.subjectId,
            eventOid: studyEventInstances.eventOid,
            formOid: formInstances.formOid,
            formInstanceId: formInstances.id,
            status: formInstances.status,
          })
          .from(formInstances)
          .innerJoin(
            studyEventInstances,
            eq(formInstances.studyEventInstanceId, studyEventInstances.id),
          )
          .where(inArray(studyEventInstances.subjectId, subjectIds))
      : [];

    const cells = new Map<string, { formInstanceId: string; status: string }>();
    for (const row of instanceRows) {
      cells.set(`${row.subjectId}:${row.eventOid}:${row.formOid}`, {
        formInstanceId: row.formInstanceId,
        status: row.status,
      });
    }

    return {
      buildVersion: mdv.version,
      events,
      subjects: subjectRows.map((subject) => ({
        ...subject,
        unblinded: unblinded.has(subject.id),
        cells: Object.fromEntries(
          events.flatMap((event) =>
            event.forms.map((form) => [
              `${event.oid}:${form.oid}`,
              cells.get(`${subject.id}:${event.oid}:${form.oid}`) ?? null,
            ]),
          ),
        ),
      })),
    };
  });

  app.post("/subjects/:subjectId/forms", async (request, reply) => {
    const { subjectId } = request.params as { subjectId: string };
    const parsed = ensureFormSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const [subject] = await app.db
      .select()
      .from(subjects)
      .where(eq(subjects.id, subjectId))
      .limit(1);
    if (!subject) return reply.code(404).send({ error: "subject not found" });
    const user = await guard(request, reply, "data.enter", {
      studyId: subject.studyId,
      siteId: subject.siteId,
    });
    if (!user) return;

    try {
      const form = await ensureFormInstance(app.db, {
        subjectId,
        eventOid: parsed.data.eventOid,
        formOid: parsed.data.formOid,
        ...(parsed.data.eventRepeatKey ? { eventRepeatKey: parsed.data.eventRepeatKey } : {}),
        ...(parsed.data.formRepeatKey ? { formRepeatKey: parsed.data.formRepeatKey } : {}),
        actorId: user.id,
      });
      return reply.code(201).send(form);
    } catch (err) {
      return sendCaptureError(reply, err);
    }
  });

  // Inspection/retention copy of one subject's data (P11-06). Sits behind
  // the same permission as the other export surfaces.
  app.get("/subjects/:subjectId/casebook", async (request, reply) => {
    const { subjectId } = request.params as { subjectId: string };
    const [subject] = await app.db
      .select()
      .from(subjects)
      .where(eq(subjects.id, subjectId))
      .limit(1);
    if (!subject) return reply.code(404).send({ error: "subject not found" });
    const user = await guard(request, reply, "export.data", { studyId: subject.studyId });
    if (!user) return;

    try {
      const unblind = await canUnblind(app.db, user.id, {
        studyId: subject.studyId,
        siteId: subject.siteId,
      });
      const casebook = await generateSubjectCasebook(app.db, {
        studyId: subject.studyId,
        subjectId,
        unblind,
      });
      await app.db.insert(auditEvents).values({
        actorId: user.id,
        studyId: subject.studyId,
        action: "subject.casebook_exported",
        entityType: "subject",
        entityId: subjectId,
        newValue: { subjectKey: casebook.subjectKey, bytes: casebook.body.length, unblind },
      });
      return reply
        .header("content-type", "application/pdf")
        .header("content-disposition", `attachment; filename="${casebook.filename}"`)
        .send(casebook.body);
    } catch (err) {
      if (err instanceof ExportError) {
        return reply.code(err.code === "not_found" ? 404 : 409).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get("/forms/:formInstanceId", async (request, reply) => {
    const { formInstanceId } = request.params as { formInstanceId: string };
    const context = await resolveFormContext(app.db, formInstanceId);
    if (!context) return reply.code(404).send({ error: "form not found" });
    if (!(await member(request, reply, context.studyId))) return;

    const rawValues = await app.db.execute<{
      item_group_oid: string;
      item_group_repeat_key: number;
      item_oid: string;
      version: number;
      value: string | null;
    }>(
      sql`SELECT item_group_oid, item_group_repeat_key, item_oid, version, value
          FROM item_values_current WHERE form_instance_id = ${formInstanceId}`,
    );
    const [build] = await app.db
      .select({
        version: studyMetadataVersions.version,
        definition: studyMetadataVersions.definition,
      })
      .from(studyMetadataVersions)
      .where(eq(studyMetadataVersions.id, context.metadataVersionId))
      .limit(1);

    // Blinding: mask values of blinded items (per the pinned build) for
    // viewers without data.unblind, and tell the UI which fields to lock.
    const blinded = build
      ? blindedItemOids((build.definition as unknown as StudyBuildDefinition).metaDataVersion)
      : new Set<string>();
    const user = request.user as AuthenticatedUser;
    const unblinded =
      blinded.size === 0 ||
      (await canUnblind(app.db, user.id, { studyId: context.studyId, siteId: context.siteId }));
    const values = unblinded ? rawValues : maskItemValues([...rawValues], blinded);

    const openQueries = await app.db
      .select({
        id: queries.id,
        origin: queries.origin,
        checkOid: queries.checkOid,
        itemGroupRepeatKey: queries.itemGroupRepeatKey,
        createdAt: queries.createdAt,
      })
      .from(queries)
      .where(and(eq(queries.formInstanceId, formInstanceId), eq(queries.status, "open")));
    const formSignatures = await listFormSignatures(app.db, formInstanceId);

    // Variant-captured forms carry the site layout so the renderer can show
    // it; values still key on build item/group OIDs.
    let variantDefinition: unknown = null;
    if (context.siteFormVariantVersionId) {
      const [variantRow] = await app.db
        .select({ definition: siteFormVariantVersions.definition })
        .from(siteFormVariantVersions)
        .where(eq(siteFormVariantVersions.id, context.siteFormVariantVersionId))
        .limit(1);
      variantDefinition = variantRow?.definition ?? null;
    }

    return {
      context,
      buildVersion: build?.version ?? null,
      values,
      blindedItems: unblinded ? [] : [...blinded],
      openQueries,
      signatures: formSignatures,
      variantDefinition,
    };
  });

  // Part 11 e-signature: distinct from /status transitions because it
  // requires re-entry of both credential components at signing time.
  app.post("/forms/:formInstanceId/sign", async (request, reply) => {
    const { formInstanceId } = request.params as { formInstanceId: string };
    const parsed = signSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const context = await resolveFormContext(app.db, formInstanceId);
    if (!context) return reply.code(404).send({ error: "form not found" });
    const user = await guard(request, reply, "data.sign", {
      studyId: context.studyId,
      siteId: context.siteId,
    });
    if (!user) return;

    try {
      const signature = await signForm(app.db, app.authService, context, {
        actorId: user.id,
        reauth:
          "reauthGrant" in parsed.data
            ? { method: "oidc", reauthGrant: parsed.data.reauthGrant }
            : {
                method: "password",
                username: parsed.data.username,
                password: parsed.data.password,
              },
        meaning: parsed.data.meaning,
      });
      return reply.code(201).send({ id: signature.id, signedAt: signature.signedAt });
    } catch (err) {
      if (err instanceof SignatureError) {
        const status = { reauth_failed: 403, locked: 423, conflict: 409 }[err.code];
        return reply.code(status).send({ error: err.message });
      }
      return sendCaptureError(reply, err);
    }
  });

  app.put("/forms/:formInstanceId/items", async (request, reply) => {
    const { formInstanceId } = request.params as { formInstanceId: string };
    const parsed = writeItemSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const context = await resolveFormContext(app.db, formInstanceId);
    if (!context) return reply.code(404).send({ error: "form not found" });
    const user = await guard(request, reply, "data.enter", {
      studyId: context.studyId,
      siteId: context.siteId,
    });
    if (!user) return;

    // A blind role must not overwrite what it cannot see.
    const [pinned] = await app.db
      .select({ definition: studyMetadataVersions.definition })
      .from(studyMetadataVersions)
      .where(eq(studyMetadataVersions.id, context.metadataVersionId))
      .limit(1);
    if (pinned) {
      const blinded = blindedItemOids(
        (pinned.definition as unknown as StudyBuildDefinition).metaDataVersion,
      );
      if (
        blinded.has(parsed.data.itemOid) &&
        !(await canUnblind(app.db, user.id, {
          studyId: context.studyId,
          siteId: context.siteId,
        }))
      ) {
        return reply.code(403).send({ error: "item is blinded: missing permission data.unblind" });
      }
    }

    try {
      const version = await writeItemValue(app.db, context, {
        itemGroupOid: parsed.data.itemGroupOid,
        itemOid: parsed.data.itemOid,
        value: parsed.data.value,
        actorId: user.id,
        ...(parsed.data.itemGroupRepeatKey
          ? { itemGroupRepeatKey: parsed.data.itemGroupRepeatKey }
          : {}),
        ...(parsed.data.reasonForChange ? { reasonForChange: parsed.data.reasonForChange } : {}),
      });
      const findings = await evaluateFormChecks(app.db, context, user.id);
      return reply.code(201).send({ ...version, findings });
    } catch (err) {
      if (err instanceof Error && /reasonForChange is required/.test(err.message)) {
        return reply.code(400).send({ error: err.message });
      }
      return sendCaptureError(reply, err);
    }
  });

  app.post("/forms/:formInstanceId/status", async (request, reply) => {
    const { formInstanceId } = request.params as { formInstanceId: string };
    const parsed = transitionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const context = await resolveFormContext(app.db, formInstanceId);
    if (!context) return reply.code(404).send({ error: "form not found" });
    const transition = FORM_TRANSITIONS[parsed.data.action];
    if (!transition) return reply.code(400).send({ error: "unknown action" });
    const user = await guard(request, reply, transition.permission, {
      studyId: context.studyId,
      siteId: context.siteId,
    });
    if (!user) return;

    try {
      const updated = await transitionForm(app.db, context, parsed.data.action, user.id);
      return { id: updated.id, status: updated.status };
    } catch (err) {
      return sendCaptureError(reply, err);
    }
  });
};
