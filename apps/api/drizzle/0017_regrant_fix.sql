-- The unique index on role grants covered revoked rows, so revoking a grant
-- and granting the same (user, study, site, role) again violated the index —
-- re-granting is a legitimate, common act (staff returning to a study).
-- Scope uniqueness to ACTIVE grants: each grant/revoke cycle stays its own
-- audited row, and only one live grant per combination can exist.
DROP INDEX "user_study_role_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "user_study_role_unique" ON "user_study_roles"
  USING btree ("user_id","study_id","site_id","role_id")
  WHERE "revoked_at" IS NULL;
