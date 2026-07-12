import { sql } from "drizzle-orm";
import { boolean, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sites, studies } from "./studies.js";

// Accounts are never deleted or recycled (21 CFR 11.100(a): signatures must
// remain attributable to one individual indefinitely) — deactivation only.
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: text("username").notNull().unique(),
  email: text("email").notNull().unique(),
  fullName: text("full_name").notNull(),
  // Null for OIDC-provisioned accounts that never set a local password.
  passwordHash: text("password_hash"),
  // Subject claim from the configured identity provider. Unique per user under
  // the single-issuer assumption (one IdP per deployment).
  oidcSubject: text("oidc_subject").unique(),
  status: text("status", { enum: ["active", "locked", "deactivated"] })
    .notNull()
    .default("active"),
  // Set when an administrator issues the credential (creation, reset): the
  // holder can reach nothing but the change-password flow until cleared.
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  // System-level administration (create studies, manage users) sits outside
  // study-scoped RBAC; per-study capabilities always come from role grants.
  isSystemAdmin: boolean("is_system_admin").notNull().default(false),
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
  // Unique among ACTIVE grants only: revoke → re-grant of the same
  // combination is legitimate, and each cycle stays its own audited row.
  (t) => [
    uniqueIndex("user_study_role_unique")
      .on(t.userId, t.studyId, t.siteId, t.roleId)
      .where(sql`revoked_at IS NULL`),
  ],
);
