// M13 PR 2 (decisions.md 2026-11-26): achievements and ranking snapshots.
// - achievements (baseline table, unused until now) gains family, category, tier, translations,
//   icon and position; the catalog below is seeded here. Thresholds live in criteria, so they
//   can change without code.
// - user_achievements gains metadata (what earned it) and seen_at (the student saw the
//   congratulation).
// - group_ranking_snapshots keeps the places of finished weeks and months (worker:jobs).
// Down removes the seeded catalog together with the awards of these codes.

const catalog = [
   {
      code: 'first_step', family: 'first_step', category: 'start', tier: null, icon: 'first-step', position: 10,
      criteria: { type: 'attempt_finished', target: 1 },
      ru: ['Первый шаг', 'Завершите первый тест или тренировку'],
      tg: ['Қадами аввал', 'Аввалин санҷиш ё машқро анҷом диҳед'],
      en: ['First step', 'Finish your first test or training'],
   },
   {
      code: 'first_mock', family: 'first_mock', category: 'mock', tier: null, icon: 'first-mock', position: 20,
      criteria: { type: 'mock_exam_finished', target: 1 },
      ru: ['Первый пробный НЦТ', 'Завершите первый пробный НЦТ'],
      tg: ['Аввалин ММТ-и озмоишӣ', 'Аввалин ММТ-и озмоиширо анҷом диҳед'],
      en: ['First mock NCT', 'Finish your first mock NCT'],
   },
   {
      code: 'solver_bronze', family: 'solver', category: 'trainer', tier: 'bronze', icon: 'solver', position: 30,
      criteria: { type: 'trainer_solved', target: 100 },
      ru: ['Решатель', 'Решите 100 разных вопросов тренажёра на полный балл'],
      tg: ['Ҳалкунанда', '100 саволи гуногуни тренажёрро бо холи пурра ҳал кунед'],
      en: ['Solver', 'Solve 100 different trainer questions with full marks'],
   },
   {
      code: 'solver_silver', family: 'solver', category: 'trainer', tier: 'silver', icon: 'solver', position: 31,
      criteria: { type: 'trainer_solved', target: 500 },
      ru: ['Решатель', 'Решите 500 разных вопросов тренажёра на полный балл'],
      tg: ['Ҳалкунанда', '500 саволи гуногуни тренажёрро бо холи пурра ҳал кунед'],
      en: ['Solver', 'Solve 500 different trainer questions with full marks'],
   },
   {
      code: 'solver_gold', family: 'solver', category: 'trainer', tier: 'gold', icon: 'solver', position: 32,
      criteria: { type: 'trainer_solved', target: 1000 },
      ru: ['Решатель', 'Решите 1000 разных вопросов тренажёра на полный балл'],
      tg: ['Ҳалкунанда', '1000 саволи гуногуни тренажёрро бо холи пурра ҳал кунед'],
      en: ['Solver', 'Solve 1000 different trainer questions with full marks'],
   },
   {
      code: 'mistakes_fixed', family: 'mistakes_fixed', category: 'trainer', tier: null, icon: 'mistakes-fixed', position: 40,
      criteria: { type: 'mistakes_fixed', target: 50 },
      ru: ['Работа над ошибками', 'Исправьте 50 ошибок: решите на полный балл вопросы, в которых ошибались'],
      tg: ['Кор бо хатоҳо', '50 хаторо ислоҳ кунед: саволҳоеро, ки дар онҳо хато карда будед, бо холи пурра ҳал кунед'],
      en: ['Mistakes fixed', 'Fix 50 mistakes: solve questions you got wrong with full marks'],
   },
   {
      code: 'subject_ready', family: 'subject_ready', category: 'trainer', tier: null, icon: 'subject-ready', position: 50,
      criteria: { type: 'subject_readiness', percent: 85, minQuestions: 30 },
      ru: ['Готов к экзамену', 'Готовность по любому предмету 85% или выше'],
      tg: ['Ба имтиҳон омода', 'Омодагӣ аз ягон фан 85% ё бештар'],
      en: ['Exam ready', 'Reach 85% readiness in any subject'],
   },
   {
      code: 'perfect_score', family: 'perfect_score', category: 'tests', tier: null, icon: 'perfect-score', position: 60,
      criteria: { type: 'perfect_score', minQuestions: 10 },
      ru: ['Без единой ошибки', 'Наберите 100% в тесте учителя или курса из 10 и более вопросов'],
      tg: ['Бе ягон хато', 'Дар санҷиши омӯзгор ё курс аз 10 савол ва бештар 100% гиред'],
      en: ['Flawless', 'Score 100% on a teacher or course test of 10 or more questions'],
   },
   {
      code: 'first_try_5', family: 'first_try_5', category: 'tests', tier: null, icon: 'first-try', position: 70,
      criteria: { type: 'first_try_passed', target: 5 },
      ru: ['С первой попытки', 'Сдайте 5 разных тестов с первой попытки'],
      tg: ['Аз кӯшиши аввал', '5 санҷиши гуногунро аз кӯшиши аввал супоред'],
      en: ['First try', 'Pass 5 different tests on the first attempt'],
   },
   {
      code: 'on_time_5', family: 'on_time_5', category: 'tests', tier: null, icon: 'on-time', position: 80,
      criteria: { type: 'assignments_on_time', target: 5 },
      ru: ['Всегда вовремя', 'Сдайте 5 заданий группы подряд до срока'],
      tg: ['Ҳамеша сари вақт', '5 супориши гурӯҳро пай дар пай то мӯҳлат супоред'],
      en: ['Always on time', 'Hand in 5 group assignments in a row before the deadline'],
   },
   {
      code: 'mock_120', family: 'mock_120', category: 'mock', tier: null, icon: 'mock-120', position: 90,
      criteria: { type: 'mock_exam_score', minScore: 120 },
      ru: ['120 баллов', 'Наберите 120 или больше из 160 в пробном НЦТ'],
      tg: ['120 хол', 'Дар ММТ-и озмоишӣ аз 160 хол 120 ё бештар гиред'],
      en: ['120 points', 'Score 120 or more out of 160 on a mock NCT'],
   },
   {
      code: 'lessons_25', family: 'lessons_25', category: 'courses', tier: null, icon: 'lessons', position: 100,
      criteria: { type: 'lessons_completed', target: 25 },
      ru: ['25 уроков', 'Завершите 25 уроков'],
      tg: ['25 дарс', '25 дарсро анҷом диҳед'],
      en: ['25 lessons', 'Complete 25 lessons'],
   },
   {
      code: 'course_completed', family: 'course_completed', category: 'courses', tier: null, icon: 'course-completed', position: 110,
      criteria: { type: 'course_completed' },
      ru: ['Курс пройден', 'Завершите все уроки курса'],
      tg: ['Курс тамом шуд', 'Ҳамаи дарсҳои курсро анҷом диҳед'],
      en: ['Course completed', 'Complete every lesson of a course'],
   },
   {
      code: 'streak_bronze', family: 'streak', category: 'streak', tier: 'bronze', icon: 'streak', position: 120,
      criteria: { type: 'activity_streak', days: 3, minWatchSeconds: 300 },
      ru: ['Серия', 'Занимайтесь 3 дня подряд'],
      tg: ['Силсила', '3 рӯз пай дар пай машғул шавед'],
      en: ['Streak', 'Study 3 days in a row'],
   },
   {
      code: 'streak_silver', family: 'streak', category: 'streak', tier: 'silver', icon: 'streak', position: 121,
      criteria: { type: 'activity_streak', days: 7, minWatchSeconds: 300 },
      ru: ['Серия', 'Занимайтесь 7 дней подряд'],
      tg: ['Силсила', '7 рӯз пай дар пай машғул шавед'],
      en: ['Streak', 'Study 7 days in a row'],
   },
   {
      code: 'streak_gold', family: 'streak', category: 'streak', tier: 'gold', icon: 'streak', position: 122,
      criteria: { type: 'activity_streak', days: 30, minWatchSeconds: 300 },
      ru: ['Серия', 'Занимайтесь 30 дней подряд'],
      tg: ['Силсила', '30 рӯз пай дар пай машғул шавед'],
      en: ['Streak', 'Study 30 days in a row'],
   },
   {
      code: 'group_top3', family: 'group_top3', category: 'group', tier: null, icon: 'group-top3', position: 130,
      criteria: { type: 'group_top3', maxRank: 3, minParticipants: 5, periodKind: 'week' },
      ru: ['Тройка лучших', 'Войдите в тройку лучших недельного рейтинга группы'],
      tg: ['Се беҳтарин', 'Ба се беҳтарини рейтинги ҳафтаинаи гурӯҳ дохил шавед'],
      en: ['Top three', 'Make the top three of your group’s weekly ranking'],
   },
]

const literal = (value) => `'${String(value).replaceAll("'", "''")}'`

function catalogRows() {
   return catalog.map((item) => {
      const translations = {
         ru: { title: item.ru[0], description: item.ru[1] },
         tg: { title: item.tg[0], description: item.tg[1] },
         en: { title: item.en[0], description: item.en[1] },
      }
      return `(${[
         literal(item.code),
         literal(item.ru[0]),
         literal(item.ru[1]),
         `${literal(JSON.stringify(item.criteria))}::jsonb`,
         literal(item.family),
         literal(item.category),
         item.tier ? literal(item.tier) : 'NULL',
         `${literal(JSON.stringify(translations))}::jsonb`,
         literal(item.icon),
         item.position,
      ].join(', ')})`
   }).join(',\n')
}

const codes = catalog.map((item) => literal(item.code)).join(', ')

export const up = pgm => {
   pgm.sql(`
ALTER TABLE achievements
    ADD COLUMN family TEXT,
    ADD COLUMN category VARCHAR(16),
    ADD COLUMN tier VARCHAR(8),
    ADD COLUMN translations JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN icon TEXT,
    ADD COLUMN position INTEGER NOT NULL DEFAULT 0;

UPDATE achievements SET family = code, category = 'start', icon = code WHERE family IS NULL;

ALTER TABLE achievements
    ALTER COLUMN family SET NOT NULL,
    ALTER COLUMN category SET NOT NULL,
    ALTER COLUMN icon SET NOT NULL,
    ADD CONSTRAINT achievements_category_check
        CHECK (category IN ('start', 'trainer', 'tests', 'mock', 'courses', 'streak', 'group')),
    ADD CONSTRAINT achievements_tier_check CHECK (tier IS NULL OR tier IN ('bronze', 'silver', 'gold')),
    ADD CONSTRAINT achievements_translations_check CHECK (jsonb_typeof(translations) = 'object'),
    ADD CONSTRAINT achievements_criteria_check CHECK (jsonb_typeof(criteria) = 'object' AND criteria ? 'type');

CREATE UNIQUE INDEX achievements_family_tier_idx ON achievements (family, COALESCE(tier, ''));

ALTER TABLE user_achievements
    ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN seen_at TIMESTAMPTZ;

CREATE INDEX user_achievements_recent_idx ON user_achievements (user_id, awarded_at DESC);

INSERT INTO achievements (code, title, description, criteria, family, category, tier, translations, icon, position)
VALUES
${catalogRows()}
ON CONFLICT (code) DO NOTHING;

CREATE TABLE group_ranking_snapshots (
    group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    board VARCHAR(16) NOT NULL CHECK (board IN ('performance', 'activity')),
    period_kind VARCHAR(8) NOT NULL CHECK (period_kind IN ('week', 'month')),
    period_start DATE NOT NULL,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    rank INTEGER CHECK (rank IS NULL OR rank > 0),
    score NUMERIC(10,2),
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, board, period_kind, period_start, user_id),
    CHECK ((rank IS NULL) = (score IS NULL))
);

CREATE INDEX group_ranking_snapshots_user_idx ON group_ranking_snapshots (user_id, period_kind, period_start);
   `)
}

export const down = pgm => {
   pgm.sql(`
DROP TABLE group_ranking_snapshots;

DELETE FROM user_achievements
WHERE achievement_id IN (SELECT id FROM achievements WHERE code IN (${codes}));
DELETE FROM achievements WHERE code IN (${codes});

DROP INDEX user_achievements_recent_idx;
ALTER TABLE user_achievements
    DROP COLUMN seen_at,
    DROP COLUMN metadata;

DROP INDEX achievements_family_tier_idx;
ALTER TABLE achievements
    DROP CONSTRAINT achievements_criteria_check,
    DROP CONSTRAINT achievements_translations_check,
    DROP CONSTRAINT achievements_tier_check,
    DROP CONSTRAINT achievements_category_check,
    DROP COLUMN position,
    DROP COLUMN icon,
    DROP COLUMN translations,
    DROP COLUMN tier,
    DROP COLUMN category,
    DROP COLUMN family;
   `)
}
