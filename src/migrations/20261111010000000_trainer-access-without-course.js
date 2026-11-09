// The NCT trainer is its own module: it no longer depends on courses. Generated trainer tests
// may have no course (authored tests still must have one), and the trainer is a role
// permission, granted to students, checked together with an active account.
// Trainer tests created before this migration keep their course; nothing is rewritten.
export const up = pgm => {
   pgm.sql(`
ALTER TABLE tests ALTER COLUMN course_id DROP NOT NULL;
ALTER TABLE tests ADD CONSTRAINT tests_course_required_check
    CHECK (course_id IS NOT NULL OR origin = 'trainer');

INSERT INTO permissions (code, description)
VALUES ('trainer.use', 'Use the NCT trainer');

INSERT INTO role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM roles AS role
CROSS JOIN permissions AS permission
WHERE role.code = 'student' AND permission.code = 'trainer.use';
   `)
}

// Fails if a trainer test without a course exists; such rows need a decision first.
export const down = pgm => {
   pgm.sql(`
DELETE FROM role_permissions
WHERE permission_id = (SELECT id FROM permissions WHERE code = 'trainer.use');
DELETE FROM permissions WHERE code = 'trainer.use';

ALTER TABLE tests DROP CONSTRAINT tests_course_required_check;
ALTER TABLE tests ALTER COLUMN course_id SET NOT NULL;
   `)
}
