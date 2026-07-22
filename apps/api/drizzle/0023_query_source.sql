ALTER TABLE "queries" ADD COLUMN "source_execution_id" uuid;
ALTER TABLE "queries" ADD CONSTRAINT "queries_source_execution_id_workbench_executions_id_fk" FOREIGN KEY ("source_execution_id") REFERENCES "public"."workbench_executions"("id") ON DELETE no action ON UPDATE no action;
