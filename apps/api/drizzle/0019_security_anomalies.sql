-- Security anomaly reporting (E6-06): ICH E6(R3) §4.3.3(b) asks for ongoing
-- measures to detect security breaches ("system monitoring") and §3.16.1(w)
-- for processes to report incidents. The scheduler sweep materialises
-- findings from access_log and audit_events here; dedupe_key keeps re-scans
-- idempotent. Acknowledgement (the recorded response) is audited separately
-- in audit_events.
CREATE TABLE "security_anomalies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"user_id" uuid,
	"ip" text,
	"summary" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid,
	"acknowledged_note" text
);
--> statement-breakpoint
ALTER TABLE "security_anomalies" ADD CONSTRAINT "security_anomalies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_anomalies" ADD CONSTRAINT "security_anomalies_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "security_anomaly_dedupe" ON "security_anomalies" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "security_anomaly_time" ON "security_anomalies" USING btree ("detected_at");--> statement-breakpoint
-- Anomaly notifications go to system administrators and are not tied to any
-- study, so the notification fan-out needs a null study_id.
ALTER TABLE "notifications" ALTER COLUMN "study_id" DROP NOT NULL;
