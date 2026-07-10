import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { studies } from "./studies.js";
import { users } from "./users.js";

/**
 * In-app notifications with an email outbox (emailed_at / email_attempts).
 * Rows are inserted in the same transaction as the event they announce.
 * `dedupe_key` makes recurring scans idempotent: the partial unique index
 * turns re-notification into ON CONFLICT DO NOTHING.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id),
    type: text("type", {
      enum: ["query.opened", "query.answered", "form.awaiting_signature", "form.overdue"],
    }).notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    /** Deep-link context for the UI (formInstanceId, queryId, subjectKey…). */
    payload: jsonb("payload").notNull().default({}),
    dedupeKey: text("dedupe_key"),
    readAt: timestamp("read_at", { withTimezone: true }),
    emailedAt: timestamp("emailed_at", { withTimezone: true }),
    emailAttempts: integer("email_attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("notification_unread_lookup").on(t.userId, t.readAt),
    uniqueIndex("notification_dedupe")
      .on(t.userId, t.type, t.dedupeKey)
      .where(sql`dedupe_key IS NOT NULL`),
  ],
);
