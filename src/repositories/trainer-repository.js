import pool from '../configs/db.js'
import { normalizeInternalId } from '../utils/internal-id.js'

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

async function listTrainableSections(bankCodePrefix, db = pool) {
   const result = await db.query(
      `SELECT section.subject_id, section.code,
         (SELECT COALESCE(jsonb_object_agg(language_code, title), '{}')
          FROM section_translations WHERE section_id = section.id) AS titles,
         count(DISTINCT question.id)::integer AS total
       FROM sections AS section
       JOIN topics AS topic ON topic.section_id = section.id
       JOIN question_topics AS link ON link.topic_id = topic.id
       JOIN questions AS question ON question.id = link.question_id
       JOIN question_banks AS bank ON bank.id = question.bank_id
       JOIN question_answer_keys AS answer_key
          ON answer_key.question_id = question.id AND answer_key.status = 'verified'
       WHERE question.status = 'published' AND starts_with(bank.code, $1)
       GROUP BY section.id
       ORDER BY section.subject_id, section.code`,
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

// Topics that hold trainable questions, with their section, for the "repeat a topic" choice.
async function listTrainableTopics(bankCodePrefix, db = pool) {
   const result = await db.query(
      `SELECT topic.subject_id, topic.code,
         (SELECT code FROM sections WHERE id = topic.section_id) AS section_code,
         (SELECT COALESCE(jsonb_object_agg(language_code, title), '{}')
          FROM topic_translations WHERE topic_id = topic.id) AS titles,
         count(DISTINCT question.id)::integer AS total
       FROM topics AS topic
       JOIN question_topics AS link ON link.topic_id = topic.id
       JOIN questions AS question ON question.id = link.question_id
       JOIN question_banks AS bank ON bank.id = question.bank_id
       JOIN question_answer_keys AS answer_key
          ON answer_key.question_id = question.id AND answer_key.status = 'verified'
       WHERE question.status = 'published' AND starts_with(bank.code, $1)
       GROUP BY topic.id
       ORDER BY topic.subject_id, topic.code`,
      [bankCodePrefix],
   )
   return result.rows
}

const finishedTrainerSql = `attempt.user_id = $1 AND attempt.status IN ('graded', 'expired')
   AND attempt.max_score > 0`

// The last `window` finished trainings of every subject, newest first, numbered per subject.
async function listRecentFinishedBySubject(userId, window, db = pool) {
   const result = await db.query(
      `SELECT subject_id, score, max_score, submitted_at, total
       FROM (
          SELECT (test.generation_filters ->> 'subjectId')::bigint AS subject_id,
             attempt.score, attempt.max_score, attempt.submitted_at,
             row_number() OVER subject_window AS position,
             count(*) OVER (PARTITION BY test.generation_filters ->> 'subjectId')::integer AS total
          ${trainerAttemptFrom}
          WHERE ${finishedTrainerSql}
          WINDOW subject_window AS (
             PARTITION BY test.generation_filters ->> 'subjectId'
             ORDER BY attempt.submitted_at DESC, attempt.id DESC
          )
       ) AS ranked
       WHERE position <= $2
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

async function findOpenTrainerAttempt(userId, client) {
   const result = await client.query(
      `SELECT ${trainerAttemptColumns} ${trainerAttemptFrom}
       WHERE attempt.user_id = $1 AND attempt.status = 'in_progress'
       ORDER BY attempt.id LIMIT 1`,
      [normalizeInternalId(userId)],
   )
   return result.rows[0] || null
}

// Count of trainable questions for one request, before any is picked.
function candidateFilter(start) {
   return `AND question.subject_id = $${start} AND question.language_code = $${start + 1}
      AND ($${start + 2}::smallint[] IS NULL OR question.difficulty = ANY($${start + 2}::smallint[]))
      AND ($${start + 3}::text IS NULL OR EXISTS (
         SELECT 1 FROM question_topics AS link JOIN topics AS topic ON topic.id = link.topic_id
         JOIN sections AS section ON section.id = topic.section_id
         WHERE link.question_id = question.id AND section.code = $${start + 3}))
      AND ($${start + 4}::text IS NULL OR EXISTS (
         SELECT 1 FROM question_topics AS link JOIN topics AS topic ON topic.id = link.topic_id
         WHERE link.question_id = question.id AND topic.code = $${start + 4}))`
}

function candidateParams(filters) {
   return [
      normalizeInternalId(filters.subjectId),
      filters.language,
      filters.difficulties,
      filters.sectionCode,
      filters.topicCode,
   ]
}

async function countCandidates(bankCodePrefix, filters, client) {
   const result = await client.query(
      `SELECT count(*)::integer AS total ${trainableFrom} ${candidateFilter(2)}`,
      [bankCodePrefix, ...candidateParams(filters)],
   )
   return result.rows[0].total
}

// Random questions; ones this student has not met in an earlier trainer attempt come first.
async function pickCandidates(bankCodePrefix, filters, { userId, excludeIds, limit }, client) {
   const result = await client.query(
      `SELECT question.id, question.difficulty ${trainableFrom} ${candidateFilter(2)}
         AND NOT (question.id = ANY($7::bigint[]))
       ORDER BY EXISTS (
            SELECT 1 FROM attempt_questions AS seen
            JOIN test_attempts AS seen_attempt ON seen_attempt.id = seen.attempt_id
            JOIN tests AS seen_test ON seen_test.id = seen_attempt.test_id AND seen_test.origin = 'trainer'
            WHERE seen.question_id = question.id AND seen_attempt.user_id = $8
         ), random()
       LIMIT $9`,
      [
         bankCodePrefix,
         ...candidateParams(filters),
         excludeIds.map(normalizeInternalId),
         normalizeInternalId(userId),
         limit,
      ],
   )
   return result.rows
}

// No course: the trainer is its own module (tests_course_required_check allows it).
async function createTrainerTest(test, client) {
   const result = await client.query(
      `INSERT INTO tests (
         title, mode, origin, max_attempts, result_policy, answer_reveal_policy,
         shuffle_questions, shuffle_options, generation_filters, created_by
       ) VALUES ($1, 'practice', 'trainer', 1, 'first', 'after_submission', FALSE, FALSE, $2, $3)
       RETURNING id`,
      [
         test.title,
         test.generationFilters,
         normalizeInternalId(test.createdBy),
      ],
   )
   return result.rows[0].id
}

async function addTrainerQuestions(testId, questionIds, client) {
   await client.query(
      `INSERT INTO test_questions (test_id, question_id, position, points)
       SELECT $1, added.question_id, added.position, 1
       FROM unnest($2::bigint[]) WITH ORDINALITY AS added(question_id, position)`,
      [normalizeInternalId(testId), questionIds.map(normalizeInternalId)],
   )
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
      `SELECT ${trainerAttemptColumns} ${trainerAttemptFrom}
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
   countCandidates,
   createTrainerAssignment,
   createTrainerTest,
   findAccountStatus,
   findOpenTrainerAttempt,
   findSubject,
   findTrainerAttemptByKey,
   listSubjects,
   listTrainableCounts,
   listTrainableSections,
   listTrainerAttempts,
   listRecentFinished,
   listRecentFinishedBySubject,
   listTopicResults,
   listTrainableTopics,
   listTrainerStats,
   lockTrainerSlot,
   pickCandidates,
   publishTrainerTest,
}
