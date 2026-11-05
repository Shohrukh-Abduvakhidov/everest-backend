// Lessons reference tests, not the other way round: guard_test() freezes every column of a
// published test, so a tests.lesson_id could never be set on a published test. The composite
// foreign keys make a cross-course link impossible at the database level.
export const up = pgm => {
  pgm.sql(`
ALTER TABLE tests ADD CONSTRAINT tests_id_course_id_key UNIQUE (id, course_id);

ALTER TABLE tests ADD COLUMN module_id BIGINT;
ALTER TABLE tests ADD CONSTRAINT tests_module_id_course_id_fkey
    FOREIGN KEY (module_id, course_id) REFERENCES course_modules(id, course_id) ON DELETE RESTRICT;
CREATE INDEX tests_module_id_course_id_idx ON tests (module_id, course_id);

ALTER TABLE lessons ADD COLUMN test_id BIGINT;
ALTER TABLE lessons ADD CONSTRAINT lessons_test_id_course_id_fkey
    FOREIGN KEY (test_id, course_id) REFERENCES tests(id, course_id) ON DELETE RESTRICT;
ALTER TABLE lessons ADD CONSTRAINT lessons_test_id_lesson_type_check
    CHECK (test_id IS NULL OR lesson_type IN ('test', 'mixed'));
CREATE INDEX lessons_test_id_course_id_idx ON lessons (test_id, course_id);
  `)
}

export const down = pgm => {
  pgm.sql(`
DROP INDEX lessons_test_id_course_id_idx;
ALTER TABLE lessons DROP CONSTRAINT lessons_test_id_lesson_type_check;
ALTER TABLE lessons DROP CONSTRAINT lessons_test_id_course_id_fkey;
ALTER TABLE lessons DROP COLUMN test_id;

DROP INDEX tests_module_id_course_id_idx;
ALTER TABLE tests DROP CONSTRAINT tests_module_id_course_id_fkey;
ALTER TABLE tests DROP COLUMN module_id;

ALTER TABLE tests DROP CONSTRAINT tests_id_course_id_key;
  `)
}
