export const up = pgm => {
  pgm.sql(`
ALTER TABLE course_teachers
    ADD COLUMN can_edit_course BOOLEAN NOT NULL DEFAULT FALSE;

INSERT INTO permissions (code, description) VALUES
    ('courses.read', 'Read authorized course administration records'),
    ('courses.create', 'Create courses'),
    ('courses.update', 'Update courses'),
    ('courses.publish', 'Publish and unpublish courses'),
    ('courses.teachers.manage', 'Manage course teacher assignments');

INSERT INTO role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM roles AS role
CROSS JOIN permissions AS permission
WHERE (
    role.code IN ('owner', 'admin')
    AND permission.code IN (
        'courses.read',
        'courses.create',
        'courses.update',
        'courses.publish',
        'courses.teachers.manage'
    )
) OR (
    role.code = 'teacher'
    AND permission.code IN ('courses.read', 'courses.update')
);
  `)
}

export const down = pgm => {
  pgm.sql(`
DELETE FROM role_permissions
WHERE permission_id IN (
    SELECT id FROM permissions WHERE code IN (
        'courses.read',
        'courses.create',
        'courses.update',
        'courses.publish',
        'courses.teachers.manage'
    )
);

DELETE FROM permissions WHERE code IN (
    'courses.read',
    'courses.create',
    'courses.update',
    'courses.publish',
    'courses.teachers.manage'
);

ALTER TABLE course_teachers DROP COLUMN can_edit_course;
  `)
}
