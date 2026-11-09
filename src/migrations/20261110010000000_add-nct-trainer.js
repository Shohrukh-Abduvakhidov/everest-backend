// NCT trainer: a training session is a test generated for one student and run by the existing
// attempt engine. origin tells generated tests apart so authoring, lesson links, course
// assignment lists and staff results never show them. The idempotency key of a generation
// lives in generation_filters and is unique per student.
export const up = pgm => {
   pgm.sql(`
ALTER TABLE tests
    ADD COLUMN origin VARCHAR(16) NOT NULL DEFAULT 'authored',
    ADD CONSTRAINT tests_origin_check CHECK (origin IN ('authored', 'trainer'));

CREATE INDEX tests_trainer_created_by_idx ON tests (created_by, id) WHERE origin = 'trainer';

CREATE UNIQUE INDEX tests_trainer_idempotency_idx
    ON tests (created_by, (generation_filters ->> 'idempotencyKey'))
    WHERE origin = 'trainer' AND generation_filters ? 'idempotencyKey';
   `)
}

export const down = pgm => {
   pgm.sql(`
DROP INDEX tests_trainer_idempotency_idx;
DROP INDEX tests_trainer_created_by_idx;
ALTER TABLE tests DROP CONSTRAINT tests_origin_check, DROP COLUMN origin;
   `)
}
