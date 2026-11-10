import pool from '../configs/db.js'
import { normalizeInternalId } from '../utils/internal-id.js'

// ---------------------------------------------------------------- blueprints

const blueprintColumns = `blueprint.id, blueprint.code, blueprint.titles, blueprint.language_code,
   blueprint.bank_code_prefix, blueprint.duration_minutes,
   (SELECT COALESCE(jsonb_agg(jsonb_build_object(
         'position', section.position,
         'subjectCode', section.subject_code,
         'items', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'firstPosition', item.first_position,
               'lastPosition', item.last_position,
               'kind', item.item_kind,
               'points', item.points::text,
               'scoring', item.scoring,
               'optionCount', item.option_count,
               'leftCount', item.left_count,
               'rightCount', item.right_count,
               'maxDigits', item.max_digits,
               'difficultyMin', item.difficulty_min,
               'difficultyMax', item.difficulty_max,
               'difficultyOrder', item.difficulty_order
            ) ORDER BY item.first_position), '[]')
            FROM exam_blueprint_items AS item WHERE item.section_id = section.id)
      ) ORDER BY section.position), '[]')
    FROM exam_blueprint_sections AS section WHERE section.blueprint_id = blueprint.id) AS sections`

async function listActiveBlueprints(db = pool) {
   const result = await db.query(
      `SELECT ${blueprintColumns} FROM exam_blueprints AS blueprint
       WHERE blueprint.status = 'active'
       ORDER BY blueprint.code`,
   )
   return result.rows
}

async function findActiveBlueprint(code, db = pool) {
   const result = await db.query(
      `SELECT ${blueprintColumns} FROM exam_blueprints AS blueprint
       WHERE blueprint.status = 'active' AND blueprint.code = $1`,
      [code],
   )
   return result.rows[0] || null
}

async function listSubjectsByCodes(codes, db = pool) {
   const result = await db.query(
      `SELECT subject.id, subject.code, subject.color,
         (SELECT COALESCE(jsonb_object_agg(language_code, title), '{}')
          FROM subject_translations WHERE subject_id = subject.id) AS titles
       FROM subjects AS subject WHERE subject.code = ANY($1::text[])`,
      [codes],
   )
   return result.rows
}

// ---------------------------------------------------------------- candidates

// A candidate is published, has a verified key and sits in a bank of the blueprint's prefix, in
// the section's subject and the blueprint's language. $1..$5 are always prefix, subject,
// language and the optional difficulty bounds.
const candidateFrom = `FROM questions AS question
   JOIN question_banks AS bank ON bank.id = question.bank_id
   JOIN question_answer_keys AS answer_key
      ON answer_key.question_id = question.id AND answer_key.status = 'verified'
   WHERE question.status = 'published' AND starts_with(bank.code, $1)
      AND question.subject_id = $2 AND question.language_code = $3
      AND ($4::smallint IS NULL OR question.difficulty >= $4)
      AND ($5::smallint IS NULL OR question.difficulty <= $5)`

// The form each kind requires; the kind is checked against this allowlist, values are bound.
function kindFilter(spec, start) {
   if (spec.kind === 'single') {
      return {
         sql: `AND question.question_type = 'single_choice'
            AND (SELECT count(*) FROM question_options WHERE question_id = question.id) = $${start}::integer
            AND jsonb_typeof(answer_key.answer_data -> 'optionKey') = 'string'`,
         params: [spec.optionCount],
      }
   }
   if (spec.kind === 'matching') {
      return {
         sql: `AND question.question_type = 'matching'
            AND (SELECT count(*) FROM question_matching_items
               WHERE question_id = question.id AND side = 'left') = $${start}::integer
            AND (SELECT count(*) FROM question_matching_items
               WHERE question_id = question.id AND side = 'right') = $${start + 1}::integer
            AND jsonb_typeof(answer_key.answer_data -> 'pairs') = 'array'
            AND jsonb_array_length(answer_key.answer_data -> 'pairs') = $${start}::integer`,
         params: [spec.leftCount, spec.rightCount],
      }
   }
   if (spec.kind === 'cells') {
      // A whole non-negative number of 1..maxDigits digits; short_text answers may contain
      // spaces, which are removed first, and every accepted answer must qualify.
      return {
         sql: `AND (
            (question.question_type = 'numeric'
               AND jsonb_typeof(answer_key.answer_data -> 'value') = 'number'
               AND (answer_key.answer_data ->> 'value') ~ $${start}::text)
            OR (question.question_type = 'short_text'
               AND jsonb_typeof(answer_key.answer_data -> 'acceptedAnswers') = 'array'
               AND jsonb_array_length(answer_key.answer_data -> 'acceptedAnswers') > 0
               AND NOT EXISTS (
                  SELECT 1 FROM jsonb_array_elements(answer_key.answer_data -> 'acceptedAnswers') AS accepted(value)
                  WHERE jsonb_typeof(accepted.value) <> 'string'
                     OR regexp_replace(accepted.value #>> '{}', '\\s', '', 'g') !~ $${start}::text
               ))
         )`,
         params: [`^[0-9]{1,${Number(spec.maxDigits)}}$`],
      }
   }
   throw new Error('Unknown mock exam item kind')
}

function baseParams(bankCodePrefix, spec) {
   return [
      bankCodePrefix,
      normalizeInternalId(spec.subjectId),
      spec.language,
      spec.difficultyMin ?? null,
      spec.difficultyMax ?? null,
   ]
}

async function countCandidates(bankCodePrefix, spec, db = pool) {
   const filter = kindFilter(spec, 6)
   const result = await db.query(
      `SELECT count(*)::integer AS total ${candidateFrom} ${filter.sql}`,
      [...baseParams(bankCodePrefix, spec), ...filter.params],
   )
   return result.rows[0].total
}

// Random candidates; ones this user has not met in an earlier mock exam come first.
async function pickCandidates(bankCodePrefix, spec, { userId, excludeIds, limit }, client) {
   const filter = kindFilter(spec, 6)
   const next = 6 + filter.params.length
   const result = await client.query(
      `SELECT question.id, question.difficulty, question.question_type, answer_key.answer_data
       ${candidateFrom} ${filter.sql}
         AND NOT (question.id = ANY($${next}::bigint[]))
       ORDER BY EXISTS (
            SELECT 1 FROM attempt_questions AS seen
            JOIN test_attempts AS seen_attempt ON seen_attempt.id = seen.attempt_id
            JOIN tests AS seen_test ON seen_test.id = seen_attempt.test_id AND seen_test.origin = 'mock_exam'
            WHERE seen.question_id = question.id AND seen_attempt.user_id = $${next + 1}
         ), random()
       LIMIT $${next + 2}`,
      [
         ...baseParams(bankCodePrefix, spec),
         ...filter.params,
         excludeIds.map(normalizeInternalId),
         normalizeInternalId(userId),
         limit,
      ],
   )
   return result.rows
}

// ---------------------------------------------------------------- generation

// One mock exam generation per user at a time.
async function lockMockExamSlot(userId, client) {
   await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('mock-exam:' || $1::text, 0))`,
      [normalizeInternalId(userId)],
   )
}

const mockAttemptColumns = `attempt.id, attempt.status, attempt.started_at, attempt.expires_at,
   attempt.submitted_at, attempt.score, attempt.max_score, test.id AS test_id, test.generation_filters`

const mockAttemptFrom = `FROM test_attempts AS attempt
   JOIN tests AS test ON test.id = attempt.test_id AND test.origin = 'mock_exam'`

async function findMockAttemptByKey(userId, idempotencyKey, client) {
   const result = await client.query(
      `SELECT ${mockAttemptColumns} ${mockAttemptFrom}
       WHERE attempt.user_id = $1 AND test.created_by = $1
         AND test.generation_filters ->> 'idempotencyKey' = $2`,
      [normalizeInternalId(userId), idempotencyKey],
   )
   return result.rows[0] || null
}

async function findOpenMockAttempt(userId, db = pool) {
   const result = await db.query(
      `SELECT ${mockAttemptColumns} ${mockAttemptFrom}
       WHERE attempt.user_id = $1 AND attempt.status = 'in_progress'
       ORDER BY attempt.id LIMIT 1`,
      [normalizeInternalId(userId)],
   )
   return result.rows[0] || null
}

// No course (tests_course_required_check allows it). mode 'nct' requires the duration.
async function createMockExamTest(test, client) {
   const result = await client.query(
      `INSERT INTO tests (
         title, mode, origin, duration_seconds, max_attempts, result_policy, answer_reveal_policy,
         shuffle_questions, shuffle_options, generation_filters, created_by
       ) VALUES ($1, 'nct', 'mock_exam', $2, 1, 'first', 'after_submission', FALSE, FALSE, $3, $4)
       RETURNING id`,
      [test.title, test.durationSeconds, test.generationFilters, normalizeInternalId(test.createdBy)],
   )
   return result.rows[0].id
}

async function addMockExamQuestions(testId, questions, client) {
   await client.query(
      `INSERT INTO test_questions (test_id, question_id, position, points)
       SELECT $1, row.question_id, row.position, row.points
       FROM jsonb_to_recordset($2::jsonb) AS row(question_id BIGINT, position INTEGER, points NUMERIC)`,
      [normalizeInternalId(testId), JSON.stringify(questions)],
   )
}

// guard_test() re-checks that every question is published.
async function publishMockExamTest(testId, client) {
   await client.query(
      `UPDATE tests SET status = 'published', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND origin = 'mock_exam'`,
      [normalizeInternalId(testId)],
   )
}

async function createMockExamAssignment(testId, userId, opensAt, client) {
   const result = await client.query(
      `INSERT INTO test_assignments (test_id, user_id, assigned_by, opens_at)
       VALUES ($1, $2, $2, $3)
       RETURNING id`,
      [normalizeInternalId(testId), normalizeInternalId(userId), opensAt],
   )
   return result.rows[0].id
}

// Questions are never shuffled in a mock exam, so attempt positions equal test positions.
async function addMockExamItems(attemptId, items, client) {
   const result = await client.query(
      `INSERT INTO mock_exam_items
         (attempt_question_id, attempt_id, section_position, subject_code, sheet_number, item_kind)
       SELECT item.id, item.attempt_id, row.section_position, row.subject_code, row.sheet_number, row.item_kind
       FROM jsonb_to_recordset($2::jsonb) AS row(
          position INTEGER, section_position SMALLINT, subject_code TEXT, sheet_number SMALLINT, item_kind TEXT
       )
       JOIN attempt_questions AS item ON item.attempt_id = $1 AND item.position = row.position`,
      [normalizeInternalId(attemptId), JSON.stringify(items)],
   )
   return result.rowCount
}

// ---------------------------------------------------------------- attempts

async function findMockAttempt(userId, attemptId, db = pool) {
   const result = await db.query(
      `SELECT ${mockAttemptColumns} ${mockAttemptFrom}
       WHERE attempt.user_id = $1 AND attempt.id = $2`,
      [normalizeInternalId(userId), normalizeInternalId(attemptId)],
   )
   return result.rows[0] || null
}

async function listMockExamItems(attemptId, db = pool) {
   const result = await db.query(
      `SELECT item.attempt_question_id, item.section_position, item.subject_code, item.sheet_number,
         item.item_kind, item.flagged, item.flagged_at, question.position
       FROM mock_exam_items AS item
       JOIN attempt_questions AS question ON question.id = item.attempt_question_id
       WHERE item.attempt_id = $1
       ORDER BY question.position`,
      [normalizeInternalId(attemptId)],
   )
   return result.rows
}

async function setMockExamItemFlag(attemptId, attemptQuestionId, flagged, at, client) {
   const result = await client.query(
      `UPDATE mock_exam_items
       SET flagged = $3, flagged_at = CASE WHEN $3 THEN $4::timestamptz END
       WHERE attempt_id = $1 AND attempt_question_id = $2
       RETURNING attempt_question_id, flagged, flagged_at`,
      [normalizeInternalId(attemptId), normalizeInternalId(attemptQuestionId), flagged, at],
   )
   return result.rows[0] || null
}

// Finished exams, newest first, with points per section (grading writes a row for every
// question, so the sum covers the whole section).
async function listFinishedMockAttempts(userId, { limit, offset }, db = pool) {
   const result = await db.query(
      `SELECT ${mockAttemptColumns},
         (SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'sectionPosition', scores.section_position, 'score', scores.score::text
            ) ORDER BY scores.section_position), '[]')
          FROM (
             SELECT item.section_position, COALESCE(sum(answer.awarded_points), 0)::numeric(12,2) AS score
             FROM mock_exam_items AS item
             LEFT JOIN student_answers AS answer ON answer.attempt_question_id = item.attempt_question_id
             WHERE item.attempt_id = attempt.id
             GROUP BY item.section_position
          ) AS scores) AS section_scores
       ${mockAttemptFrom}
       WHERE attempt.user_id = $1 AND attempt.status IN ('graded', 'expired')
       ORDER BY attempt.submitted_at DESC, attempt.id DESC
       LIMIT $2 OFFSET $3`,
      [normalizeInternalId(userId), limit + 1, offset],
   )
   return result.rows
}

export {
   addMockExamItems,
   addMockExamQuestions,
   countCandidates,
   createMockExamAssignment,
   createMockExamTest,
   findActiveBlueprint,
   findMockAttempt,
   findMockAttemptByKey,
   findOpenMockAttempt,
   listActiveBlueprints,
   listFinishedMockAttempts,
   listMockExamItems,
   listSubjectsByCodes,
   lockMockExamSlot,
   pickCandidates,
   publishMockExamTest,
   setMockExamItemFlag,
}
