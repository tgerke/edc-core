import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { studies } from "./studies.js";
import { users } from "./users.js";

// Machine credentials for external integrations (RTSM intake). Operational
// state like sessions — revocation and last-used are mutable; key lifecycle
// events go to audit_events. The raw token is never stored.
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studyId: uuid("study_id")
      .notNull()
      .references(() => studies.id),
    // The service-account user the key acts as: audit rows and item-value
    // versions need a real, permission-bearing actor.
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    label: text("label").notNull(),
    // sha256 of the bearer token; the token itself is never stored.
    tokenHash: text("token_hash").notNull().unique(),
    // Leading characters of the raw token, so the UI can identify a key
    // without ever holding the secret again.
    tokenPrefix: text("token_prefix").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("api_key_study").on(t.studyId)],
);
