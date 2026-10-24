export const up = pgm => {
  pgm.sql(`
-- C Группы: Учебные сообщества, не выдающие доступ к курсам
CREATE TABLE groups (
id UUID PRIMARY KEY,
code TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT,
status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- C Группы: Текущий состав; историю смены статуса хранит аудит
CREATE TABLE group_members (
id UUID PRIMARY KEY,
group_id UUID NOT NULL REFERENCES groups(id) ON DELETE RESTRICT, user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','left','removed')),
is_representative BOOLEAN NOT NULL DEFAULT FALSE,
joined_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, left_at TIMESTAMPTZ,
added_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, UNIQUE (group_id,user_id)
);

-- C Группы: Преподаватели и индивидуальные полномочия в группе
CREATE TABLE group_teachers (
id UUID PRIMARY KEY,
group_id UUID NOT NULL REFERENCES groups(id) ON DELETE RESTRICT, user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
can_publish_announcements BOOLEAN NOT NULL DEFAULT FALSE,
can_assign_tests BOOLEAN NOT NULL DEFAULT FALSE, can_view_results BOOLEAN NOT NULL DEFAULT FALSE,
assigned_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, assigned_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
UNIQUE (group_id,user_id)
);

-- C Группы: Объявления администратора или преподавателя
CREATE TABLE group_announcements (
id UUID PRIMARY KEY,
group_id UUID NOT NULL REFERENCES groups(id) ON DELETE RESTRICT, author_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
title TEXT NOT NULL, content JSONB NOT NULL DEFAULT '{"blocks":[]}',
is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
published_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- C Группы: Вложения объявлений
CREATE TABLE announcement_assets (
announcement_id UUID NOT NULL REFERENCES group_announcements(id) ON DELETE RESTRICT, asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
PRIMARY KEY (announcement_id,asset_id)
);
  `);
};

export const down = pgm => {
  pgm.sql(`
DROP TABLE announcement_assets;
DROP TABLE group_announcements;
DROP TABLE group_teachers;
DROP TABLE group_members;
DROP TABLE groups;
  `);
};
