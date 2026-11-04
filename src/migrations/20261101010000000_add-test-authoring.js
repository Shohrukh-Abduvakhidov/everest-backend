export const up = pgm => {
  pgm.sql(`
ALTER TABLE tests ADD COLUMN course_id BIGINT NOT NULL REFERENCES courses(id) ON DELETE RESTRICT;
CREATE INDEX tests_course_id_idx ON tests (course_id);

INSERT INTO permissions (code, description) VALUES
    ('tests.read', 'Read tests and their assignments'),
    ('tests.manage', 'Create, edit, copy, archive and delete tests'),
    ('tests.publish', 'Publish tests'),
    ('tests.assign', 'Assign published tests to groups and students'),
    ('tests.results.read', 'Read test results');

INSERT INTO role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM roles AS role
CROSS JOIN permissions AS permission
WHERE (
    role.code IN ('owner', 'admin')
    AND permission.code IN (
        'tests.read', 'tests.manage', 'tests.publish', 'tests.assign', 'tests.results.read'
    )
) OR (
    role.code = 'teacher'
    AND permission.code IN ('tests.read', 'tests.manage', 'tests.assign', 'tests.results.read')
);
  `)
}

export const down = pgm => {
  pgm.sql(`
DELETE FROM role_permissions
WHERE permission_id IN (
    SELECT id FROM permissions
    WHERE code IN (
        'tests.read', 'tests.manage', 'tests.publish', 'tests.assign', 'tests.results.read'
    )
);

DELETE FROM permissions
WHERE code IN (
    'tests.read', 'tests.manage', 'tests.publish', 'tests.assign', 'tests.results.read'
);

DROP INDEX tests_course_id_idx;
ALTER TABLE tests DROP COLUMN course_id;
  `)
}
