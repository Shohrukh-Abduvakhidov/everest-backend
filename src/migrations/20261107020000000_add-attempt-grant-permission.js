// Granted to the roles that hold tests.results.regrade (owner and admin).
export const up = pgm => {
  pgm.sql(`
INSERT INTO permissions (code, description)
VALUES ('tests.attempts.grant', 'Grant a student extra attempts on a test assignment');

INSERT INTO role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM roles AS role
CROSS JOIN permissions AS permission
WHERE role.code IN ('owner', 'admin') AND permission.code = 'tests.attempts.grant';
  `)
}

export const down = pgm => {
  pgm.sql(`
DELETE FROM role_permissions
WHERE permission_id IN (SELECT id FROM permissions WHERE code = 'tests.attempts.grant');

DELETE FROM permissions WHERE code = 'tests.attempts.grant';
  `)
}
