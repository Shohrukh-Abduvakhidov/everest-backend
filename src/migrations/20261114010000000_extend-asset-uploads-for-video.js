// Lesson videos reuse asset_uploads (multipart, presigned parts, server-built keys) instead
// of a second upload table. Added: the target lesson, the stored states 'uploading' (a part
// was presigned) and 'expired' (the sweep aborted it in storage), and an index for the
// per-user limit of open uploads.
export const up = pgm => {
  pgm.sql(`
ALTER TABLE asset_uploads
    ADD COLUMN lesson_id BIGINT REFERENCES lessons(id) ON DELETE SET NULL,
    ADD COLUMN expired_at TIMESTAMPTZ;

ALTER TABLE asset_uploads DROP CONSTRAINT asset_uploads_status_check;
ALTER TABLE asset_uploads ADD CONSTRAINT asset_uploads_status_check
    CHECK (status IN ('initiated', 'uploading', 'completed', 'aborted', 'rejected', 'expired'));
ALTER TABLE asset_uploads ADD CONSTRAINT asset_uploads_expired_at_check
    CHECK ((status = 'expired') = (expired_at IS NOT NULL));

CREATE INDEX asset_uploads_open_creator_idx ON asset_uploads (created_by)
    WHERE status IN ('initiated', 'uploading');
CREATE INDEX asset_uploads_open_expiry_idx ON asset_uploads (expires_at)
    WHERE status IN ('initiated', 'uploading');
CREATE INDEX asset_uploads_lesson_idx ON asset_uploads (lesson_id) WHERE lesson_id IS NOT NULL;
  `)
}

export const down = pgm => {
  pgm.sql(`
DROP INDEX asset_uploads_lesson_idx;
DROP INDEX asset_uploads_open_expiry_idx;
DROP INDEX asset_uploads_open_creator_idx;

UPDATE asset_uploads SET status = 'initiated' WHERE status = 'uploading';
UPDATE asset_uploads SET status = 'aborted', aborted_at = expired_at WHERE status = 'expired';

ALTER TABLE asset_uploads DROP CONSTRAINT asset_uploads_expired_at_check;
ALTER TABLE asset_uploads DROP CONSTRAINT asset_uploads_status_check;
ALTER TABLE asset_uploads ADD CONSTRAINT asset_uploads_status_check
    CHECK (status IN ('initiated', 'completed', 'aborted', 'rejected'));

ALTER TABLE asset_uploads
    DROP COLUMN expired_at,
    DROP COLUMN lesson_id;
  `)
}
