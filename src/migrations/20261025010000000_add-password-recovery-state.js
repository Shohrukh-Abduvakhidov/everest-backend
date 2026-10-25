export const up = pgm => {
  pgm.sql(`
ALTER TABLE auth_challenges
    DROP CONSTRAINT challenges_channel_check,
    ADD CONSTRAINT challenges_channel_check CHECK (channel IN ('sms', 'telegram')),
    ADD COLUMN public_id_hash TEXT,
    ADD COLUMN reset_token_hash TEXT,
    ADD COLUMN reset_expires_at TIMESTAMPTZ,
    ADD COLUMN reset_consumed_at TIMESTAMPTZ,
    ADD CONSTRAINT challenges_public_id_hash_unique UNIQUE (public_id_hash),
    ADD CONSTRAINT challenges_reset_token_hash_unique UNIQUE (reset_token_hash),
    ADD CONSTRAINT challenges_reset_authorization_check CHECK (
        (reset_token_hash IS NULL AND reset_expires_at IS NULL AND reset_consumed_at IS NULL) OR
        (reset_token_hash IS NOT NULL AND consumed_at IS NOT NULL AND reset_expires_at IS NOT NULL AND
         (reset_consumed_at IS NULL OR reset_consumed_at >= consumed_at))
    );

CREATE INDEX challenges_user_purpose_channel_created_idx
    ON auth_challenges(user_id, purpose, channel, created_at DESC);
  `)
}

export const down = pgm => {
  pgm.sql(`
DROP INDEX challenges_user_purpose_channel_created_idx;

ALTER TABLE auth_challenges
    DROP CONSTRAINT challenges_reset_authorization_check,
    DROP CONSTRAINT challenges_reset_token_hash_unique,
    DROP CONSTRAINT challenges_public_id_hash_unique,
    DROP COLUMN reset_consumed_at,
    DROP COLUMN reset_expires_at,
    DROP COLUMN reset_token_hash,
    DROP COLUMN public_id_hash,
    DROP CONSTRAINT challenges_channel_check,
    ADD CONSTRAINT challenges_channel_check CHECK (channel = 'sms');
  `)
}
