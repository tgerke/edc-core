CREATE TABLE "workbench_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"script_id" uuid,
	"script_version" integer,
	"language" text NOT NULL,
	"content" text NOT NULL,
	"status" text NOT NULL,
	"stdout" text,
	"error" text,
	"result" jsonb,
	"elapsed_ms" integer,
	"executed_by" uuid NOT NULL,
	"executed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workbench_script_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"script_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workbench_scripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"study_id" uuid NOT NULL,
	"name" text NOT NULL,
	"language" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workbench_executions" ADD CONSTRAINT "workbench_executions_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workbench_executions" ADD CONSTRAINT "workbench_executions_snapshot_id_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workbench_executions" ADD CONSTRAINT "workbench_executions_script_id_workbench_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."workbench_scripts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workbench_executions" ADD CONSTRAINT "workbench_executions_executed_by_users_id_fk" FOREIGN KEY ("executed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workbench_script_versions" ADD CONSTRAINT "workbench_script_versions_script_id_workbench_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."workbench_scripts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workbench_script_versions" ADD CONSTRAINT "workbench_script_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workbench_scripts" ADD CONSTRAINT "workbench_scripts_study_id_studies_id_fk" FOREIGN KEY ("study_id") REFERENCES "public"."studies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workbench_scripts" ADD CONSTRAINT "workbench_scripts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workbench_execution_study_idx" ON "workbench_executions" USING btree ("study_id","executed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workbench_script_version_unique" ON "workbench_script_versions" USING btree ("script_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "workbench_script_name_unique" ON "workbench_scripts" USING btree ("study_id","name");