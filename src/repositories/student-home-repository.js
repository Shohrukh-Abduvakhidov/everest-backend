import pool from '../configs/db.js'
import { normalizeInternalId } from '../utils/internal-id.js'

// Reads for the student home page and the finished-attempt history. Own data only: every query
// is keyed by the caller's user id. Lesson access uses the same can_access_module predicate as
// the learner course list.

async function findProfileTimezone(userId, db = pool) {
   const result = await db.query(
      'SELECT timezone FROM user_profiles WHERE user_id = $1',
      [normalizeInternalId(userId)],
   )
   return result.rows[0]?.timezone ?? null
}

async function isValidTimeZone(name, db = pool) {
   const result = await db.query(
      'SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = $1) AS valid',
      [name],
   )
   return result.rows[0].valid
}

// The most recently touched unfinished lesson the learner can still open.
async function findContinueLesson(userId, db = pool) {
   const result = await db.query(
      `SELECT lesson.id AS lesson_id, lesson.module_id, lesson.course_id, lesson.title,
         course.title AS course_title, progress.playback_seconds, progress.updated_at,
         asset.duration_seconds
       FROM lesson_progress AS progress
       JOIN lessons AS lesson ON lesson.id = progress.lesson_id
       JOIN course_modules AS module ON module.id = lesson.module_id
       JOIN courses AS course ON course.id = lesson.course_id
       LEFT JOIN assets AS asset ON asset.id = lesson.video_asset_id
       WHERE progress.user_id = $1 AND progress.status = 'in_progress'
         AND lesson.status = 'published' AND module.status = 'published' AND course.status = 'published'
         AND can_access_module($1, module.id)
       ORDER BY progress.updated_at DESC, lesson.id DESC
       LIMIT 1`,
      [normalizeInternalId(userId)],
   )
   return result.rows[0] || null
}

async function listCourseActivity(userId, db = pool) {
   const result = await db.query(
      `SELECT lesson.course_id, max(progress.updated_at) AS last_activity_at
       FROM lesson_progress AS progress
       JOIN lessons AS lesson ON lesson.id = progress.lesson_id
       WHERE progress.user_id = $1
       GROUP BY lesson.course_id`,
      [normalizeInternalId(userId)],
   )
   return result.rows
}

const subjectOfAttempt = `CASE test.origin
      WHEN 'authored' THEN course.subject_id
      WHEN 'trainer' THEN (test.generation_filters ->> 'subjectId')::bigint
   END`

const attemptColumns = `attempt.id, attempt.test_id, attempt.assignment_id, attempt.attempt_number,
   attempt.status, attempt.started_at, attempt.submitted_at, attempt.score, attempt.max_score,
   attempt.policy_snapshot, test.origin, test.title, test.course_id, ${subjectOfAttempt} AS subject_id`

const attemptFrom = `FROM test_attempts AS attempt
   JOIN tests AS test ON test.id = attempt.test_id
   LEFT JOIN courses AS course ON course.id = test.course_id`

// Finished attempts only (graded, or closed by the timer). A mock exam has no single subject:
// a subject filter matches the exams that contain it.
const finishedSql = `attempt.user_id = $1 AND attempt.status IN ('graded', 'expired')
   AND attempt.max_score > 0
   AND ($2::text IS NULL OR test.origin = $2)
   AND ($3::bigint IS NULL OR ${subjectOfAttempt} = $3
      OR (test.origin = 'mock_exam' AND EXISTS (
         SELECT 1 FROM mock_exam_items AS item
         JOIN subjects AS subject ON subject.code = item.subject_code
         WHERE item.attempt_id = attempt.id AND subject.id = $3)))`

async function listFinishedAttempts(userId, { origin, subjectId, limit, offset }, db = pool) {
   const result = await db.query(
      `SELECT ${attemptColumns} ${attemptFrom}
       WHERE ${finishedSql}
       ORDER BY attempt.submitted_at DESC, attempt.id DESC
       LIMIT $4 OFFSET $5`,
      [normalizeInternalId(userId), origin ?? null, subjectId ?? null, limit, offset],
   )
   return result.rows
}

async function countFinishedAttempts(userId, { origin, subjectId }, db = pool) {
   const result = await db.query(
      `SELECT count(*)::integer AS total ${attemptFrom} WHERE ${finishedSql}`,
      [normalizeInternalId(userId), origin ?? null, subjectId ?? null],
   )
   return result.rows[0].total
}

async function findLatestFinishedMockExam(userId, db = pool) {
   const result = await db.query(
      `SELECT attempt.id, attempt.submitted_at, attempt.score, attempt.max_score
       FROM test_attempts AS attempt
       JOIN tests AS test ON test.id = attempt.test_id AND test.origin = 'mock_exam'
       WHERE attempt.user_id = $1 AND attempt.status IN ('graded', 'expired') AND attempt.max_score > 0
       ORDER BY attempt.submitted_at DESC, attempt.id DESC
       LIMIT 1`,
      [normalizeInternalId(userId)],
   )
   return result.rows[0] || null
}

// The last seven local days ending today in the learner's time zone. One row per local day and
// event code; a learner without events still gets one row that carries "today".
async function listWeekActivity(userId, now, timeZone, db = pool) {
   const result = await db.query(
      `WITH local AS (SELECT (($2::timestamptz AT TIME ZONE $3)::date) AS today)
       SELECT local.today::text AS today,
          (event.occurred_at AT TIME ZONE $3)::date::text AS day,
          event.event_code,
          count(event.id)::integer AS events,
          COALESCE(sum((event.metadata ->> 'seconds')::integer), 0)::integer AS seconds
       FROM local
       LEFT JOIN learning_activity_events AS event
         ON event.user_id = $1
          AND event.event_code IN ('watch_hour', 'lesson_completed', 'attempt_finished')
          AND event.occurred_at >= ((local.today - 6)::timestamp AT TIME ZONE $3)
          AND event.occurred_at <= $2
       GROUP BY local.today, 2, event.event_code`,
      [normalizeInternalId(userId), now, timeZone],
   )
   return result.rows
}

export {
   countFinishedAttempts,
   findContinueLesson,
   findLatestFinishedMockExam,
   findProfileTimezone,
   isValidTimeZone,
   listCourseActivity,
   listFinishedAttempts,
   listWeekActivity,
}
