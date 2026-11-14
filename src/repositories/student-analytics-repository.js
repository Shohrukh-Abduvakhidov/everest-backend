import pool from '../configs/db.js'
import { normalizeInternalId } from '../utils/internal-id.js'

// Own-data aggregates for GET /me/analytics. Classification and percentages are computed in
// src/utils/learning-metrics.js; these queries only sum.

// All-time totals. Watch time is the length of the merged watched_ranges (decision D6), so a
// rewatched interval counts once.
async function findLearningTotals(userId, db = pool) {
   const result = await db.query(
      `SELECT
         (SELECT COALESCE(round(sum((range ->> 1)::numeric - (range ->> 0)::numeric)), 0)::bigint
          FROM lesson_progress AS progress
          CROSS JOIN LATERAL jsonb_array_elements(progress.watched_ranges) AS range
          WHERE progress.user_id = $1) AS watch_seconds,
         (SELECT count(*)::integer FROM lesson_progress
          WHERE user_id = $1 AND status = 'completed') AS lessons_completed,
         (SELECT count(*)::integer FROM test_attempts
          WHERE user_id = $1 AND status IN ('graded', 'expired') AND max_score > 0) AS attempts_finished`,
      [normalizeInternalId(userId)],
   )
   return result.rows[0]
}

async function listFirstAttempts(userId, db = pool) {
   const result = await db.query(
      `SELECT attempt.status, attempt.score, attempt.max_score, attempt.policy_snapshot
       FROM test_attempts AS attempt
       JOIN tests AS test ON test.id = attempt.test_id
       WHERE attempt.user_id = $1 AND test.origin = 'authored' AND attempt.attempt_number = 1
         AND attempt.status IN ('graded', 'expired') AND attempt.max_score > 0`,
      [normalizeInternalId(userId)],
   )
   return result.rows
}

// Per topic over finished attempts of every origin submitted since $2: questions shown, points
// earned (an unanswered question earns 0) and points possible.
async function listTopicTotals(userId, since, db = pool) {
   const result = await db.query(
      `SELECT topic.id AS topic_id, topic.code, topic.subject_id, subject.code AS subject_code,
         (SELECT COALESCE(jsonb_object_agg(language_code, title), '{}')
          FROM topic_translations WHERE topic_id = topic.id) AS titles,
         count(*)::integer AS questions,
         sum(COALESCE(answer.awarded_points, 0))::numeric(14,2)::text AS points,
         sum(item.max_points)::numeric(14,2)::text AS max_points
       FROM test_attempts AS attempt
       JOIN attempt_questions AS item ON item.attempt_id = attempt.id
       LEFT JOIN student_answers AS answer ON answer.attempt_question_id = item.id
       JOIN question_topics AS link ON link.question_id = item.question_id
       JOIN topics AS topic ON topic.id = link.topic_id
       JOIN subjects AS subject ON subject.id = topic.subject_id
       WHERE attempt.user_id = $1 AND attempt.status IN ('graded', 'expired')
         AND attempt.max_score > 0 AND attempt.submitted_at >= $2
       GROUP BY topic.id, subject.code`,
      [normalizeInternalId(userId), since],
   )
   return result.rows
}

export { findLearningTotals, listFirstAttempts, listTopicTotals }
