import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sites, studies } from "./studies.js";

// Accounts are never deleted or recycled (21 CFR 11.100(a): signatures must
// remain attributable to one individual indefinitely) — deactivation only.
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: text("username").notNull().unique(),
  email: text("email").notNull().unique(),
  fullName: text("full_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  status: text("status", { enum: ["active", "locked", "deactivated"] })
    .notNull()
    .default("active"),
  failedLoginCount: integer("failed_login_count").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  passwordChangedAt: timestamp("password_changed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const roles = pgTable("roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  description: text("description").notNull(),
});

// Role grants are scoped to a study, optionally narrowed to one site
// (siteId null = all sites in the study). Traceability: P11-04, E6-05.
export const userStudyRoles = pgTable(
  "user_study_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id),
    siteId: uuid("site_id").references(() => sites.id),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id),
    grantedBy: uuid("granted_by")
      .notNull()
      .references(() => users.id),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("user_study_role_unique").on(t.userId, t.studyId, t.siteId, t.roleId)],
);
