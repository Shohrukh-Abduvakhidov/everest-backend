export const up = pgm => {
  pgm.sql(`
-- E Обучение: Курсы; не связаны с группами
CREATE TABLE courses (
id UUID PRIMARY KEY,
subject_id UUID REFERENCES subjects(id) ON DELETE RESTRICT, title TEXT NOT NULL, description TEXT,
language_code VARCHAR(2) NOT NULL DEFAULT 'ru' CHECK (language_code IN ('tg','ru','en')),
translations JSONB NOT NULL DEFAULT '{}', cover_asset_id UUID REFERENCES assets(id) ON DELETE RESTRICT,
status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- E Обучение: Права преподавателя на конкретный курс
CREATE TABLE course_teachers (
id UUID PRIMARY KEY,
course_id UUID NOT NULL REFERENCES courses(id) ON DELETE RESTRICT, user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
can_manage_lessons BOOLEAN NOT NULL DEFAULT FALSE, can_manage_questions BOOLEAN NOT NULL DEFAULT FALSE,
can_manage_tests BOOLEAN NOT NULL DEFAULT FALSE, can_view_results BOOLEAN NOT NULL DEFAULT FALSE,
assigned_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, UNIQUE (course_id,user_id)
);

-- E Обучение: Администратор вручную выдаёт доступ человеку к курсу
CREATE TABLE course_enrollments (
id UUID PRIMARY KEY,
user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, course_id UUID NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
granted_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, granted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
begins_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TIMESTAMPTZ,
revoked_at TIMESTAMPTZ, revoked_by UUID REFERENCES users(id) ON DELETE RESTRICT,
UNIQUE (user_id,course_id), CHECK (expires_at IS NULL OR expires_at > begins_at),
CHECK (revoked_by IS NULL OR revoked_at IS NOT NULL)
);

-- E Обучение: Модули и публичные метаданные закрытых модулей
CREATE TABLE course_modules (
id UUID PRIMARY KEY,
course_id UUID NOT NULL REFERENCES courses(id) ON DELETE RESTRICT, title TEXT NOT NULL, description TEXT,
position INTEGER NOT NULL CHECK (position > 0), translations JSONB NOT NULL DEFAULT '{}',
status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
UNIQUE (course_id,position), UNIQUE (id,course_id)
);

-- E Обучение: Отдельный доступ к модулю; курс должен быть назначен
CREATE TABLE module_access_grants (
id UUID PRIMARY KEY,
user_id UUID NOT NULL, course_id UUID NOT NULL, module_id UUID NOT NULL,
granted_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, granted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
begins_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TIMESTAMPTZ,
revoked_at TIMESTAMPTZ, revoked_by UUID REFERENCES users(id) ON DELETE RESTRICT, UNIQUE (user_id,module_id),
FOREIGN KEY (user_id,course_id) REFERENCES course_enrollments(user_id,course_id) ON DELETE RESTRICT,
FOREIGN KEY (module_id,course_id) REFERENCES course_modules(id,course_id) ON DELETE RESTRICT,
CHECK (expires_at IS NULL OR expires_at > begins_at), CHECK (revoked_by IS NULL OR revoked_at IS NOT NULL)
);

-- E Обучение: Уроки внутри модуля
CREATE TABLE lessons (
id UUID PRIMARY KEY,
module_id UUID NOT NULL, course_id UUID NOT NULL,
title TEXT NOT NULL, position INTEGER NOT NULL CHECK (position > 0),
lesson_type VARCHAR(16) NOT NULL CHECK (lesson_type IN ('video','text','test','mixed')),
content JSONB NOT NULL DEFAULT '{"blocks":[]}', translations JSONB NOT NULL DEFAULT '{}',
video_asset_id UUID REFERENCES assets(id) ON DELETE RESTRICT, allow_offline BOOLEAN NOT NULL DEFAULT FALSE,
status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
UNIQUE (module_id,position), UNIQUE (id,course_id),
FOREIGN KEY (module_id,course_id) REFERENCES course_modules(id,course_id) ON DELETE RESTRICT
);

-- E Обучение: Дополнительные материалы урока
CREATE TABLE lesson_resources (
id UUID PRIMARY KEY,
lesson_id UUID NOT NULL REFERENCES lessons(id) ON DELETE RESTRICT, asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
title TEXT, position INTEGER NOT NULL DEFAULT 1 CHECK (position > 0), UNIQUE (lesson_id,asset_id)
);

-- E Обучение: Текущий прогресс; не каждую секунду отдельной строкой
CREATE TABLE lesson_progress (
user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, lesson_id UUID NOT NULL REFERENCES lessons(id) ON DELETE RESTRICT,
status VARCHAR(16) NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started','in_progress','completed')),
playback_seconds INTEGER NOT NULL DEFAULT 0 CHECK (playback_seconds >= 0),
watched_seconds INTEGER NOT NULL DEFAULT 0 CHECK (watched_seconds >= 0),
completed_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0), PRIMARY KEY (user_id,lesson_id),
CHECK (status <> 'completed' OR completed_at IS NOT NULL)
);

-- E Обучение: Личные заметки, видимые только владельцу
CREATE TABLE lesson_notes (
id UUID PRIMARY KEY,
user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, lesson_id UUID NOT NULL REFERENCES lessons(id) ON DELETE RESTRICT,
body TEXT NOT NULL, playback_seconds INTEGER CHECK (playback_seconds >= 0),
created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- E Обучение: Избранные курсы
CREATE TABLE course_favorites (
user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, course_id UUID NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id,course_id)
);

-- E Обучение: Разрешения и учёт офлайн-загрузок; не DRM
CREATE TABLE offline_downloads (
id UUID PRIMARY KEY,
user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, session_id UUID NOT NULL REFERENCES auth_sessions(id) ON DELETE RESTRICT,
lesson_id UUID NOT NULL REFERENCES lessons(id) ON DELETE RESTRICT, asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
granted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, lease_expires_at TIMESTAMPTZ NOT NULL,
last_checked_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ, UNIQUE (session_id,lesson_id,asset_id),
CHECK (lease_expires_at > granted_at)
);
  `);
};

export const down = pgm => {
  pgm.sql(`
DROP TABLE offline_downloads;
DROP TABLE course_favorites;
DROP TABLE lesson_notes;
DROP TABLE lesson_progress;
DROP TABLE lesson_resources;
DROP TABLE lessons;
DROP TABLE module_access_grants;
DROP TABLE course_modules;
DROP TABLE course_enrollments;
DROP TABLE course_teachers;
DROP TABLE courses;
  `);
};
