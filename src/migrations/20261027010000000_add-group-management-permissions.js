export const up = pgm => {
  pgm.sql(`
INSERT INTO permissions (code, description) VALUES
    ('groups.create', 'Create groups'),
    ('groups.update', 'Update groups'),
    ('groups.members.manage', 'Manage group memberships'),
    ('groups.teachers.manage', 'Manage group teacher assignments'),
    ('groups.announcements.manage', 'Manage announcements in authorized groups');

INSERT INTO role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM roles AS role
CROSS JOIN permissions AS permission
WHERE (
    role.code IN ('owner', 'admin')
    AND permission.code IN (
        'groups.create',
        'groups.update',
        'groups.members.manage',
        'groups.teachers.manage',
        'groups.announcements.manage'
    )
) OR (
    role.code = 'teacher'
    AND permission.code = 'groups.announcements.manage'
);
  `)
}

export const down = pgm => {
  pgm.sql(`
DELETE FROM role_permissions
WHERE permission_id IN (
    SELECT id FROM permissions WHERE code IN (
        'groups.create',
        'groups.update',
        'groups.members.manage',
        'groups.teachers.manage',
        'groups.announcements.manage'
    )
);

DELETE FROM permissions WHERE code IN (
    'groups.create',
    'groups.update',
    'groups.members.manage',
    'groups.teachers.manage',
    'groups.announcements.manage'
);
  `)
}
