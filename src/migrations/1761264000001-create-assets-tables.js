export const up = pgm => {
  pgm.sql(`
-- B Файлы: Метаданные файлов; сами байты вне PostgreSQL
CREATE TABLE assets (
id UUID PRIMARY KEY,
storage_key TEXT NOT NULL UNIQUE, mime_type TEXT NOT NULL, file_name TEXT,
size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0), sha256 VARCHAR(64),
width_px INTEGER CHECK (width_px > 0), height_px INTEGER CHECK (height_px > 0),
duration_seconds INTEGER CHECK (duration_seconds >= 0),
status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','quarantined','archived')),
uploaded_by UUID REFERENCES users(id) ON DELETE RESTRICT, source_metadata JSONB NOT NULL DEFAULT '{}',
created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$')
);

-- B Файлы: Внешние ID разных импортов могут ссылаться на один файл
CREATE TABLE asset_aliases (
id UUID PRIMARY KEY,
source_namespace TEXT NOT NULL, external_id TEXT NOT NULL,
asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE RESTRICT, UNIQUE (source_namespace, external_id)
);
ALTER TABLE user_profiles ADD COLUMN avatar_asset_id UUID REFERENCES assets(id) ON DELETE RESTRICT;
  `);
};

export const down = pgm => {
  pgm.sql(`
ALTER TABLE user_profiles DROP COLUMN avatar_asset_id;
DROP TABLE asset_aliases;
DROP TABLE assets;
  `);
};
