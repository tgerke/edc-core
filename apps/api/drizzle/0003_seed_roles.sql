-- Default roles and their permissions (E6-05, P11-04). Deployments may add
-- roles; these six cover the standard EDC division of responsibilities.
-- Permission strings are defined in src/auth/permissions.ts — keep in sync.

INSERT INTO roles (name, description) VALUES
  ('admin', 'Study administrator: full control within a study'),
  ('data_manager', 'Builds studies, manages queries, reviews audit trails, locks and exports data'),
  ('investigator', 'Enters and signs clinical data for their site'),
  ('data_entry', 'Site coordinator: enters data and answers queries'),
  ('monitor', 'CRA: verifies source data, manages queries, reviews audit trails'),
  ('read_only', 'Read access through study membership; no capabilities');
--> statement-breakpoint

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
JOIN (VALUES
  ('admin', 'study.manage'),
  ('admin', 'subject.enroll'),
  ('admin', 'data.enter'),
  ('admin', 'data.verify'),
  ('admin', 'data.sign'),
  ('admin', 'data.lock'),
  ('admin', 'query.manage'),
  ('admin', 'query.answer'),
  ('admin', 'audit.review'),
  ('admin', 'export.data'),
  ('admin', 'roles.grant'),
  ('data_manager', 'study.manage'),
  ('data_manager', 'query.manage'),
  ('data_manager', 'audit.review'),
  ('data_manager', 'data.lock'),
  ('data_manager', 'export.data'),
  ('investigator', 'subject.enroll'),
  ('investigator', 'data.enter'),
  ('investigator', 'data.sign'),
  ('investigator', 'query.answer'),
  ('data_entry', 'subject.enroll'),
  ('data_entry', 'data.enter'),
  ('data_entry', 'query.answer'),
  ('monitor', 'data.verify'),
  ('monitor', 'query.manage'),
  ('monitor', 'audit.review')
) AS p(role_name, permission) ON p.role_name = r.name;
