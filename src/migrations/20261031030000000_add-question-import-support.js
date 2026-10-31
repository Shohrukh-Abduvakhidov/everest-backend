// M09: content-addressed image reuse and paginated import error reports.
// assets.sha256 was never filled before M09, so the partial unique index cannot conflict
// with existing rows.
export const up = pgm => {
  pgm.sql(`
CREATE UNIQUE INDEX assets_sha256_key ON assets (sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX question_import_errors_import_id_id_idx ON question_import_errors (import_id, id);
  `)
}

export const down = pgm => {
  pgm.sql(`
DROP INDEX question_import_errors_import_id_id_idx;
DROP INDEX assets_sha256_key;
  `)
}
