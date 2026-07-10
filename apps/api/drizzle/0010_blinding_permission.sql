-- Blinding: see the value of items flagged edc:Blinded in the study build.
-- Site staff who handle the values hold it (investigator, data_entry, admin);
-- monitor is the canonical blinded role, and data_manager/read_only review
-- blinded by default. Org SOPs vary — deployments adjust via roles.grant.
-- Keep in sync with src/auth/permissions.ts.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
JOIN (VALUES
  ('admin', 'data.unblind'),
  ('investigator', 'data.unblind'),
  ('data_entry', 'data.unblind')
) AS p(role_name, permission) ON p.role_name = r.name;
