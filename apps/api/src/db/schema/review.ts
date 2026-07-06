import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { formInstances } from "./capture.js";
import { studies } from "./studies.js";
import { users } from "./users.js";

export const queries = pgTable("queries", {
  id: uuid("id").primaryKey().defaultRandom(),
  studyId: uuid("study_id")
    .notNull()
    .references(() => studies.id),
  formInstanceId: uuid("form_instance_id")
    .notNull()
    .references(() => formInstances.id),
  itemGroupOid: text("item_group_oid"),
  itemGroupRepeatKey: integer("item_group_repeat_key"),
  itemOid: text("item_oid"),
  origin: text("origin", { enum: ["manual", "system"] }).notNull(),
  // For system queries: the edit-check ConditionDef that raised this query.
  checkOid: text("check_oid"),
  status: text("status", { enum: ["open", "answered", "closed"] })
    .notNull()
    .default("open"),
  openedBy: uuid("opened_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

export const queryMessages = pgTable("query_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  queryId: uuid("query_id")
    .notNull()
    .references(() => queries.id),
  authorId: uuid("author_id")
    .notNull()
    .references(() => users.id),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// E-signature records (P11-08..11). recordHash binds the signature to the
// exact signed content (form state + current item values at signing time);
// later edits set invalidatedAt rather than touching the signature row —
// the table is append-only-with-invalidation, enforced by trigger.
export const signatures = pgTable("signatures", {
  id: uuid("id").primaryKey().defaultRandom(),
  formInstanceId: uuid("form_instance_id")
    .notNull()
    .references(() => formInstances.id),
  signerId: uuid("signer_id")
    .notNull()
    .references(() => users.id),
  meaning: text("meaning").notNull(),
  recordHash: text("record_hash").notNull(),
  signedAt: timestamp("signed_at", { withTimezone: true }).notNull().defaultNow(),
  invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
  invalidatedReason: text("invalidated_reason"),
});
