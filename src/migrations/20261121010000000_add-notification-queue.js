// M14 PR 1: in-app notifications and the background job queue (decisions.md 2026-11-21, D3–D7).
// - notification_settings: per-user Telegram switch and quiet hours (used by PR 2; no row means
//   the defaults: Telegram on, quiet hours 22:00–08:00 in the profile time zone);
// - notification_deliveries gains a lease and updated_at for the Telegram sender (PR 2);
// - indexes for the inbox: newest first by id, and unread only.
// background_jobs and notifications already exist (baseline migrations 010 and 009).
export const up = pgm => {
   pgm.sql(`
CREATE TABLE notification_settings (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
    telegram_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    quiet_start TIME DEFAULT '22:00',
    quiet_end TIME DEFAULT '08:00',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT notification_settings_quiet_pair CHECK ((quiet_start IS NULL) = (quiet_end IS NULL))
);

ALTER TABLE notification_deliveries
    ADD COLUMN lease_expires_at TIMESTAMPTZ,
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX delivery_lease_idx ON notification_deliveries (lease_expires_at) WHERE status = 'sending';
CREATE INDEX notifications_user_id_idx ON notifications (user_id, id DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id, id DESC) WHERE read_at IS NULL;
   `)
}

export const down = pgm => {
   pgm.sql(`
DROP INDEX notifications_unread_idx;
DROP INDEX notifications_user_id_idx;
DROP INDEX delivery_lease_idx;

ALTER TABLE notification_deliveries
    DROP COLUMN updated_at,
    DROP COLUMN lease_expires_at;

DROP TABLE notification_settings;
   `)
}
