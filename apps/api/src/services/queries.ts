import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  auditEvents,
  formInstances,
  queries,
  queryMessages,
  studyEventInstances,
  subjects,
  users,
} from "../db/schema/index.js";

export class QueryError extends Error {
  constructor(
    public readonly code: "not_found" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

export type QueryStatus = "open" | "answered" | "closed";

/**
 * Manual query lifecycle (E6-08, P11 audit coverage): open → answered →
 * closed, with answered → open when the monitor rejects an answer. Every
 * transition appends a threaded message (closing message optional) and an
 * audit event in the same transaction. System queries share the thread and
 * answer mechanics; their open/close is driven by edit-check evaluation.
 */
export async function openManualQuery(
  db: Db,
  input: {
    studyId: string;
    formInstanceId: string;
    itemGroupOid?: string;
    itemGroupRepeatKey?: number;
    itemOid?: string;
    body: string;
    actorId: string;
  },
) {
  return db.transaction(async (tx) => {
    const [query] = await tx
      .insert(queries)
      .values({
        studyId: input.studyId,
        formInstanceId: input.formInstanceId,
        itemGroupOid: input.itemGroupOid ?? null,
        itemGroupRepeatKey: input.itemGroupRepeatKey ?? null,
        itemOid: input.itemOid ?? null,
        origin: "manual",
        openedBy: input.actorId,
      })
      .returning();
    if (!query) throw new Error("query insert returned no row");
    await tx
      .insert(queryMessages)
      .values({ queryId: query.id, authorId: input.actorId, body: input.body });
    await tx.insert(auditEvents).values({
      actorId: input.actorId,
      studyId: input.studyId,
      action: "query.opened",
      entityType: "query",
      entityId: query.id,
      newValue: { origin: "manual", itemOid: input.itemOid ?? null, body: input.body },
    });
    return query;
  });
}

async function loadQuery(db: Db, queryId: string) {
  const [query] = await db.select().from(queries).where(eq(queries.id, queryId)).limit(1);
  if (!query) throw new QueryError("not_found", "query not found");
  return query;
}

export async function answerQuery(
  db: Db,
  input: { queryId: string; body: string; actorId: string },
) {
  const query = await loadQuery(db, input.queryId);
  if (query.status !== "open") {
    throw new QueryError("invalid", `cannot answer a ${query.status} query`);
  }
  return db.transaction(async (tx) => {
    await tx
      .insert(queryMessages)
      .values({ queryId: query.id, authorId: input.actorId, body: input.body });
    const [updated] = await tx
      .update(queries)
      .set({ status: "answered" })
      .where(eq(queries.id, query.id))
      .returning();
    await tx.insert(auditEvents).values({
      actorId: input.actorId,
      studyId: query.studyId,
      action: "query.answered",
      entityType: "query",
      entityId: query.id,
      oldValue: { status: "open" },
      newValue: { status: "answered", body: input.body },
    });
    return updated;
  });
}

export async function reopenQuery(
  db: Db,
  input: { queryId: string; body: string; actorId: string },
) {
  const query = await loadQuery(db, input.queryId);
  if (query.status !== "answered") {
    throw new QueryError("invalid", `cannot reopen a ${query.status} query`);
  }
  return db.transaction(async (tx) => {
    await tx
      .insert(queryMessages)
      .values({ queryId: query.id, authorId: input.actorId, body: input.body });
    const [updated] = await tx
      .update(queries)
      .set({ status: "open" })
      .where(eq(queries.id, query.id))
      .returning();
    await tx.insert(auditEvents).values({
      actorId: input.actorId,
      studyId: query.studyId,
      action: "query.reopened",
      entityType: "query",
      entityId: query.id,
      oldValue: { status: "answered" },
      newValue: { status: "open", body: input.body },
    });
    return updated;
  });
}

export async function closeQuery(
  db: Db,
  input: { queryId: string; body?: string; actorId: string },
) {
  const query = await loadQuery(db, input.queryId);
  if (query.status === "closed") {
    throw new QueryError("invalid", "query is already closed");
  }
  return db.transaction(async (tx) => {
    if (input.body) {
      await tx
        .insert(queryMessages)
        .values({ queryId: query.id, authorId: input.actorId, body: input.body });
    }
    const [updated] = await tx
      .update(queries)
      .set({ status: "closed", closedAt: new Date() })
      .where(eq(queries.id, query.id))
      .returning();
    await tx.insert(auditEvents).values({
      actorId: input.actorId,
      studyId: query.studyId,
      action: "query.closed",
      entityType: "query",
      entityId: query.id,
      oldValue: { status: query.status },
      newValue: { status: "closed", reason: "manual", ...(input.body ? { body: input.body } : {}) },
    });
    return updated;
  });
}

export interface QueryThread {
  id: string;
  formInstanceId: string;
  itemGroupOid: string | null;
  itemGroupRepeatKey: number | null;
  itemOid: string | null;
  origin: "manual" | "system";
  checkOid: string | null;
  status: QueryStatus;
  openedBy: string;
  createdAt: Date;
  closedAt: Date | null;
  messages: { id: string; author: string; body: string; createdAt: Date }[];
}

async function attachMessages(
  db: Db,
  rows: Omit<QueryThread, "messages">[],
): Promise<QueryThread[]> {
  if (rows.length === 0) return [];
  const messages = await db
    .select({
      id: queryMessages.id,
      queryId: queryMessages.queryId,
      author: users.username,
      body: queryMessages.body,
      createdAt: queryMessages.createdAt,
    })
    .from(queryMessages)
    .innerJoin(users, eq(queryMessages.authorId, users.id))
    .where(
      inArray(
        queryMessages.queryId,
        rows.map((q) => q.id),
      ),
    )
    .orderBy(queryMessages.createdAt);
  const byQuery = new Map<string, QueryThread["messages"]>();
  for (const m of messages) {
    const list = byQuery.get(m.queryId) ?? [];
    list.push({ id: m.id, author: m.author, body: m.body, createdAt: m.createdAt });
    byQuery.set(m.queryId, list);
  }
  return rows.map((q) => ({ ...q, messages: byQuery.get(q.id) ?? [] }));
}

const threadColumns = {
  id: queries.id,
  formInstanceId: queries.formInstanceId,
  itemGroupOid: queries.itemGroupOid,
  itemGroupRepeatKey: queries.itemGroupRepeatKey,
  itemOid: queries.itemOid,
  origin: queries.origin,
  checkOid: queries.checkOid,
  status: queries.status,
  openedBy: users.username,
  createdAt: queries.createdAt,
  closedAt: queries.closedAt,
};

export async function listFormQueries(db: Db, formInstanceId: string): Promise<QueryThread[]> {
  const rows = await db
    .select(threadColumns)
    .from(queries)
    .innerJoin(users, eq(queries.openedBy, users.id))
    .where(eq(queries.formInstanceId, formInstanceId))
    .orderBy(desc(queries.createdAt));
  return attachMessages(db, rows);
}

export interface StudyQueryRow extends QueryThread {
  subjectKey: string;
  eventOid: string;
  formOid: string;
}

export async function listStudyQueries(
  db: Db,
  studyId: string,
  filter?: { status?: QueryStatus },
): Promise<StudyQueryRow[]> {
  const conditions = [eq(queries.studyId, studyId)];
  if (filter?.status) conditions.push(eq(queries.status, filter.status));
  const rows = await db
    .select({
      ...threadColumns,
      subjectKey: subjects.subjectKey,
      eventOid: studyEventInstances.eventOid,
      formOid: formInstances.formOid,
    })
    .from(queries)
    .innerJoin(users, eq(queries.openedBy, users.id))
    .innerJoin(formInstances, eq(queries.formInstanceId, formInstances.id))
    .innerJoin(studyEventInstances, eq(formInstances.studyEventInstanceId, studyEventInstances.id))
    .innerJoin(subjects, eq(studyEventInstances.subjectId, subjects.id))
    .where(and(...conditions))
    .orderBy(desc(queries.createdAt));
  const withMessages = await attachMessages(db, rows);
  const extras = new Map(
    rows.map((r) => [r.id, { subjectKey: r.subjectKey, eventOid: r.eventOid, formOid: r.formOid }]),
  );
  return withMessages.map((q) => {
    const extra = extras.get(q.id);
    if (!extra) throw new Error("study query lost its context during message join");
    return { ...q, ...extra };
  });
}
