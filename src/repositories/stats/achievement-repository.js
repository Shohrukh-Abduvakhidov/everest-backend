import pool from '../../configs/db.js'
import { normalizeInternalId as normalizeId } from '../../utils/internal-id.js'

const normalizeInternalId = (value) => normalizeId(String(value))

// M13 achievements and ranking snapshots (decisions.md 2026-11-26). The facts of one learner
// are read here; src/utils/achievement-rules.js decides. Origins are filtered explicitly
// (decision of 2026-11-12): every attempt row carries its origin and the checks pick theirs.

const finishedAtSql = `COALESCE(attempt.submitted_at, attempt.graded_at, attempt.expires_at)`
const finishedSql = `attempt.status IN ('graded', 'expired')`
// An answer the student gave (the mistakes rule of 2026-11-22).
const answeredSql = `answer.answer_data IS NOT NULL AND answer.answer_data <> 'null'::jsonb`

const achievementColumns = `achievement.id, achievement.code, achievement.family, achievement.category,
   achievement.tier, achievement.icon, achievement.translations, achievement.criteria, achievement.position`

// ---------------------------------------------------------------- catalog and awards

async function listActiveAchievements(db = pool) {
   const result = await db.query(
      `SELECT ${achievementColumns}
       FROM achievements AS achievement
       WHERE achievement.is_active
       ORDER BY achievement.position, achievement.id`,
   )
   return result.rows
}

async function listUserAchievements(userId, db = pool) {
   const result = await db.query(
      `SELECT award.achievement_id, award.awarded_at, award.seen_at, award.metadata
       FROM user_achievements AS award
       WHERE award.user_id = $1`,
      [normalizeInternalId(userId)],
   )
   return result.rows
}

// The latest awards of active catalog rows, newest first.
async function listRecentAchievements(userId, limit, db = pool) {
   const result = await db.query(
      `SELECT ${achievementColumns}, award.awarded_at, award.seen_at
       FROM user_achievements AS award
       JOIN achievements AS achievement ON achievement.id = award.achievement_id AND achievement.is_active
       WHERE award.user_id = $1
       ORDER BY award.awarded_at DESC, achievement.position DESC
       LIMIT $2`,
      [normalizeInternalId(userId), limit],
   )
   return result.rows
}

// Inserts the awards that do not exist yet. Returns the achievement ids really inserted, so the
// caller notifies only about those (a second evaluation inserts nothing).
async function insertUserAchievements(rows, client) {
   if (!rows.length) return []
   const result = await client.query(
      `INSERT INTO user_achievements (user_id, achievement_id, awarded_at, source_event_key, metadata, seen_at)
       SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::timestamptz[], $4::text[], $5::jsonb[], $6::timestamptz[])
       ON CONFLICT (user_id, achievement_id) DO NOTHING
       RETURNING achievement_id`,
      [
         rows.map((row) => normalizeInternalId(row.userId)),
         rows.map((row) => normalizeInternalId(row.achievementId)),
         rows.map((row) => row.awardedAt),
         rows.map((row) => row.sourceEventKey),
         rows.map((row) => JSON.stringify(row.metadata ?? {})),
         rows.map((row) => row.seenAt ?? null),
      ],
   )
   return result.rows.map((row) => row.achievement_id)
}

// Marks the congratulations of these codes shown; an award already seen keeps its first time.
async function markAchievementsSeen(userId, codes, at, client) {
   const result = await client.query(
      `UPDATE user_achievements AS award
       SET seen_at = $3
       FROM achievements AS achievement
       WHERE award.achievement_id = achievement.id AND award.user_id = $1
         AND achievement.code = ANY($2::text[]) AND award.seen_at IS NULL`,
      [normalizeInternalId(userId), codes, at],
   )
   return result.rowCount
}

async function findAchievementAward(userId, achievementId, db = pool) {
   const result = await db.query(
      `SELECT ${achievementColumns}, award.user_id, award.awarded_at
       FROM user_achievements AS award
       JOIN achievements AS achievement ON achievement.id = award.achievement_id
       WHERE award.user_id = $1 AND award.achievement_id = $2`,
      [normalizeInternalId(userId), normalizeInternalId(achievementId)],
   )
   return result.rows[0] || null
}

async function findLearner(userId, db = pool) {
   const result = await db.query(
      `SELECT account.id, account.status, COALESCE(profile.timezone, 'Asia/Dushanbe') AS timezone
       FROM users AS account
       LEFT JOIN user_profiles AS profile ON profile.user_id = account.id
       WHERE account.id = $1`,
      [normalizeInternalId(userId)],
   )
   return result.rows[0] || null
}

// ---------------------------------------------------------------- facts of one learner

// Every finished attempt, any origin: timing, size and the answered count for the anti-cheat
// rule, the pass threshold of the policy snapshot, the trainer subject and mode.
async function listFinishedAttempts(userId, db = pool) {
   const result = await db.query(
      `SELECT attempt.id, test.origin, attempt.test_id, attempt.assignment_id, attempt.attempt_number,
          attempt.score, attempt.max_score, attempt.policy_snapshot ->> 'passPercent' AS pass_percent,
          ${finishedAtSql} AS finished_at,
          GREATEST(0, EXTRACT(EPOCH FROM (${finishedAtSql} - attempt.started_at)) - attempt.paused_seconds)::float8 AS seconds,
          (SELECT count(*) FROM attempt_questions AS item WHERE item.attempt_id = attempt.id)::integer AS questions,
          (SELECT count(*) FROM attempt_questions AS item
             JOIN student_answers AS answer ON answer.attempt_question_id = item.id
             WHERE item.attempt_id = attempt.id AND ${answeredSql})::integer AS answered,
          CASE WHEN test.origin = 'trainer' THEN test.generation_filters ->> 'subjectId' END AS subject_id,
          COALESCE(test.generation_filters ->> 'mode', 'standard') IN ('mistakes', 'unanswered') AS repeat_training
       FROM test_attempts AS attempt
       JOIN tests AS test ON test.id = attempt.test_id
       WHERE attempt.user_id = $1 AND ${finishedSql}
         AND test.origin IN ('authored', 'standalone', 'trainer', 'mock_exam')
       ORDER BY ${finishedAtSql}, attempt.id`,
      [normalizeInternalId(userId)],
   )
   return result.rows
}

// Answered questions of finished trainings and mock exams, with full marks or not.
async function listAnsweredOccurrences(userId, db = pool) {
   const result = await db.query(
      `SELECT item.attempt_id, item.question_id,
          COALESCE(answer.awarded_points, 0) >= item.max_points AS full
       FROM test_attempts AS attempt
       JOIN tests AS test ON test.id = attempt.test_id AND test.origin IN ('trainer', 'mock_exam')
       JOIN attempt_questions AS item ON item.attempt_id = attempt.id
       JOIN student_answers AS answer ON answer.attempt_question_id = item.id AND ${answeredSql}
       WHERE attempt.user_id = $1 AND ${finishedSql}`,
      [normalizeInternalId(userId)],
   )
   return result.rows
}

async function listCompletedLessons(userId, db = pool) {
   const result = await db.query(
      `SELECT progress.lesson_id, progress.completed_at
       FROM lesson_progress AS progress
       WHERE progress.user_id = $1 AND progress.status = 'completed' AND progress.completed_at IS NOT NULL`,
      [normalizeInternalId(userId)],
   )
   return result.rows
}

// Courses with a current enrollment (not revoked, begun, not expired): published lessons of
// published modules, how many of them are completed, and when the last one was.
async function listEnrolledCourseProgress(userId, at, db = pool) {
   const result = await db.query(
      `SELECT enrollment.course_id,
          count(lesson.id)::integer AS total_lessons,
          count(progress.lesson_id) FILTER (WHERE progress.status = 'completed')::integer AS completed_lessons,
          max(progress.completed_at) FILTER (WHERE progress.status = 'completed') AS last_completed_at
       FROM course_enrollments AS enrollment
       JOIN courses AS course ON course.id = enrollment.course_id AND course.status = 'published'
       LEFT JOIN course_modules AS module ON module.course_id = course.id AND module.status = 'published'
       LEFT JOIN lessons AS lesson ON lesson.module_id = module.id AND lesson.status = 'published'
       LEFT JOIN lesson_progress AS progress ON progress.lesson_id = lesson.id AND progress.user_id = enrollment.user_id
       WHERE enrollment.user_id = $1 AND enrollment.revoked_at IS NULL AND enrollment.begins_at <= $2
         AND (enrollment.expires_at IS NULL OR enrollment.expires_at > $2)
       GROUP BY enrollment.course_id`,
      [normalizeInternalId(userId), at],
   )
   return result.rows
}

// Group assignments with a close time that fall into the learner's membership (from joined_at,
// until left_at). eligible: a standalone test, or a course test with a non-revoked enrollment
// (the ranking rule of 2026-11-25: who could not start it is not counted as missing it).
async function listGroupAssignments(userId, db = pool) {
   const result = await db.query(
      `SELECT assignment.id AS assignment_id, assignment.group_id, assignment.closes_at,
          test.origin = 'standalone' OR EXISTS (
             SELECT 1 FROM course_enrollments AS enrollment
             WHERE enrollment.user_id = member.user_id AND enrollment.course_id = test.course_id
               AND enrollment.revoked_at IS NULL
          ) AS eligible
       FROM group_members AS member
       JOIN test_assignments AS assignment ON assignment.group_id = member.group_id
       JOIN tests AS test ON test.id = assignment.test_id AND test.origin IN ('authored', 'standalone')
       WHERE member.user_id = $1 AND assignment.status <> 'revoked' AND assignment.closes_at IS NOT NULL
         AND assignment.closes_at >= member.joined_at
         AND (member.left_at IS NULL OR assignment.closes_at <= member.left_at)
         AND (member.status = 'active' OR member.left_at IS NOT NULL)`,
      [normalizeInternalId(userId)],
   )
   return result.rows
}

async function listWatchHours(userId, db = pool) {
   const result = await db.query(
      `SELECT occurred_at, COALESCE((metadata ->> 'seconds')::integer, 0) AS seconds
       FROM learning_activity_events
       WHERE user_id = $1 AND event_code = 'watch_hour'`,
      [normalizeInternalId(userId)],
   )
   return result.rows
}

// The learner's snapshot places, with the number of participants of that table.
async function listSnapshotPlaces(userId, periodKind, db = pool) {
   const result = await db.query(
      `SELECT mine.group_id, mine.board, mine.period_kind, to_char(mine.period_start, 'YYYY-MM-DD') AS period_start,
          mine.rank, mine.score, mine.computed_at,
          (SELECT count(*) FROM group_ranking_snapshots AS other
             WHERE other.group_id = mine.group_id AND other.board = mine.board
               AND other.period_kind = mine.period_kind AND other.period_start = mine.period_start)::integer AS participants
       FROM group_ranking_snapshots AS mine
       WHERE mine.user_id = $1 AND mine.period_kind = $2 AND mine.rank IS NOT NULL`,
      [normalizeInternalId(userId), periodKind],
   )
   return result.rows
}

// ---------------------------------------------------------------- candidates for scheduled runs

// Users with any learning activity (attempt, lesson, watch time) since a moment: the daily
// streak run evaluates them.
async function listUsersActiveSince(since, db = pool) {
   const result = await db.query(
      `SELECT DISTINCT event.user_id
       FROM learning_activity_events AS event
       JOIN users AS account ON account.id = event.user_id AND account.status = 'active'
       WHERE event.occurred_at >= $1
       ORDER BY event.user_id`,
      [since],
   )
   return result.rows.map((row) => row.user_id)
}

// Active members of the assignment's group with a finished attempt on it, when the assignment
// still closes at closesAt (a moved close time has its own job).
async function listAssignmentCloseCandidates(assignmentId, closesAt, db = pool) {
   const result = await db.query(
      `SELECT DISTINCT member.user_id
       FROM test_assignments AS assignment
       JOIN group_members AS member ON member.group_id = assignment.group_id AND member.status = 'active'
       JOIN users AS account ON account.id = member.user_id AND account.status = 'active'
       WHERE assignment.id = $1 AND assignment.status <> 'revoked' AND assignment.closes_at = $2
         AND EXISTS (
            SELECT 1 FROM test_attempts AS attempt
            WHERE attempt.assignment_id = assignment.id AND attempt.user_id = member.user_id AND ${finishedSql}
         )
       ORDER BY member.user_id`,
      [normalizeInternalId(assignmentId), closesAt],
   )
   return result.rows.map((row) => row.user_id)
}

// Every user that ever earned an award or has a finished attempt, lesson completion or watch
// time: the backfill evaluates them. Active accounts only.
async function listBackfillCandidates(db = pool) {
   const result = await db.query(
      `SELECT account.id AS user_id
       FROM users AS account
       WHERE account.status = 'active' AND (
          EXISTS (SELECT 1 FROM test_attempts AS attempt WHERE attempt.user_id = account.id AND ${finishedSql})
          OR EXISTS (SELECT 1 FROM lesson_progress AS progress WHERE progress.user_id = account.id AND progress.status = 'completed')
          OR EXISTS (SELECT 1 FROM learning_activity_events AS event WHERE event.user_id = account.id)
          OR EXISTS (SELECT 1 FROM group_ranking_snapshots AS snapshot WHERE snapshot.user_id = account.id)
       )
       ORDER BY account.id`,
   )
   return result.rows.map((row) => row.user_id)
}

// ---------------------------------------------------------------- snapshots

// Groups whose ranking is snapshotted: every group with an active member (archived ones keep
// their ranking, 2026-11-25).
async function listSnapshotGroupIds(db = pool) {
   const result = await db.query(
      `SELECT grp.id
       FROM groups AS grp
       WHERE EXISTS (SELECT 1 FROM group_members AS member WHERE member.group_id = grp.id AND member.status = 'active')
       ORDER BY grp.id`,
   )
   return result.rows.map((row) => row.id)
}

// Writes the places of one finished period once: rows that exist stay as they were, so a second
// run changes nothing. Returns the number of rows inserted.
async function insertSnapshotRows(rows, client) {
   if (!rows.length) return 0
   const result = await client.query(
      `INSERT INTO group_ranking_snapshots (group_id, board, period_kind, period_start, user_id, rank, score, details, computed_at)
       SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::date[], $5::bigint[], $6::integer[],
          $7::numeric[], $8::jsonb[], $9::timestamptz[])
       ON CONFLICT (group_id, board, period_kind, period_start, user_id) DO NOTHING`,
      [
         rows.map((row) => normalizeInternalId(row.groupId)),
         rows.map((row) => row.board),
         rows.map((row) => row.periodKind),
         rows.map((row) => row.periodStart),
         rows.map((row) => normalizeInternalId(row.userId)),
         rows.map((row) => row.rank),
         rows.map((row) => row.score),
         rows.map((row) => JSON.stringify(row.details ?? {})),
         rows.map((row) => row.computedAt),
      ],
   )
   return result.rowCount
}

async function hasSnapshot(groupId, board, periodKind, periodStart, db = pool) {
   const result = await db.query(
      `SELECT EXISTS (
          SELECT 1 FROM group_ranking_snapshots
          WHERE group_id = $1 AND board = $2 AND period_kind = $3 AND period_start = $4
       ) AS present`,
      [normalizeInternalId(groupId), board, periodKind, periodStart],
   )
   return result.rows[0].present
}

// Users placed within maxRank with a score above 0 in tables of at least minParticipants rows
// of one weekly period: the group_top3 candidates.
async function listTopPlacedUsers({ periodKind, periodStart, maxRank, minParticipants }, db = pool) {
   const result = await db.query(
      `SELECT DISTINCT snapshot.user_id
       FROM group_ranking_snapshots AS snapshot
       WHERE snapshot.period_kind = $1 AND snapshot.period_start = $2 AND snapshot.rank <= $3 AND snapshot.score > 0
         AND (SELECT count(*) FROM group_ranking_snapshots AS other
              WHERE other.group_id = snapshot.group_id AND other.board = snapshot.board
                AND other.period_kind = snapshot.period_kind AND other.period_start = snapshot.period_start) >= $4
       ORDER BY snapshot.user_id`,
      [periodKind, periodStart, maxRank, minParticipants],
   )
   return result.rows.map((row) => row.user_id)
}

export {
   findAchievementAward,
   findLearner,
   hasSnapshot,
   insertSnapshotRows,
   insertUserAchievements,
   listActiveAchievements,
   listAnsweredOccurrences,
   listAssignmentCloseCandidates,
   listBackfillCandidates,
   listCompletedLessons,
   listEnrolledCourseProgress,
   listFinishedAttempts,
   listGroupAssignments,
   listRecentAchievements,
   listSnapshotGroupIds,
   listSnapshotPlaces,
   listTopPlacedUsers,
   listUserAchievements,
   listUsersActiveSince,
   listWatchHours,
   markAchievementsSeen,
}
