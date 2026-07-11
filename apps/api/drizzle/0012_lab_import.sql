CREATE TABLE "lab_import_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lab_import_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"mapping_id" uuid NOT NULL,
	"mapping_config" jsonb NOT NULL,
	"file_name" text,
	"started_by" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"processed_rows" integer DEFAULT 0 NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "lab_import_mappings" ADD CONSTRAINT "lab_import_mappings_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_import_mappings" ADD CONSTRAINT "lab_import_mappings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_import_mappings" ADD CONSTRAINT "lab_import_mappings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lab_import_mapping_name_unique" ON "lab_import_mappings" USING btree ("study_id","name");--> statement-breakpoint
ALTER TABLE "lab_import_runs" ADD CONSTRAINT "lab_import_runs_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_import_runs" ADD CONSTRAINT "lab_import_runs_mapping_id_lab_import_mappings_id_fk" FOREIGN KEY ("mapping_id") REFERENCES "public"."lab_import_mappings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_import_runs" ADD CONSTRAINT "lab_import_runs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lab_import_run_study" ON "lab_import_runs" USING btree ("study_id","created_at");--> statement-breakpoint
-- Lab data import is a data-management task: central-lab batch loads, not
-- site data entry. Site roles keep manual entry only; deployments adjust
-- via roles.grant. Imports into blinded items additionally require
-- data.unblind, exactly like manual writes.
-- Keep in sync with src/auth/permissions.ts.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
JOIN (VALUES
  ('admin', 'data.import'),
  ('data_manager', 'data.import')
) AS p(role_name, permission) ON p.role_name = r.name;
