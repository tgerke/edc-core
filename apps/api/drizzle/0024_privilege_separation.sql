-- Privilege separation (ADR-0002; traceability P11-01).
--
-- The append-only triggers in 0001 reject UPDATE/DELETE through any SQL
-- path, but a role that owns the tables can ALTER TABLE ... DISABLE TRIGGER
-- or TRUNCATE around them. The runtime role (edc_app) therefore never owns
-- clinical tables: migrations run as the owning role, the API connects as
-- edc_app, and edc_app holds no TRIGGER, TRUNCATE, or REFERENCES privilege
-- anywhere, so it cannot disable, drop, or bypass a trigger.
--
-- edc_app is created NOLOGIN if missing so this migration succeeds on any
-- database. Deployments make it connectable themselves (ALTER ROLE edc_app
-- LOGIN PASSWORD '...'); infra/initdb does this for the local compose stack.
-- CREATE on the database is needed because the API creates one DuckLake
-- catalog schema per study.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'edc_app') THEN
    CREATE ROLE edc_app NOLOGIN;
  END IF;
  EXECUTE format('GRANT CREATE ON DATABASE %I TO edc_app', current_database());
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO edc_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO edc_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO edc_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO edc_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO edc_app;
--> statement-breakpoint
-- Append-only tables: the trigger is the enforcement; withholding UPDATE and
-- DELETE outright is defense in depth. A migration adding a new append-only
-- table must revoke these the same way (default privileges grant them).
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events, item_value_versions, study_metadata_versions, codings, rtsm_events, subject_unblindings, protocol_versions FROM edc_app;
--> statement-breakpoint
-- Signatures keep UPDATE for the one-way invalidation transition; the
-- signatures_guard trigger constrains it to exactly that.
REVOKE DELETE, TRUNCATE ON signatures FROM edc_app;
