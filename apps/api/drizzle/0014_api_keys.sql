-- Machine auth for external integrations (RTSM assignment intake): study-
-- scoped API keys bound to a service-account user. Operational state like
-- sessions (revocation, last-used are mutable); key lifecycle events go to
-- audit_events. The raw token is never stored — sha256 hash only.
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_key_study" ON "api_keys" USING btree ("study_id");--> statement-breakpoint
-- The role a study's RTSM service account is granted. integration.rtsm gates
-- the intake routes; data.unblind lets the intake write a blinded arm item
-- (ADR-0009 semantics, same as lab imports). The key can only reach intake
-- routes, so the unblind grant is write-only in practice — an API key never
-- reads data. Never seed this role to human roles.
-- Keep in sync with src/auth/permissions.ts.
INSERT INTO roles (name, description) VALUES
  ('rtsm_agent', 'RTSM integration service account: posts randomization assignments, may write a blinded arm item');
--> statement-breakpoint
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
JOIN (VALUES
  ('rtsm_agent', 'integration.rtsm'),
  ('rtsm_agent', 'data.unblind')
) AS p(role_name, permission) ON p.role_name = r.name;
