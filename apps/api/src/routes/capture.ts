import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Permission } from "../auth/permissions.js";
import { hasPermission, isStudyMember } from "../auth/rbac.js";
import type { AuthenticatedUser } from "../auth/service.js";
import { formInstances, sites, studyEventInstances, subjects } from "../db/schema/index.js";
import {
  CaptureError,
  enrollSubject,
  ensureFormInstance,
  FORM_TRANSITIONS,
  type FormTransitionAction,
  latestMetadataVersion,
  resolveFormContext,
  transitionForm,
  writeItemValue,
} from "../services/capture.js";
import type { StudyBuildDefinition } from "../services/study-builds.js";

const enrollSchema = z.object({ siteId: z.uuid(), subjectKey: z.string().min(1) });
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
      });
      return reply.code(201).send(subject);
    } catch (err) {
      return sendCaptureError(reply, err);
    }
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
  // crossed with per-subject form statuses.
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
        siteName: sites.name,
      })
      .from(subjects)
      .innerJoin(sites, eq(subjects.siteId, sites.id))
      .where(eq(subjects.studyId, studyId))
      .orderBy(subjects.subjectKey);

    const subjectIds = subjectRows.map((s) => s.id);
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

  app.get("/forms/:formInstanceId", async (request, reply) => {
    const { formInstanceId } = request.params as { formInstanceId: string };
    const context = await resolveFormContext(app.db, formInstanceId);
    if (!context) return reply.code(404).send({ error: "form not found" });
    if (!(await member(request, reply, context.studyId))) return;

    const values = await app.db.execute<{
      item_group_oid: string;
      item_group_repeat_key: number;
      item_oid: string;
      version: number;
      value: string | null;
    }>(
      sql`SELECT item_group_oid, item_group_repeat_key, item_oid, version, value
          FROM item_values_current WHERE form_instance_id = ${formInstanceId}`,
    );
    return { context, values };
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
      return reply.code(201).send(version);
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
