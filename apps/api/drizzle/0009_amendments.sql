CREATE TABLE "migration_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"target_metadata_version_id" uuid NOT NULL,
	"started_by" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"total_forms" integer DEFAULT 0 NOT NULL,
	"processed_forms" integer DEFAULT 0 NOT NULL,
	"skipped_forms" integer DEFAULT 0 NOT NULL,
	"failed_forms" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "migration_runs" ADD CONSTRAINT "migration_runs_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_runs" ADD CONSTRAINT "migration_runs_target_metadata_version_id_study_metadata_versions_id_fk" FOREIGN KEY ("target_metadata_version_id") REFERENCES "public"."study_metadata_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_runs" ADD CONSTRAINT "migration_runs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Amendment migration makes build immutability load-bearing: a signed form's
-- pinned build is only meaningful if the pinned blob cannot change. Same
-- structural enforcement as 0001_audit_triggers.sql (ADR-0002).
CREATE TRIGGER study_metadata_versions_append_only
  BEFORE UPDATE OR DELETE ON study_metadata_versions
  FOR EACH ROW EXECUTE FUNCTION edc_reject_mutation();