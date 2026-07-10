import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { roles, users } from "./users.js";

// Operational state, not clinical data: sessions are mutable (sliding
// last-seen, revocation). Login/logout/lockout events go to audit_events.
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    // sha256 of the bearer token; the token itself is never stored.
    tokenHash: text("token_hash").notNull().unique(),
    authMethod: text("auth_method", { enum: ["password", "oidc"] })
      .notNull()
      .default("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (t) => [index("session_user_lookup").on(t.userId)],
);

// Single-use grants minted by a fresh interactive IdP login (prompt=login),
// consumed by the e-signature endpoint as the OIDC equivalent of password
// re-entry (P11 §11.200(a)). Short-lived; the raw token is never stored.
export const reauthGrants = pgTable(
  "reauth_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull().unique(),
    purpose: text("purpose").notNull().default("signature"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => [index("reauth_grant_user_lookup").on(t.userId)],
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id),
    permission: text("permission").notNull(),
  },
  (t) => [index("role_permission_lookup").on(t.roleId, t.permission)],
);
