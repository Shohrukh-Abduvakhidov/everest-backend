export const up = pgm => {
  pgm.sql(`
-- F Вопросы: Банки книг/преподавателей
CREATE TABLE question_banks (
id UUID PRIMARY KEY,
code TEXT NOT NULL UNIQUE, title TEXT NOT NULL, subject_id UUID NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
owner_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, visibility VARCHAR(16) NOT NULL DEFAULT 'private'
CHECK (visibility IN ('private','staff')), source_metadata JSONB NOT NULL DEFAULT '{}',
created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE (id,subject_id)
);

-- F Вопросы: Пакетный импорт и dry-run
CREATE TABLE question_imports (
id UUID PRIMARY KEY,
bank_id UUID NOT NULL REFERENCES question_banks(id) ON DELETE RESTRICT, initiated_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
package_sha256 VARCHAR(64) NOT NULL, schema_version TEXT NOT NULL,
idempotency_key TEXT NOT NULL, is_dry_run BOOLEAN NOT NULL DEFAULT TRUE,
status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','validating','validated','importing','completed','failed')),
manifest JSONB NOT NULL, counters JSONB NOT NULL DEFAULT '{}',
created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at TIMESTAMPTZ,
UNIQUE (bank_id,idempotency_key)
);

-- F Вопросы: Проверяемый отчёт ошибок импорта
CREATE TABLE question_import_errors (
id UUID PRIMARY KEY,
import_id UUID NOT NULL REFERENCES question_imports(id) ON DELETE RESTRICT, external_id TEXT, record_path TEXT,
severity VARCHAR(16) NOT NULL CHECK (severity IN ('warning','error')),
error_code TEXT NOT NULL, message TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- F Вопросы: Содержимое вопроса; изменения опубликованного — через копию
CREATE TABLE questions (
id UUID PRIMARY KEY,
bank_id UUID NOT NULL, subject_id UUID NOT NULL, external_id TEXT,
question_type VARCHAR(24) NOT NULL CHECK (question_type IN ('single_choice','multiple_choice','matching','numeric','short_text')),
language_code VARCHAR(2) NOT NULL CHECK (language_code IN ('tg','ru','en')),
difficulty SMALLINT CHECK (difficulty BETWEEN 1 AND 5),
difficulty_source VARCHAR(16) CHECK (difficulty_source IN ('ai','expert','official')),
status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
content JSONB NOT NULL DEFAULT '{"blocks":[]}', interaction_settings JSONB NOT NULL DEFAULT '{}',
source_metadata JSONB NOT NULL DEFAULT '{}', source_question_id UUID REFERENCES questions(id) ON DELETE RESTRICT,
import_id UUID REFERENCES question_imports(id) ON DELETE RESTRICT, created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
UNIQUE (bank_id,external_id), UNIQUE (id,subject_id), FOREIGN KEY (bank_id,subject_id) REFERENCES question_banks(id,subject_id) ON DELETE RESTRICT,
CHECK (jsonb_typeof(content) = 'object'), CHECK (jsonb_typeof(interaction_settings) = 'object'),
CHECK ((difficulty IS NULL) = (difficulty_source IS NULL)), CHECK (source_question_id IS NULL OR source_question_id <> id)
);

-- F Вопросы: Варианты БЕЗ is_correct
CREATE TABLE question_options (
id UUID PRIMARY KEY,
question_id UUID NOT NULL REFERENCES questions(id) ON DELETE RESTRICT, option_key TEXT NOT NULL,
position INTEGER NOT NULL CHECK (position > 0), source_label TEXT,
content JSONB NOT NULL DEFAULT '{"blocks":[]}', UNIQUE (question_id,option_key), UNIQUE (question_id,position),
UNIQUE (id,question_id)
);

-- F Вопросы: Элементы левой и правой стороны
CREATE TABLE question_matching_items (
id UUID PRIMARY KEY,
question_id UUID NOT NULL REFERENCES questions(id) ON DELETE RESTRICT, side VARCHAR(5) NOT NULL CHECK (side IN ('left','right')),
item_key TEXT NOT NULL, position INTEGER NOT NULL CHECK (position > 0), source_label TEXT,
content JSONB NOT NULL DEFAULT '{"blocks":[]}', UNIQUE (question_id,side,item_key),
UNIQUE (question_id,side,position), UNIQUE (id,question_id)
);

-- F Вопросы: Единственный авторский источник правильного ответа
CREATE TABLE question_answer_keys (
question_id UUID PRIMARY KEY REFERENCES questions(id) ON DELETE RESTRICT,
status VARCHAR(16) NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','proposed','verified')),
source VARCHAR(24) NOT NULL DEFAULT 'none' CHECK (source IN ('none','official_key','expert_review','ai_inference')),
answer_data JSONB, explanation JSONB NOT NULL DEFAULT '{"blocks":[]}',
verified_by UUID REFERENCES users(id) ON DELETE RESTRICT, verified_at TIMESTAMPTZ,
updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
CHECK (answer_data IS NULL OR jsonb_typeof(answer_data) = 'object'),
CHECK (status = 'unknown' OR answer_data IS NOT NULL),
CHECK (status <> 'verified' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL AND source <> 'none'))
);

-- F Вопросы: Темы вопроса должны принадлежать тому же предмету
CREATE TABLE question_topics (
question_id UUID NOT NULL, topic_id UUID NOT NULL, subject_id UUID NOT NULL,
PRIMARY KEY (question_id,topic_id), FOREIGN KEY (question_id,subject_id) REFERENCES questions(id,subject_id) ON DELETE RESTRICT,
FOREIGN KEY (topic_id,subject_id) REFERENCES topics(id,subject_id) ON DELETE RESTRICT
);

-- F Вопросы: Файлы, используемые в вопросе/вариантах/объяснении
CREATE TABLE question_assets (
question_id UUID NOT NULL REFERENCES questions(id) ON DELETE RESTRICT, asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
PRIMARY KEY (question_id,asset_id)
);

-- F Вопросы: Дубликаты сохраняют ID; генератор исключает повторы
CREATE TABLE question_duplicate_links (
question_id UUID NOT NULL REFERENCES questions(id) ON DELETE RESTRICT, duplicate_of_id UUID NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
reason TEXT, marked_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, PRIMARY KEY (question_id,duplicate_of_id),
CHECK (question_id <> duplicate_of_id)
);
  `);
};

export const down = pgm => {
  pgm.sql(`
DROP TABLE question_duplicate_links;
DROP TABLE question_assets;
DROP TABLE question_topics;
DROP TABLE question_answer_keys;
DROP TABLE question_matching_items;
DROP TABLE question_options;
DROP TABLE questions;
DROP TABLE question_import_errors;
DROP TABLE question_imports;
DROP TABLE question_banks;
  `);
};
