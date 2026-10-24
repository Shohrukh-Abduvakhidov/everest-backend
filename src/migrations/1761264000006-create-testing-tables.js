export const up = pgm => {
  pgm.sql(`
-- G Тестирование: Фиксированный вариант теста; правки опубликованного через копию
CREATE TABLE tests (
id UUID PRIMARY KEY,
title TEXT NOT NULL, mode VARCHAR(16) NOT NULL CHECK (mode IN ('lesson','practice','exam','nct')),
status VARCHAR(16) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
duration_seconds INTEGER CHECK (duration_seconds > 0),
max_attempts INTEGER CHECK (max_attempts > 0), result_policy VARCHAR(16) NOT NULL DEFAULT 'first'
CHECK (result_policy IN ('first','best','last')),
answer_reveal_policy VARCHAR(24) NOT NULL DEFAULT 'after_submission'
CHECK (answer_reveal_policy IN ('after_answer','after_submission','after_window','never')),
shuffle_questions BOOLEAN NOT NULL DEFAULT FALSE, shuffle_options BOOLEAN NOT NULL DEFAULT FALSE,
grading_policy JSONB NOT NULL DEFAULT '{}', generation_filters JSONB NOT NULL DEFAULT '{}',
copied_from_id UUID REFERENCES tests(id) ON DELETE RESTRICT, created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
CHECK (mode NOT IN ('exam','nct') OR duration_seconds IS NOT NULL),
CHECK (mode NOT IN ('exam','nct') OR answer_reveal_policy <> 'after_answer')
);

-- G Тестирование: Зафиксированные вопросы теста и максимальные баллы
CREATE TABLE test_questions (
id UUID PRIMARY KEY,
test_id UUID NOT NULL REFERENCES tests(id) ON DELETE RESTRICT, question_id UUID NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
position INTEGER NOT NULL CHECK (position > 0), points NUMERIC(10,2) NOT NULL CHECK (points > 0),
UNIQUE (test_id,question_id), UNIQUE (test_id,position), UNIQUE (id,test_id,question_id)
);

-- G Тестирование: Одно назначение — одна аудитория; курс, урок, группа или ученик
CREATE TABLE test_assignments (
id UUID PRIMARY KEY,
test_id UUID NOT NULL REFERENCES tests(id) ON DELETE RESTRICT, course_id UUID REFERENCES courses(id) ON DELETE RESTRICT,
lesson_id UUID REFERENCES lessons(id) ON DELETE RESTRICT, group_id UUID REFERENCES groups(id) ON DELETE RESTRICT, user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
assigned_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','closed')),
opens_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, closes_at TIMESTAMPTZ,
counts_for_group_ranking BOOLEAN NOT NULL DEFAULT FALSE,
created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE (id,test_id),
CHECK (num_nonnulls(course_id,lesson_id,group_id,user_id) = 1),
CHECK (closes_at IS NULL OR closes_at > opens_at),
CHECK (NOT counts_for_group_ranking OR group_id IS NOT NULL)
);

-- G Тестирование: Попытки и серверный таймер; номер считается в рамках назначения
CREATE TABLE test_attempts (
id UUID PRIMARY KEY,
test_id UUID NOT NULL REFERENCES tests(id) ON DELETE RESTRICT, assignment_id UUID NOT NULL,
user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
status VARCHAR(16) NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','paused','submitted','expired','graded','cancelled')),
started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TIMESTAMPTZ,
paused_at TIMESTAMPTZ, paused_seconds INTEGER NOT NULL DEFAULT 0 CHECK (paused_seconds >= 0),
submitted_at TIMESTAMPTZ, graded_at TIMESTAMPTZ,
score NUMERIC(12,2) CHECK (score >= 0), max_score NUMERIC(12,2) CHECK (max_score > 0),
policy_snapshot JSONB NOT NULL, UNIQUE (assignment_id,user_id,attempt_number), UNIQUE (id,test_id),
FOREIGN KEY (assignment_id,test_id) REFERENCES test_assignments(id,test_id) ON DELETE RESTRICT,
CHECK (expires_at IS NULL OR expires_at > started_at), CHECK (score IS NULL OR max_score IS NULL OR score <= max_score),
CHECK (status <> 'paused' OR paused_at IS NOT NULL),
CHECK (status <> 'graded' OR (score IS NOT NULL AND max_score IS NOT NULL AND graded_at IS NOT NULL))
);

-- G Тестирование: Порядок и служебный снимок условий оценивания конкретной попытки
CREATE TABLE attempt_questions (
id UUID PRIMARY KEY,
attempt_id UUID NOT NULL, test_id UUID NOT NULL, test_question_id UUID NOT NULL, question_id UUID NOT NULL,
position INTEGER NOT NULL CHECK (position > 0), option_order JSONB NOT NULL DEFAULT '[]',
matching_order JSONB NOT NULL DEFAULT '{}', max_points NUMERIC(10,2) NOT NULL CHECK (max_points > 0),
grading_snapshot JSONB NOT NULL, UNIQUE (attempt_id,position), UNIQUE (attempt_id,test_question_id), UNIQUE (id,question_id),
FOREIGN KEY (attempt_id,test_id) REFERENCES test_attempts(id,test_id) ON DELETE RESTRICT,
FOREIGN KEY (test_question_id,test_id,question_id) REFERENCES test_questions(id,test_id,question_id) ON DELETE RESTRICT,
CHECK (jsonb_typeof(option_order) = 'array'), CHECK (jsonb_typeof(grading_snapshot) = 'object')
);

-- G Тестирование: Один текущий ответ; autosave обновляет запись с revision
CREATE TABLE student_answers (
attempt_question_id UUID PRIMARY KEY, question_id UUID NOT NULL,
answer_data JSONB, awarded_points NUMERIC(10,2) CHECK (awarded_points >= 0),
grading_status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (grading_status IN ('pending','auto','manual','needs_review')),
revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0), saved_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
graded_by UUID REFERENCES users(id) ON DELETE RESTRICT, graded_at TIMESTAMPTZ,
FOREIGN KEY (attempt_question_id,question_id) REFERENCES attempt_questions(id,question_id) ON DELETE RESTRICT
);

-- G Тестирование: Управляемый пересчёт с сохранением прежнего результата
CREATE TABLE attempt_score_revisions (
id UUID PRIMARY KEY,
attempt_id UUID NOT NULL REFERENCES test_attempts(id) ON DELETE RESTRICT, revised_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
reason TEXT NOT NULL, previous_score NUMERIC(12,2), new_score NUMERIC(12,2) NOT NULL CHECK (new_score >= 0),
grading_snapshot JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
idempotency_key TEXT NOT NULL UNIQUE
);
  `);
};

export const down = pgm => {
  pgm.sql(`
DROP TABLE attempt_score_revisions;
DROP TABLE student_answers;
DROP TABLE attempt_questions;
DROP TABLE test_attempts;
DROP TABLE test_assignments;
DROP TABLE test_questions;
DROP TABLE tests;
  `);
};
