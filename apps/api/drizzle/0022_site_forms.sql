CREATE TABLE "site_form_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_form_variant_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"variant_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"metadata_version_id" uuid NOT NULL,
	"definition" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp with time zone,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "form_instances" ADD COLUMN "site_form_variant_version_id" uuid;--> statement-breakpoint
ALTER TABLE "site_form_variants" ADD CONSTRAINT "site_form_variants_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_form_variants" ADD CONSTRAINT "site_form_variants_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_form_variants" ADD CONSTRAINT "site_form_variants_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_form_variant_versions" ADD CONSTRAINT "site_form_variant_versions_variant_id_site_form_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."site_form_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_form_variant_versions" ADD CONSTRAINT "site_form_variant_versions_metadata_version_id_study_metadata_versions_id_fk" FOREIGN KEY ("metadata_version_id") REFERENCES "public"."study_metadata_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_form_variant_versions" ADD CONSTRAINT "site_form_variant_versions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_form_variant_versions" ADD CONSTRAINT "site_form_variant_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_instances" ADD CONSTRAINT "form_instances_site_form_variant_version_id_site_form_variant_versions_id_fk" FOREIGN KEY ("site_form_variant_version_id") REFERENCES "public"."site_form_variant_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "site_form_variant_name_unique" ON "site_form_variants" USING btree ("study_id","site_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "site_form_variant_version_unique" ON "site_form_variant_versions" USING btree ("variant_id","version");--> statement-breakpoint
CREATE INDEX "site_form_variant_versions_status_idx" ON "site_form_variant_versions" USING btree ("status");--> statement-breakpoint
-- Variant versions are append-only for audit (each edit is a new version row;
-- status transitions are the one permitted mutation and are audit-logged).
-- Site staff author their own site's workflow: seeded to the CRC-type role,
-- site-scoped by the grant. Sponsor approval uses study.manage. Keep in sync
-- with src/auth/permissions.ts.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
JOIN (VALUES
  ('admin', 'site.forms.manage'),
  ('data_entry', 'site.forms.manage')
) AS p(role_name, permission) ON p.role_name = r.name;
