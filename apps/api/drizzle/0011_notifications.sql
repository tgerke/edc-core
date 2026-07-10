CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"study_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text,
	"read_at" timestamp with time zone,
	"emailed_at" timestamp with time zone,
	"email_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_unread_lookup" ON "notifications" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_dedupe" ON "notifications" USING btree ("user_id","type","dedupe_key") WHERE dedupe_key IS NOT NULL;