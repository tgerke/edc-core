-- RTSM assignment intake (ADR-0010). rtsm_configs is deployment wiring: one
-- row per study saying which eCRF item an incoming randomization arm lands
-- on. Mutable, like lab_import_mappings — every change is audited with the
-- full old/new config. rtsm_events is the append-only wire record of every
-- assignment POST, including rejects, so external transfers stay traceable
-- and reconcilable (E6 §4.2.5); the arm value itself lives where all
-- clinical data lives (item_value_versions), not here.
CREATE TABLE "rtsm_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"event_oid" text NOT NULL,
	"form_oid" text NOT NULL,
	"item_group_oid" text NOT NULL,
	"item_oid" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rtsm_configs_study_id_unique" UNIQUE("study_id")
);
--> statement-breakpoint
CREATE TABLE "rtsm_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"api_key_id" uuid NOT NULL,
	"subject_id" uuid,
	"subject_key" text NOT NULL,
	"randomization_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"item_value_version_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rtsm_configs" ADD CONSTRAINT "rtsm_configs_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rtsm_configs" ADD CONSTRAINT "rtsm_configs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rtsm_configs" ADD CONSTRAINT "rtsm_configs_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rtsm_events" ADD CONSTRAINT "rtsm_events_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rtsm_events" ADD CONSTRAINT "rtsm_events_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rtsm_events" ADD CONSTRAINT "rtsm_events_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rtsm_events" ADD CONSTRAINT "rtsm_events_item_value_version_id_item_value_versions_id_fk" FOREIGN KEY ("item_value_version_id") REFERENCES "public"."item_value_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rtsm_events" ADD CONSTRAINT "rtsm_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rtsm_event_study" ON "rtsm_events" USING btree ("study_id","created_at");--> statement-breakpoint
CREATE INDEX "rtsm_event_randomization" ON "rtsm_events" USING btree ("study_id","randomization_id");--> statement-breakpoint
-- The transfer record is evidence, not operational state: nothing may ever
-- rewrite what the RTSM sent or what the system decided (ADR-0002).
CREATE TRIGGER rtsm_events_append_only
  BEFORE UPDATE OR DELETE ON rtsm_events
  FOR EACH ROW EXECUTE FUNCTION edc_reject_mutation();
