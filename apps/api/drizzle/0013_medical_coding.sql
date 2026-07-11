-- Medical coding: global dictionary store (MedDRA / WHODrug), per-study
-- bindings, append-only coding assignments, auto-coding runs.
--
-- pg_trgm backs the workbench's substring term search. It is a stock
-- contrib module shipped with every Postgres distribution (including the
-- postgres:16 image in infra/) and a trusted extension since PG13, so the
-- database owner may create it without superuser.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE "dictionaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"version" text NOT NULL,
	"terms_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dictionary_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dictionary_id" uuid NOT NULL,
	"code" text NOT NULL,
	"term" text NOT NULL,
	"normalized_term" text NOT NULL,
	"pt_code" text,
	"pt_term" text,
	"hlt_code" text,
	"hlt_term" text,
	"hlgt_code" text,
	"hlgt_term" text,
	"soc_code" text,
	"soc_term" text,
	"atc_code" text,
	"atc_text" text
);
--> statement-breakpoint
CREATE TABLE "study_dictionaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"dictionary_type" text NOT NULL,
	"dictionary_id" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coding_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"started_by" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"total_occurrences" integer DEFAULT 0 NOT NULL,
	"processed_occurrences" integer DEFAULT 0 NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "codings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"form_instance_id" uuid NOT NULL,
	"item_group_oid" text NOT NULL,
	"item_group_repeat_key" integer DEFAULT 1 NOT NULL,
	"item_oid" text NOT NULL,
	"version" integer NOT NULL,
	"verbatim" text NOT NULL,
	"dictionary_id" uuid,
	"dictionary_version" text,
	"code" text,
	"term" text,
	"pt_code" text,
	"pt_term" text,
	"hlt_code" text,
	"hlt_term" text,
	"hlgt_code" text,
	"hlgt_term" text,
	"soc_code" text,
	"soc_term" text,
	"atc_code" text,
	"atc_text" text,
	"origin" text NOT NULL,
	"coding_run_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dictionaries" ADD CONSTRAINT "dictionaries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dictionary_terms" ADD CONSTRAINT "dictionary_terms_dictionary_id_dictionaries_id_fk" FOREIGN KEY ("dictionary_id") REFERENCES "public"."dictionaries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_dictionaries" ADD CONSTRAINT "study_dictionaries_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_dictionaries" ADD CONSTRAINT "study_dictionaries_dictionary_id_dictionaries_id_fk" FOREIGN KEY ("dictionary_id") REFERENCES "public"."dictionaries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "study_dictionaries" ADD CONSTRAINT "study_dictionaries_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_runs" ADD CONSTRAINT "coding_runs_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_runs" ADD CONSTRAINT "coding_runs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codings" ADD CONSTRAINT "codings_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codings" ADD CONSTRAINT "codings_form_instance_id_form_instances_id_fk" FOREIGN KEY ("form_instance_id") REFERENCES "public"."form_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codings" ADD CONSTRAINT "codings_dictionary_id_dictionaries_id_fk" FOREIGN KEY ("dictionary_id") REFERENCES "public"."dictionaries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codings" ADD CONSTRAINT "codings_coding_run_id_coding_runs_id_fk" FOREIGN KEY ("coding_run_id") REFERENCES "public"."coding_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "codings" ADD CONSTRAINT "codings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dictionary_type_version_unique" ON "dictionaries" USING btree ("type","version");--> statement-breakpoint
CREATE UNIQUE INDEX "dictionary_term_code_unique" ON "dictionary_terms" USING btree ("dictionary_id","code");--> statement-breakpoint
CREATE INDEX "dictionary_term_exact" ON "dictionary_terms" USING btree ("dictionary_id","normalized_term");--> statement-breakpoint
CREATE INDEX "dictionary_term_search" ON "dictionary_terms" USING gin ("normalized_term" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "study_dictionary_type_unique" ON "study_dictionaries" USING btree ("study_id","dictionary_type");--> statement-breakpoint
CREATE INDEX "coding_run_study" ON "coding_runs" USING btree ("study_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "coding_version_unique" ON "codings" USING btree ("form_instance_id","item_group_oid","item_group_repeat_key","item_oid","version");--> statement-breakpoint
CREATE INDEX "coding_study" ON "codings" USING btree ("study_id","created_at");--> statement-breakpoint
-- Codings are part of the clinical record: corrections append the next
-- version, exactly like item_value_versions (ADR-0002).
CREATE TRIGGER codings_append_only
  BEFORE UPDATE OR DELETE ON codings
  FOR EACH ROW EXECUTE FUNCTION edc_reject_mutation();
--> statement-breakpoint
-- Current coding: latest version per verbatim item occurrence.
CREATE VIEW codings_current AS
SELECT DISTINCT ON (form_instance_id, item_group_oid, item_group_repeat_key, item_oid)
  id, study_id, form_instance_id, item_group_oid, item_group_repeat_key, item_oid,
  version, verbatim, dictionary_id, dictionary_version, code, term,
  pt_code, pt_term, hlt_code, hlt_term, hlgt_code, hlgt_term, soc_code, soc_term,
  atc_code, atc_text, origin, coding_run_id, created_by, created_at
FROM codings
ORDER BY form_instance_id, item_group_oid, item_group_repeat_key, item_oid, version DESC;
--> statement-breakpoint
-- Coding is a data-management task; site roles never code. Deployments with
-- dedicated coders grant data.code via roles.grant. Dictionary management is
-- system-admin only and not permission-gated here.
-- Keep in sync with src/auth/permissions.ts.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
JOIN (VALUES
  ('admin', 'data.code'),
  ('data_manager', 'data.code')
) AS p(role_name, permission) ON p.role_name = r.name;
