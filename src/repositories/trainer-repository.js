import pool from '../configs/db.js'
import { normalizeInternalId } from '../utils/internal-id.js'
import { cellsKeyFilter, cellsKeyPattern } from './mock-exam-repository.js'

// A question is trainable when it is published, has a verified key and sits in an NCT bank
// (bank code starts with the configured prefix). $1 is always that prefix.
const trainableFrom = `FROM questions AS question
   JOIN question_banks AS bank ON bank.id = question.bank_id
   JOIN question_answer_keys AS answer_key
      ON answer_key.question_id = question.id AND answer_key.status = 'verified'
   WHERE question.status = 'published' AND starts_with(bank.code, $1)`

const subjectTitlesSql = `(SELECT COALESCE(jsonb_object_agg(language_code, title), '{}')
   FROM subject_translations WHERE subject_id = subject.id)`

// Counts per subject, language and stored difficulty (NULL kept; the service buckets them).
async function listTrainableCounts(bankCodePrefix, db = pool) {
   const result = await db.query(
      `SELECT question.subject_id, question.language_code, question.difficulty, count(*)::integer AS total
       ${trainableFrom}
       GROUP BY 1, 2, 3
       ORDER BY 1, 2, 3`,
      [bankCodePrefix],
   )
   return result.rows
}

// Subjects that have at least one trainable question: the subjects the trainer offers.
async function listTrainableSubjectIds(bankCodePrefix, db = pool) {
   const result = await db.query(
      `SELECT DISTINCT question.subject_id ${trainableFrom}`,
      [bankCodePrefix],
   )
   return result.rows.map((row) => row.subject_id)
}

// One row per section, question language and stored difficulty; the service adds them up, so
// counts per language and level are exact. Sections without trainable questions are absent.
async function listTrainableSections(bankCodePrefix, db = pool) {
   const result = await db.query(
      `SELECT section.subject_id, section.code,
         (SELECT COALESCE(jsonb_object_agg(language_code, title), '{}')
          FROM section_translations WHERE section_id = section.id) AS titles,
         question.language_code, question.difficulty,
         count(DISTINCT question.id)::integer AS total
       FROM sections AS section
       JOIN topics AS topic ON topic.section_id = section.id
       JOIN question_topics AS link ON link.topic_id = topic.id
       JOIN questions AS question ON question.id = link.question_id
       JOIN question_banks AS bank ON bank.id = question.bank_id
       JOIN question_answer_keys AS answer_key
          ON answer_key.question_id = question.id AND answer_key.status = 'verified'
       WHERE question.status = 'published' AND starts_with(bank.code, $1)
       GROUP BY section.id, question.language_code, question.difficulty
       ORDER BY section.subject_id, section.code, question.language_code, question.difficulty`,
      [bankCodePrefix],
   )
   return result.rows
}

async function listSubjects(subjectIds, db = pool) {
   const result = await db.query(
      `SELECT subject.id, subject.code, subject.color, subject.primary_language, ${subjectTitlesSql} AS titles
       FROM subjects AS subject WHERE subject.id = ANY($1::bigint[])
       ORDER BY subject.code`,
      [subjectIds.map(normalizeInternalId)],
   )
   return result.rows
}

async function findSubject({ id = null, code = null }, db = pool) {
   const result = await db.query(
      `SELECT subject.id, subject.code, subject.color, subject.primary_language, ${subjectTitlesSql} AS titles
       FROM subjects AS subject
       WHERE ($1::bigint IS NOT NULL AND subject.id = $1) OR ($2::text IS NOT NULL AND subject.code = $2)`,
      [id === null ? null : normalizeInternalId(id), code],
   )
   return result.rows[0] || null
}

async function findAccountStatus(userId, db = pool) {
   const result = await db.query('SELECT status FROM users WHERE id = $1', [normalizeInternalId(userId)])
   return result.rows[0]?.status ?? null
}

// Topics that hold trainable questions, with their section, for the "repeat a topic" choice. One
// row per topic, question language and stored difficulty, as for sections; a topic without
// trainable questions has no row and is never offered.
async function listTrainableTopics(bankCodePrefix, db = pool) {
   const result = await db.query(
      `SELECT topic.subject_id, topic.code,
         (SELECT code FROM sections WHERE id = topic.section_id) AS section_code,
         (SELECT COALESCE(jsonb_object_agg(language_code, title), '{}')
          FROM topic_translations WHERE topic_id = topic.id) AS titles,
         question.language_code, question.difficulty,
         count(DISTINCT question.id)::integer AS total
       FROM topics AS topic
       JOIN question_topics AS link ON link.topic_id = topic.id
       JOIN questions AS question ON question.id = link.question_id
       JOIN question_banks AS bank ON bank.id = question.bank_id
       JOIN question_answer_keys AS answer_key
          ON answer_key.question_id = question.id AND answer_key.status = 'verified'
       WHERE question.status = 'published' AND starts_with(bank.code, $1)
       GROUP BY topic.id, question.language_code, question.difficulty
       ORDER BY topic.subject_id, topic.code, question.language_code, question.difficulty`,
      [bankCodePrefix],
   )
   return result.rows
}

const finishedTrainerSql = `attempt.user_id = $1 AND attempt.status IN ('graded', 'expired')
   AND attempt.max_score > 0`

// The last `window` finished trainings of every subject, newest first, numbered per subject.
// total counts every finished training of the subject; repeat trainings (mode mistakes: questions
// the student got wrong; mode unanswered: questions an attempt left blank) stay out of the window,
// so they do not pull readiness down.
async function listRecentFinishedBySubject(userId, window, db = pool) {
   const result = await db.query(
      `SELECT subject_id, score, max_score, submitted_at, total
       FROM (
          SELECT (test.generation_filters ->> 'subjectId')::bigint AS subject_id,
             attempt.score, attempt.max_score, attempt.submitted_at,
             COALESCE(test.generation_filters ->> 'mode', 'standard') IN ('mistakes', 'unanswered') AS repeat_training,
             row_number() OVER subject_window AS position,
             count(*) OVER (PARTITION BY test.generation_filters ->> 'subjectId')::integer AS total
          ${trainerAttemptFrom}
          WHERE ${finishedTrainerSql}
          WINDOW subject_window AS (
             PARTITION BY test.generation_filters ->> 'subjectId',
                COALESCE(test.generation_filters ->> 'mode', 'standard') IN ('mistakes', 'unanswered')
             ORDER BY attempt.submitted_at DESC, attempt.id DESC
          )
       ) AS ranked
       WHERE NOT repeat_training AND position <= $2
       ORDER BY subject_id, submitted_at DESC`,
      [normalizeInternalId(userId), window],
   )
   return result.rows
}

// Per topic over every finished training: questions met and questions with full points.
// An unanswered question counts as wrong.
async function listTopicResults(userId, minAnswers, limit, db = pool) {
   const result = await db.query(
      `SELECT topic.subject_id, topic.code,
         (SELECT code FROM subjects WHERE id = topic.subject_id) AS subject_code,
         (SELECT COALESCE(jsonb_object_agg(language_code, title), '{}')
          FROM topic_translations WHERE topic_id = topic.id) AS titles,
         count(*)::integer AS answered,
         count(*) FILTER (
            WHERE COALESCE(answer.awarded_points, 0) >= item.max_points
         )::integer AS correct
       ${trainerAttemptFrom}
       JOIN attempt_questions AS item ON item.attempt_id = attempt.id
       LEFT JOIN student_answers AS answer ON answer.attempt_question_id = item.id
       JOIN question_topics AS link ON link.question_id = item.question_id
       JOIN topics AS topic ON topic.id = link.topic_id
       WHERE ${finishedTrainerSql}
       GROUP BY topic.id
       HAVING count(*) >= $2
          AND count(*) FILTER (WHERE COALESCE(answer.awarded_points, 0) >= item.max_points) < count(*)
       ORDER BY count(*) FILTER (WHERE COALESCE(answer.awarded_points, 0) >= item.max_points)::numeric
          / count(*), count(*) DESC, topic.id
       LIMIT $3`,
      [normalizeInternalId(userId), minAnswers, limit],
   )
   return result.rows
}

async function listRecentFinished(userId, limit, db = pool) {
   const result = await db.query(
      `SELECT ${trainerAttemptColumns} ${trainerAttemptFrom}
       WHERE ${finishedTrainerSql}
       ORDER BY attempt.submitted_at DESC, attempt.id DESC
       LIMIT $2`,
      [normalizeInternalId(userId), limit],
   )
   return result.rows
}

// One trainer generation per student at a time.
async function lockTrainerSlot(userId, client) {
   await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('trainer:' || $1::text, 0))`,
      [normalizeInternalId(userId)],
   )
}

const trainerAttemptColumns = `attempt.id, attempt.status, attempt.started_at, attempt.submitted_at,
   attempt.score, attempt.max_score, test.id AS test_id, test.generation_filters,
   (SELECT count(*)::integer FROM attempt_questions WHERE attempt_id = attempt.id) AS question_count`

const trainerAttemptFrom = `FROM test_attempts AS attempt
   JOIN tests AS test ON test.id = attempt.test_id AND test.origin = 'trainer'`

async function findTrainerAttemptByKey(userId, idempotencyKey, client) {
   const result = await client.query(
      `SELECT ${trainerAttemptColumns} ${trainerAttemptFrom}
       WHERE attempt.user_id = $1 AND test.created_by = $1
         AND test.generation_filters ->> 'idempotencyKey' = $2`,
      [normalizeInternalId(userId), idempotencyKey],
   )
   return result.rows[0] || null
}

// The student's own trainer attempt a mode "unanswered" training repeats; another student's
// attempt, a course test or a mock exam is not found.
async function findTrainerSourceAttempt(userId, attemptId, db = pool) {
   const result = await db.query(
      `SELECT attempt.id, attempt.status, test.generation_filters ${trainerAttemptFrom}
       WHERE attempt.id = $2 AND attempt.user_id = $1`,
      [normalizeInternalId(userId), normalizeInternalId(attemptId)],
   )
   return result.rows[0] || null
}

// Questions of an attempt that got no answer (no answer row, or answer_data null), in the
// attempt's order. Only questions still trainable (published, verified key, trainer bank).
async function listUnansweredQuestionIds(bankCodePrefix, attemptId, db = pool) {
   const result = await db.query(
      `SELECT item.question_id AS id
       FROM attempt_questions AS item
       LEFT JOIN student_answers AS answer ON answer.attempt_question_id = item.id
       JOIN questions AS question ON question.id = item.question_id AND question.status = 'published'
       JOIN question_banks AS bank ON bank.id = question.bank_id AND starts_with(bank.code, $1)
       JOIN question_answer_keys AS answer_key
          ON answer_key.question_id = question.id AND answer_key.status = 'verified'
       WHERE item.attempt_id = $2
         AND (answer.answer_data IS NULL OR answer.answer_data = 'null'::jsonb)
       ORDER BY item.position, item.id`,
      [bankCodePrefix, normalizeInternalId(attemptId)],
   )
   return result.rows.map((row) => String(row.id))
}

async function findOpenTrainerAttempt(userId, client) {
   const result = await client.query(
      `SELECT ${trainerAttemptColumns} ${trainerAttemptFrom}
       WHERE attempt.user_id = $1 AND attempt.status = 'in_progress'
       ORDER BY attempt.id LIMIT 1`,
      [normalizeInternalId(userId)],
   )
   return result.rows[0] || null
}

// An answer the student gave: answer_data present (an empty occurrence has none or JSON null).
const answeredSql = (alias) => `${alias}.answer_data IS NOT NULL AND ${alias}.answer_data <> 'null'::jsonb`

// Per question, the student's latest finished occurrence in a training or a mock exam in which they
// answered it (2026-11-22). Occurrences without an answer are skipped: they neither open nor close
// a mistake. Course tests and standalone tests are not a source: their reveal policy may hide which
// answers were wrong.
function latestAnsweredSql(userParam) {
   return `SELECT DISTINCT ON (item.question_id) item.question_id,
         COALESCE(attempt.submitted_at, attempt.graded_at) AS answered_at,
         COALESCE(answer.awarded_points, 0) AS awarded_points, item.max_points
      FROM test_attempts AS attempt
      JOIN tests AS test ON test.id = attempt.test_id AND test.origin IN ('trainer', 'mock_exam')
      JOIN attempt_questions AS item ON item.attempt_id = attempt.id
      JOIN student_answers AS answer ON answer.attempt_question_id = item.id AND ${answeredSql('answer')}
      WHERE attempt.user_id = ${userParam} AND attempt.status IN ('graded', 'expired')
      ORDER BY item.question_id, COALESCE(attempt.submitted_at, attempt.graded_at) DESC, attempt.id DESC`
}

// The student's open mistakes: the latest answered occurrence earned less than full points.
// answered_at orders them (freshest first); wrong = 0 points, otherwise partial credit.
function openMistakesSql(userParam) {
   return `SELECT latest.question_id, latest.answered_at, latest.awarded_points <= 0 AS wrong
      FROM (${latestAnsweredSql(userParam)}) AS latest
      WHERE latest.awarded_points < latest.max_points`
}

function mistakeQuestionIdsSql(userParam) {
   return `SELECT mistake.question_id FROM (${openMistakesSql(userParam)}) AS mistake`
}

// Filters of one request, seven parameters from start: subject; language (NULL = any); stored
// difficulties (NULL = any); section code; topic codes (a question in any of them); the user
// whose open mistakes the questions must be (NULL = no such limit); a source attempt whose
// answered questions below full points the questions must be (NULL = any attempt).
function candidateFilter(start) {
   return `AND question.subject_id = $${start}
      AND ($${start + 1}::text IS NULL OR question.language_code = $${start + 1})
      AND ($${start + 2}::smallint[] IS NULL OR question.difficulty = ANY($${start + 2}::smallint[]))
      AND ($${start + 3}::text IS NULL OR EXISTS (
         SELECT 1 FROM question_topics AS link JOIN topics AS topic ON topic.id = link.topic_id
         JOIN sections AS section ON section.id = topic.section_id
         WHERE link.question_id = question.id AND section.code = $${start + 3}))
      AND ($${start + 4}::text[] IS NULL OR EXISTS (
         SELECT 1 FROM question_topics AS link JOIN topics AS topic ON topic.id = link.topic_id
         WHERE link.question_id = question.id AND topic.code = ANY($${start + 4}::text[])))
      AND ($${start + 5}::bigint IS NULL OR question.id IN (${mistakeQuestionIdsSql(`$${start + 5}`)}))
      AND ($${start + 6}::bigint IS NULL OR EXISTS (
         SELECT 1 FROM attempt_questions AS source_item
         JOIN student_answers AS source_answer
            ON source_answer.attempt_question_id = source_item.id AND ${answeredSql('source_answer')}
         WHERE source_item.attempt_id = $${start + 6} AND source_item.question_id = question.id
            AND COALESCE(source_answer.awarded_points, 0) < source_item.max_points))`
}

function candidateParams(filters) {
   return [
      normalizeInternalId(filters.subjectId),
      filters.language ?? null,
      filters.difficulties ?? null,
      filters.sectionCode ?? null,
      filters.topicCodes?.length ? filters.topicCodes : null,
      filters.mistakesOf ? normalizeInternalId(filters.mistakesOf) : null,
      filters.mistakesFromAttempt ? normalizeInternalId(String(filters.mistakesFromAttempt)) : null,
   ]
}

// Count of trainable questions for one request, before any is picked. filters.excludeIds (the
// questions a test already holds, for the question generator) are not counted.
async function countCandidates(bankCodePrefix, filters, client = pool) {
   const result = await client.query(
      `SELECT count(*)::integer AS total ${trainableFrom} ${candidateFilter(2)}
         AND NOT (question.id = ANY($9::bigint[]))`,
      [bankCodePrefix, ...candidateParams(filters), (filters.excludeIds ?? []).map(normalizeInternalId)],
   )
   return result.rows[0].total
}

// Standard: random questions; ones this student has not met in an earlier trainer attempt come
// first. Mistakes (filters.mistakesOf): the freshest mistakes first (by their latest answered
// occurrence), wrong (0 points) before partial credit, random only among equals; whether a
// question was met in the trainer does not matter there.
async function pickCandidates(bankCodePrefix, filters, { userId, excludeIds, limit }, client) {
   const base = [bankCodePrefix, ...candidateParams(filters), excludeIds.map(normalizeInternalId)]
   const select = `SELECT question.id, question.difficulty ${trainableFrom} ${candidateFilter(2)}
         AND NOT (question.id = ANY($9::bigint[]))`
   const result = filters.mistakesOf
      ? await client.query(
         `WITH mistake AS MATERIALIZED (${openMistakesSql('$7')})
          ${select}
          ORDER BY (SELECT mistake.answered_at FROM mistake WHERE mistake.question_id = question.id) DESC NULLS LAST,
             (SELECT mistake.wrong FROM mistake WHERE mistake.question_id = question.id) DESC NULLS LAST,
             random()
          LIMIT $10`,
         [...base, limit],
      )
      : await client.query(
         `${select}
          ORDER BY EXISTS (
               SELECT 1 FROM attempt_questions AS seen
               JOIN test_attempts AS seen_attempt ON seen_attempt.id = seen.attempt_id
               JOIN tests AS seen_test ON seen_test.id = seen_attempt.test_id AND seen_test.origin = 'trainer'
               WHERE seen.question_id = question.id AND seen_attempt.user_id = $10
            ), random()
          LIMIT $11`,
         [...base, normalizeInternalId(userId), limit],
      )
   return result.rows
}

// Open mistakes among the trainable questions, per subject, per section and per topic. A question
// in two topics counts in both, so topic counts may add up to more than the subject count.
// level: 3 = subject row, 1 = section row, 0 = topic row (GROUPING bits of section and topic).
async function listMistakeCounts(userId, bankCodePrefix, db = pool) {
   const result = await db.query(
      `SELECT question.subject_id, section.code AS section_code, topic.code AS topic_code,
         GROUPING(section.code, topic.code)::integer AS level,
         count(DISTINCT question.id)::integer AS total
       FROM questions AS question
       JOIN question_banks AS bank ON bank.id = question.bank_id
       JOIN question_answer_keys AS answer_key
          ON answer_key.question_id = question.id AND answer_key.status = 'verified'
       LEFT JOIN question_topics AS link ON link.question_id = question.id
       LEFT JOIN topics AS topic ON topic.id = link.topic_id
       LEFT JOIN sections AS section ON section.id = topic.section_id
       WHERE question.status = 'published' AND starts_with(bank.code, $1)
         AND question.id IN (${mistakeQuestionIdsSql('$2')})
       GROUP BY GROUPING SETS (
          (question.subject_id),
          (question.subject_id, section.code),
          (question.subject_id, section.code, topic.code)
       )
       ORDER BY 1, 2, 3`,
      [bankCodePrefix, normalizeInternalId(userId)],
   )
   return result.rows
}

// No course: the trainer is its own module (tests_course_required_check allows it). A time limit
// is optional; without one the training has no deadline.
async function createTrainerTest(test, client) {
   const result = await client.query(
      `INSERT INTO tests (
         title, mode, origin, max_attempts, result_policy, answer_reveal_policy,
         shuffle_questions, shuffle_options, generation_filters, created_by, duration_seconds
       ) VALUES ($1, 'practice', 'trainer', 1, 'first', 'after_submission', FALSE, FALSE, $2, $3, $4)
       RETURNING id`,
      [
         test.title,
         test.generationFilters,
         normalizeInternalId(test.createdBy),
         test.durationSeconds ?? null,
      ],
   )
   return result.rows[0].id
}

// points: optional array aligned with questionIds; a missing entry is 1 point.
async function addTrainerQuestions(testId, questionIds, client, points = []) {
   await client.query(
      `INSERT INTO test_questions (test_id, question_id, position, points)
       SELECT $1, added.question_id, added.position, COALESCE(added.points, 1)
       FROM unnest($2::bigint[], $3::numeric[]) WITH ORDINALITY AS added(question_id, points, position)`,
      [
         normalizeInternalId(testId),
         questionIds.map(normalizeInternalId),
         questionIds.map((id, index) => points[index] ?? null),
      ],
   )
}

// The cells rule of the mock exam for one subject: the answer-sheet cells item of an active
// blueprint (max digits and points). No such item means the subject has no cells questions.
async function findCellsRule(subjectCode, client) {
   const result = await client.query(
      `SELECT item.max_digits, item.points::text AS points
       FROM exam_blueprint_items AS item
       JOIN exam_blueprint_sections AS section ON section.id = item.section_id
       JOIN exam_blueprints AS blueprint ON blueprint.id = section.blueprint_id
       WHERE blueprint.status = 'active' AND section.subject_code = $1 AND item.item_kind = 'cells'
       ORDER BY blueprint.code, item.first_position
       LIMIT 1`,
      [subjectCode],
   )
   return result.rows[0] || null
}

// Of the picked questions, those whose verified key fits the cells filter of the mock exam.
async function listCellsQuestions(questionIds, maxDigits, client) {
   const result = await client.query(
      `SELECT question.id, question.question_type, answer_key.answer_data
       FROM questions AS question
       JOIN question_answer_keys AS answer_key
          ON answer_key.question_id = question.id AND answer_key.status = 'verified'
       WHERE question.id = ANY($1::bigint[]) ${cellsKeyFilter(2)}`,
      [questionIds.map(normalizeInternalId), cellsKeyPattern(maxDigits)],
   )
   return result.rows
}

// guard_test() re-checks that every question is published.
async function publishTrainerTest(testId, client) {
   await client.query(
      `UPDATE tests SET status = 'published', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND origin = 'trainer'`,
      [normalizeInternalId(testId)],
   )
}

async function createTrainerAssignment(testId, userId, opensAt, client) {
   const result = await client.query(
      `INSERT INTO test_assignments (test_id, user_id, assigned_by, opens_at)
       VALUES ($1, $2, $2, $3)
       RETURNING id`,
      [normalizeInternalId(testId), normalizeInternalId(userId), opensAt],
   )
   return result.rows[0].id
}

async function listTrainerAttempts(userId, filters, db = pool) {
   const result = await db.query(
      `SELECT ${trainerAttemptColumns},
         (SELECT COALESCE(jsonb_object_agg(language_code, title), '{}') FROM subject_translations
          WHERE subject_id = (test.generation_filters ->> 'subjectId')::bigint) AS subject_titles
       ${trainerAttemptFrom}
       WHERE attempt.user_id = $1
         AND ($2::bigint IS NULL OR (test.generation_filters ->> 'subjectId')::bigint = $2)
       ORDER BY attempt.id DESC
       LIMIT $3 OFFSET $4`,
      [normalizeInternalId(userId), filters.subjectId, filters.limit + 1, filters.offset],
   )
   return result.rows
}

// Finished attempts only; percent is computed per attempt and then averaged.
async function listTrainerStats(userId, db = pool) {
   const result = await db.query(
      `SELECT (test.generation_filters ->> 'subjectId')::bigint AS subject_id,
         count(*)::integer AS attempts,
         round(avg(attempt.score * 100 / attempt.max_score), 2)::text AS average_percent,
         max(attempt.submitted_at) AS last_submitted_at
       ${trainerAttemptFrom}
       WHERE attempt.user_id = $1 AND attempt.status IN ('graded', 'expired') AND attempt.max_score > 0
       GROUP BY 1
       ORDER BY 1`,
      [normalizeInternalId(userId)],
   )
   return result.rows
}

export {
   addTrainerQuestions,
   findCellsRule,
   listCellsQuestions,
   countCandidates,
   createTrainerAssignment,
   createTrainerTest,
   findAccountStatus,
   findOpenTrainerAttempt,
   findSubject,
   findTrainerAttemptByKey,
   findTrainerSourceAttempt,
   listSubjects,
   listTrainableCounts,
   listTrainableSections,
   listTrainableSubjectIds,
   listMistakeCounts,
   listTrainerAttempts,
   listRecentFinished,
   listRecentFinishedBySubject,
   listTopicResults,
   listTrainableTopics,
   listTrainerStats,
   listUnansweredQuestionIds,
   lockTrainerSlot,
   pickCandidates,
   publishTrainerTest,
}
