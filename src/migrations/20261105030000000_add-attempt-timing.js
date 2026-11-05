// M11: the personal window is measured from the student's first attempt of an assignment, so
// no per-student row is needed. The partial index keeps the expiry sweep cheap.
export const up = pgm => {
  pgm.sql(`
ALTER TABLE test_assignments ADD COLUMN personal_window_minutes INTEGER
    CHECK (personal_window_minutes > 0);

CREATE INDEX attempts_expiring_idx ON test_attempts (expires_at)
    WHERE status = 'in_progress' AND expires_at IS NOT NULL;
  `)
}

export const down = pgm => {
  pgm.sql(`
DROP INDEX attempts_expiring_idx;
ALTER TABLE test_assignments DROP COLUMN personal_window_minutes;
  `)
}
