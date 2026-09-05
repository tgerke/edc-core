-- ADR-0017: the PMO read surface. API keys gain a scope so read keys and the
-- RTSM intake key are distinct classes that guards can pin — a leaked read
-- key cannot post assignments, and the RTSM key still can never read data.
ALTER TABLE "api_keys" ADD COLUMN "scope" text DEFAULT 'rtsm' NOT NULL;
--> statement-breakpoint
-- The role a study's PMO service account is granted. integration.read gates
-- the read-only listings (subjects, queries, members, visits, form
-- instances) and nothing else: no data.enter, no data.unblind — the surface
-- serves operational metadata plus the one build-designated visit date item,
-- which publish validation refuses to let be blinded. Never seed this role
-- to human roles. Keep in sync with src/auth/permissions.ts.
INSERT INTO roles (name, description) VALUES
  ('pmo_agent', 'PMO integration service account: reads operational listings for metrics pipelines');
--> statement-breakpoint
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'integration.read'
FROM roles r
WHERE r.name = 'pmo_agent';
