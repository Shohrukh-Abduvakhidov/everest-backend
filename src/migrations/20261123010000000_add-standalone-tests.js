// M10 tail (decisions.md 2026-11-23): tests outside courses.
// - origin 'standalone': an authored test with no course and no module. A student reaches it only
//   through an active assignment (their group or themselves); no enrollment is needed.
// - tests_course_required_check now also lets a standalone test go without a course, and a new
//   check keeps standalone tests without course and module. Course tests are unchanged.
// - Teachers may publish their own tests (the service checks created_by), so tests.publish is
//   bound to the teacher role.
export const up = pgm => {
   pgm.sql(`
ALTER TABLE tests DROP CONSTRAINT tests_origin_check;
ALTER TABLE tests ADD CONSTRAINT tests_origin_check
    CHECK (origin IN ('authored', 'trainer', 'mock_exam', 'standalone'));

ALTER TABLE tests DROP CONSTRAINT tests_course_required_check;
ALTER TABLE tests ADD CONSTRAINT tests_course_required_check
    CHECK (course_id IS NOT NULL OR origin IN ('trainer', 'mock_exam', 'standalone'));

ALTER TABLE tests ADD CONSTRAINT tests_standalone_without_course_check
    CHECK (origin <> 'standalone' OR (course_id IS NULL AND module_id IS NULL));

CREATE INDEX tests_standalone_created_by_idx ON tests (created_by, id) WHERE origin = 'standalone';

INSERT INTO role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM roles AS role
CROSS JOIN permissions AS permission
WHERE role.code = 'teacher' AND permission.code = 'tests.publish'
ON CONFLICT DO NOTHING;
   `)
}

// Refuses while standalone tests exist: the restored checks would reject them, and dropping them
// would take their assignments and attempts. Such rows need a decision first.
export const down = pgm => {
   pgm.sql(`
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tests WHERE origin = 'standalone') THEN
    RAISE EXCEPTION 'STANDALONE_TESTS_EXIST: remove or convert standalone tests before rolling back';
  END IF;
END $$;

DELETE FROM role_permissions
WHERE role_id IN (SELECT id FROM roles WHERE code = 'teacher')
  AND permission_id = (SELECT id FROM permissions WHERE code = 'tests.publish');

DROP INDEX tests_standalone_created_by_idx;
ALTER TABLE tests DROP CONSTRAINT tests_standalone_without_course_check;

ALTER TABLE tests DROP CONSTRAINT tests_course_required_check;
ALTER TABLE tests ADD CONSTRAINT tests_course_required_check
    CHECK (course_id IS NOT NULL OR origin IN ('trainer', 'mock_exam'));

ALTER TABLE tests DROP CONSTRAINT tests_origin_check;
ALTER TABLE tests ADD CONSTRAINT tests_origin_check
    CHECK (origin IN ('authored', 'trainer', 'mock_exam'));
   `)
}
