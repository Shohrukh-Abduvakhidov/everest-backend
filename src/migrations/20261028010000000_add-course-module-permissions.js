export const up = pgm => {
  pgm.sql(`
INSERT INTO permissions (code, description) VALUES
    ('courses.modules.manage', 'Create, edit, order, publish, archive and delete course modules'),
    ('courses.copy', 'Copy course structure into a new draft course');

INSERT INTO role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM roles AS role
CROSS JOIN permissions AS permission
WHERE (
    role.code IN ('owner', 'admin')
    AND permission.code IN ('courses.modules.manage', 'courses.copy')
) OR (
    role.code = 'teacher'
    AND permission.code = 'courses.modules.manage'
);
  `)
}

export const down = pgm => {
  pgm.sql(`
DELETE FROM role_permissions
WHERE permission_id IN (
    SELECT id FROM permissions WHERE code IN ('courses.modules.manage', 'courses.copy')
);

DELETE FROM permissions WHERE code IN ('courses.modules.manage', 'courses.copy');
  `)
}
