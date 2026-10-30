export const up = pgm => {
  pgm.sql(`
ALTER TABLE subjects
    ADD COLUMN color VARCHAR(16) NOT NULL DEFAULT 'neutral',
    ADD CONSTRAINT subjects_color_check
        CHECK (color IN ('green', 'blue', 'orange', 'purple', 'neutral'));
  `)
}

export const down = pgm => {
  pgm.sql(`
ALTER TABLE subjects DROP CONSTRAINT subjects_color_check, DROP COLUMN color;
  `)
}
