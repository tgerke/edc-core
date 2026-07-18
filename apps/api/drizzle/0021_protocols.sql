CREATE TABLE "protocol_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"usdm_version" text NOT NULL,
	"package" jsonb NOT NULL,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "protocol_compilations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"protocol_version_id" uuid NOT NULL,
	"candidate" jsonb NOT NULL,
	"unresolved_count" integer DEFAULT 0 NOT NULL,
	"traceability" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'in_review' NOT NULL,
	"published_metadata_version_id" uuid,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "protocol_traceability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"metadata_version_id" uuid NOT NULL,
	"protocol_version_id" uuid NOT NULL,
	"odm_oid" text NOT NULL,
	"odm_type" text NOT NULL,
	"usdm_id" text NOT NULL,
	"usdm_instance_type" text NOT NULL,
	"relation" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "protocol_versions" ADD CONSTRAINT "protocol_versions_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protocol_versions" ADD CONSTRAINT "protocol_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protocol_compilations" ADD CONSTRAINT "protocol_compilations_protocol_version_id_protocol_versions_id_fk" FOREIGN KEY ("protocol_version_id") REFERENCES "public"."protocol_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protocol_compilations" ADD CONSTRAINT "protocol_compilations_published_metadata_version_id_study_metadata_versions_id_fk" FOREIGN KEY ("published_metadata_version_id") REFERENCES "public"."study_metadata_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protocol_traceability" ADD CONSTRAINT "protocol_traceability_metadata_version_id_study_metadata_versions_id_fk" FOREIGN KEY ("metadata_version_id") REFERENCES "public"."study_metadata_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protocol_traceability" ADD CONSTRAINT "protocol_traceability_protocol_version_id_protocol_versions_id_fk" FOREIGN KEY ("protocol_version_id") REFERENCES "public"."protocol_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "protocol_version_unique" ON "protocol_versions" USING btree ("study_id","version");--> statement-breakpoint
CREATE INDEX "protocol_traceability_mdv_idx" ON "protocol_traceability" USING btree ("metadata_version_id");--> statement-breakpoint
-- The protocol document is a regulated artifact: like study builds, versions
-- are immutable once imported (ADR-0002 pattern; edc_reject_mutation from
-- 0001_audit_triggers.sql). Compilations are review scratch state and stay
-- mutable; every edit writes an audit event instead.
CREATE TRIGGER protocol_versions_append_only
  BEFORE UPDATE OR DELETE ON protocol_versions
  FOR EACH ROW EXECUTE FUNCTION edc_reject_mutation();
