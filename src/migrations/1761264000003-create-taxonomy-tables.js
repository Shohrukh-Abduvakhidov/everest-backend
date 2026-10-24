export const up = pgm => {
  pgm.sql(`
-- D Справочники: Предметы
CREATE TABLE subjects (
id UUID PRIMARY KEY,
code TEXT NOT NULL UNIQUE, primary_language VARCHAR(2) NOT NULL DEFAULT 'tg',
CHECK (primary_language IN ('tg','ru','en'))
);

-- D Справочники: Необязательные переводы названия предмета
CREATE TABLE subject_translations (
subject_id UUID NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT, language_code VARCHAR(2) NOT NULL,
title TEXT NOT NULL, PRIMARY KEY (subject_id,language_code), CHECK (language_code IN ('tg','ru','en'))
);

-- D Справочники: Разделы предметов
CREATE TABLE sections (
id UUID PRIMARY KEY,
subject_id UUID NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT, code TEXT NOT NULL,
primary_language VARCHAR(2) NOT NULL DEFAULT 'tg', UNIQUE (subject_id,code), UNIQUE (id,subject_id),
CHECK (primary_language IN ('tg','ru','en'))
);

-- D Справочники: Необязательные переводы разделов
CREATE TABLE section_translations (
section_id UUID NOT NULL REFERENCES sections(id) ON DELETE RESTRICT, language_code VARCHAR(2) NOT NULL,
title TEXT NOT NULL, PRIMARY KEY (section_id,language_code), CHECK (language_code IN ('tg','ru','en'))
);

-- D Справочники: Темы и подтемы с проверкой принадлежности предмету
CREATE TABLE topics (
id UUID PRIMARY KEY,
subject_id UUID NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT, section_id UUID, parent_id UUID,
code TEXT NOT NULL, primary_language VARCHAR(2) NOT NULL DEFAULT 'tg',
UNIQUE (subject_id,code), UNIQUE (id,subject_id), CHECK (parent_id IS NULL OR parent_id <> id),
CHECK (primary_language IN ('tg','ru','en')),
FOREIGN KEY (section_id,subject_id) REFERENCES sections(id,subject_id) ON DELETE RESTRICT,
FOREIGN KEY (parent_id,subject_id) REFERENCES topics(id,subject_id) ON DELETE RESTRICT
);

-- D Справочники: Необязательные переводы тем
CREATE TABLE topic_translations (
topic_id UUID NOT NULL REFERENCES topics(id) ON DELETE RESTRICT, language_code VARCHAR(2) NOT NULL,
title TEXT NOT NULL, PRIMARY KEY (topic_id,language_code), CHECK (language_code IN ('tg','ru','en'))
);
  `);
};

export const down = pgm => {
  pgm.sql(`
DROP TABLE topic_translations;
DROP TABLE topics;
DROP TABLE section_translations;
DROP TABLE sections;
DROP TABLE subject_translations;
DROP TABLE subjects;
  `);
};
