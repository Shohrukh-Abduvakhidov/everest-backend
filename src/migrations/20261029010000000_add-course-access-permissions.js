export const up = pgm => {
  pgm.sql(`
INSERT INTO permissions (code, description) VALUES
    ('courses.access.read', 'Read course enrollments and module access grants'),
    ('courses.access.manage', 'Grant, extend, revoke and re-grant course enrollments and module access grants');

INSERT INTO role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM roles AS role
CROSS JOIN permissions AS permission
WHERE role.code IN ('owner', 'admin')
    AND permission.code IN ('courses.access.read', 'courses.access.manage');
  `)
}

export const down = pgm => {
  pgm.sql(`
DELETE FROM role_permissions
WHERE permission_id IN (
    SELECT id FROM permissions WHERE code IN ('courses.access.read', 'courses.access.manage')
);

DELETE FROM permissions WHERE code IN ('courses.access.read', 'courses.access.manage');
  `)
}
