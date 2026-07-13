-- Explicit break-the-blind events (#66; E6(R3) Annex 1 §4.1.4). One row per
-- documented unblinding of one subject: category (planned, or unplanned —
-- emergency/inadvertent/other), required reason, actor, timestamp. Recording
-- only: visibility of blinded values stays governed by data.unblind grants.
--
-- Note: drizzle-kit's generated diff for this change re-emitted every table
-- from the hand-written migrations 0012–0019 (its last snapshot was 0011);
-- this file is trimmed to only the new DDL. meta/0020_snapshot.json now
-- captures the full current schema, so future generated diffs are clean.
CREATE TABLE "subject_unblindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"category" text NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subject_unblindings" ADD CONSTRAINT "subject_unblindings_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_unblindings" ADD CONSTRAINT "subject_unblindings_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_unblindings" ADD CONSTRAINT "subject_unblindings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subject_unblinding_subject" ON "subject_unblindings" USING btree ("subject_id","created_at");--> statement-breakpoint
-- The documented unblinding is evidence, not operational state: nothing may
-- ever rewrite that the blind was broken, or why (ADR-0002 pattern).
CREATE TRIGGER subject_unblindings_append_only
  BEFORE UPDATE OR DELETE ON subject_unblindings
  FOR EACH ROW EXECUTE FUNCTION edc_reject_mutation();
