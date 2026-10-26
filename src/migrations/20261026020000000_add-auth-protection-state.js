export const up = pgm => {
  pgm.sql(`
ALTER TABLE auth_sessions ADD COLUMN csrf_token_hash TEXT;

CREATE TABLE auth_security_counters (
    scope VARCHAR(64) NOT NULL,
    key_hash TEXT NOT NULL,
    window_started_at TIMESTAMPTZ NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    blocked_until TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (scope, key_hash)
);

CREATE INDEX auth_security_counters_expiry_idx
    ON auth_security_counters(blocked_until, window_started_at);
  `)
}

export const down = pgm => {
  pgm.sql(`
DROP INDEX auth_security_counters_expiry_idx;
DROP TABLE auth_security_counters;
ALTER TABLE auth_sessions DROP COLUMN csrf_token_hash;
  `)
}
