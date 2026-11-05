export const up = pgm => {
  pgm.sql(`
INSERT INTO permissions (code, description)
VALUES ('tests.results.regrade', 'Override the points of finished test attempts');

INSERT INTO role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM roles AS role
CROSS JOIN permissions AS permission
WHERE role.code IN ('owner', 'admin') AND permission.code = 'tests.results.regrade';
  `)
}

export const down = pgm => {
  pgm.sql(`
DELETE FROM role_permissions
WHERE permission_id IN (SELECT id FROM permissions WHERE code = 'tests.results.regrade');

DELETE FROM permissions WHERE code = 'tests.results.regrade';
  `)
}
