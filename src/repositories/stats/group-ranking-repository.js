import pool from '../../configs/db.js'
import { normalizeInternalId } from '../../utils/internal-id.js'

// M13 group ranking. The raw facts of one group come from ONE statement (rows tagged by kind);
// scores and places are computed in src/utils/ranking-metrics.js. Origins are filtered
// explicitly (decision of 2026-11-12): group assignments count only authored and standalone
// tests, the trainer only origin 'trainer', the mock exam only 'mock_exam'.

const finishedAtSql = `COALESCE(attempt.submitted_at, attempt.graded_at, attempt.expires_at)`
const finishedSql = `attempt.status IN ('graded', 'expired')`

// The group as an active member sees it: missing, or not their group, is the same null.
async function findMemberGroup(userId, groupId, db = pool) {
   const result = await db.query(
      `SELECT grp.id, grp.status
       FROM groups AS grp
       JOIN group_members AS member ON member.group_id = grp.id
          AND member.user_id = $1 AND member.status = 'active'
       WHERE grp.id = $2`,
      [normalizeInternalId(userId), normalizeInternalId(groupId)],
   )
   return result.rows[0] || null
}

async function findRankingSettings(groupId, db = pool) {
   const result = await db.query(
      `SELECT group_id, visibility, updated_by, updated_at
       FROM group_ranking_settings WHERE group_id = $1`,
      [normalizeInternalId(groupId)],
   )
   return result.rows[0] || null
}

async function saveRankingSettings({ groupId, visibility, actorId }, client) {
   const result = await client.query(
      `INSERT INTO group_ranking_settings (group_id, visibility, updated_by, updated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (group_id) DO UPDATE SET
          visibility = EXCLUDED.visibility,
          updated_by = EXCLUDED.updated_by,
          updated_at = EXCLUDED.updated_at
       RETURNING group_id, visibility, updated_by, updated_at`,
      [normalizeInternalId(groupId), visibility, normalizeInternalId(actorId)],
   )
   return result.rows[0]
}

// Rows of kind:
//   member      every active member with an active account: joined_at and the name
//   assignment  per member and counted group assignment (not revoked, closes_at null or not
//               before $2): result policy, closes_at, eligibility (standalone, or a non-revoked
//               enrollment in the course) and the member's finished attempts
//   trainer     (activity only) every finished trainer attempt of a member, ever: time spent,
//               questions, answered, and the questions solved with full marks with difficulty.
//               All time is needed to know which solve was the first one.
//   mock_exam   (activity only) finished mock exams inside [$2, $3)
//   lesson      (activity only) first completions inside [$2, $3)
// $2/$3 are the period bounds (null for no bound).
async function listRankingFacts(groupId, { board, start, end }, db = pool) {
   const activity = board === 'activity'
   const activitySql = activity
      ? `
       UNION ALL
       SELECT 'trainer', attempt.user_id, jsonb_build_object(
          'attemptId', attempt.id::text,
          'at', ${finishedAtSql},
          'seconds', GREATEST(0, EXTRACT(EPOCH FROM (${finishedAtSql} - attempt.started_at)) - attempt.paused_seconds),
          'questions', (SELECT count(*) FROM attempt_questions AS item WHERE item.attempt_id = attempt.id),
          'answered', (
             SELECT count(*) FROM attempt_questions AS item
             JOIN student_answers AS answer ON answer.attempt_question_id = item.id
             WHERE item.attempt_id = attempt.id AND answer.answer_data IS NOT NULL
          ),
          'solved', COALESCE((
             SELECT jsonb_agg(jsonb_build_object('questionId', item.question_id::text, 'difficulty', question.difficulty))
             FROM attempt_questions AS item
             JOIN student_answers AS answer ON answer.attempt_question_id = item.id
             JOIN questions AS question ON question.id = item.question_id
             WHERE item.attempt_id = attempt.id AND answer.awarded_points >= item.max_points
          ), '[]'::jsonb)
       )
       FROM test_attempts AS attempt
       JOIN members ON members.user_id = attempt.user_id
       JOIN tests AS test ON test.id = attempt.test_id AND test.origin = 'trainer'
       WHERE ${finishedSql}
       UNION ALL
       SELECT 'mock_exam', attempt.user_id, jsonb_build_object('at', ${finishedAtSql}, 'score', attempt.score)
       FROM test_attempts AS attempt
       JOIN members ON members.user_id = attempt.user_id
       JOIN tests AS test ON test.id = attempt.test_id AND test.origin = 'mock_exam'
       WHERE ${finishedSql}
         AND ($2::timestamptz IS NULL OR ${finishedAtSql} >= $2)
         AND ($3::timestamptz IS NULL OR ${finishedAtSql} < $3)
       UNION ALL
       SELECT 'lesson', progress.user_id, jsonb_build_object('at', progress.completed_at)
       FROM lesson_progress AS progress
       JOIN members ON members.user_id = progress.user_id
       WHERE progress.status = 'completed' AND progress.completed_at IS NOT NULL
         AND ($2::timestamptz IS NULL OR progress.completed_at >= $2)
         AND ($3::timestamptz IS NULL OR progress.completed_at < $3)`
      : ''
   const result = await db.query(
      `WITH members AS MATERIALIZED (
          SELECT member.user_id, member.joined_at, profile.first_name, profile.last_name
          FROM group_members AS member
          JOIN users AS account ON account.id = member.user_id AND account.status = 'active'
          LEFT JOIN user_profiles AS profile ON profile.user_id = member.user_id
          WHERE member.group_id = $1 AND member.status = 'active'
       ), assignments AS MATERIALIZED (
          SELECT assignment.id, assignment.closes_at, test.result_policy, test.origin, test.course_id
          FROM test_assignments AS assignment
          JOIN tests AS test ON test.id = assignment.test_id AND test.origin IN ('authored', 'standalone')
          WHERE assignment.group_id = $1 AND assignment.counts_for_group_ranking
            AND assignment.status <> 'revoked'
            AND ($2::timestamptz IS NULL OR assignment.closes_at IS NULL OR assignment.closes_at >= $2)
       )
       SELECT 'member' AS kind, members.user_id, jsonb_build_object(
          'joinedAt', members.joined_at, 'firstName', members.first_name, 'lastName', members.last_name
       ) AS data
       FROM members
       UNION ALL
       SELECT 'assignment', members.user_id, jsonb_build_object(
          'assignmentId', assignments.id::text,
          'closesAt', assignments.closes_at,
          'resultPolicy', assignments.result_policy,
          'eligible', assignments.origin = 'standalone' OR EXISTS (
             SELECT 1 FROM course_enrollments AS enrollment
             WHERE enrollment.user_id = members.user_id AND enrollment.course_id = assignments.course_id
               AND enrollment.revoked_at IS NULL
          ),
          'attempts', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                'attempt_number', attempt.attempt_number, 'status', attempt.status,
                'score', attempt.score, 'max_score', attempt.max_score, 'finished_at', ${finishedAtSql}
             ))
             FROM test_attempts AS attempt
             WHERE attempt.assignment_id = assignments.id AND attempt.user_id = members.user_id
               AND ${finishedSql}
          ), '[]'::jsonb)
       )
       FROM members CROSS JOIN assignments${activitySql}`,
      // $3 appears only in the activity parts.
      activity ? [normalizeInternalId(groupId), start, end] : [normalizeInternalId(groupId), start],
   )
   return result.rows
}

export { findMemberGroup, findRankingSettings, listRankingFacts, saveRankingSettings }
