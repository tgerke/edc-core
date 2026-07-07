-- Workbench execution permission (self-service analytics against snapshots).
-- Keep in sync with src/auth/permissions.ts.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
JOIN (VALUES
  ('admin', 'analytics.run'),
  ('data_manager', 'analytics.run'),
  ('monitor', 'analytics.run')
) AS p(role_name, permission) ON p.role_name = r.name;
