-- Structured access logging (P11-14): §11.10(h) device checks need reviewable
-- evidence of who accessed the system, from where, and when. One row per API
-- request, written on response. Operational telemetry rather than the
-- trigger-protected audit trail — auth events (login, lockout, session
-- binding violations) remain in audit_events.
CREATE TABLE "access_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"session_id" uuid,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"route" text,
	"status_code" integer NOT NULL,
	"ip" text,
	"user_agent" text,
	"duration_ms" integer
);
--> statement-breakpoint
ALTER TABLE "access_log" ADD CONSTRAINT "access_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_log_time" ON "access_log" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "access_log_user_time" ON "access_log" USING btree ("user_id","occurred_at");
