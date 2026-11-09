import pool from '../configs/db.js'
import { normalizeInternalId } from '../utils/internal-id.js'

const assignmentColumns = `assignment.id, assignment.test_id, assignment.opens_at,
   assignment.closes_at, assignment.personal_window_minutes, assignment.group_id, assignment.user_id,
   test.course_id, test.module_id, test.origin, test.title, test.mode, test.status AS test_status,
   test.duration_seconds, test.max_attempts, test.result_policy, test.answer_reveal_policy,
   test.shuffle_questions, test.shuffle_options, test.grading_policy,
   (SELECT count(*)::integer FROM test_questions WHERE test_id = test.id) AS question_count`

const learnerAudienceSql = `assignment.status = 'active' AND (
   assignment.user_id = $1 OR assignment.group_id IN (
      SELECT group_id FROM group_members WHERE user_id = $1 AND status = 'active'
   )
)`

// History: an assignment the learner is no longer assigned (revoked, or a group they left)
// stays readable only through their own attempts on it. It never allows a start.
const learnerOwnAttemptSql = `EXISTS (
   SELECT 1 FROM test_attempts AS own_attempt
   WHERE own_attempt.assignment_id = assignment.id AND own_attempt.user_id = $1
)`

const learnerHistoryColumns = `${assignmentColumns}, (${learnerAudienceSql}) AS available`

const attemptColumns = `attempt.id, attempt.test_id, attempt.assignment_id, attempt.user_id,
   attempt.attempt_number, attempt.status, attempt.started_at, attempt.expires_at,
   attempt.submitted_at, attempt.graded_at, attempt.score, attempt.max_score,
   attempt.policy_snapshot`

const attemptContextColumns = `${attemptColumns}, test.title, test.course_id, test.module_id, test.origin,
   assignment.closes_at`

const attemptContextFrom = `FROM test_attempts AS attempt
   JOIN tests AS test ON test.id = attempt.test_id
   JOIN test_assignments AS assignment ON assignment.id = attempt.assignment_id`

const questionColumns = `item.id, item.position, item.question_id, item.max_points, item.option_order,
   item.matching_order, question.question_type, question.content, question.interaction_settings,
   answer.answer_data, answer.revision, answer.awarded_points, answer.grading_status, answer.saved_at,
   (SELECT COALESCE(jsonb_agg(jsonb_build_object('key', option.option_key, 'content', option.content)), '[]')
    FROM question_options AS option WHERE option.question_id = question.id) AS options,
   (SELECT COALESCE(jsonb_agg(jsonb_build_object('side', entry.side, 'key', entry.item_key, 'content', entry.content)), '[]')
    FROM question_matching_items AS entry WHERE entry.question_id = question.id) AS matching_items`

async function findLearnerAssignment(userId, assignmentId, db = pool) {
   const result = await db.query(
      `SELECT ${assignmentColumns}
       FROM test_assignments AS assignment JOIN tests AS test ON test.id = assignment.test_id
       WHERE assignment.id = $2 AND ${learnerAudienceSql}`,
      [normalizeInternalId(userId), normalizeInternalId(assignmentId)],
   )
   return result.rows[0] || null
}

// Read-only lookup that also finds an assignment the learner only has attempts on.
async function findLearnerAssignmentHistory(userId, assignmentId, db = pool) {
   const result = await db.query(
      `SELECT ${learnerHistoryColumns}
       FROM test_assignments AS assignment JOIN tests AS test ON test.id = assignment.test_id
       WHERE assignment.id = $2 AND ((${learnerAudienceSql}) OR ${learnerOwnAttemptSql})`,
      [normalizeInternalId(userId), normalizeInternalId(assignmentId)],
   )
   return result.rows[0] || null
}

async function listLearnerAssignments(userId, courseId, lessonId, db = pool) {
   const result = await db.query(
      `SELECT ${learnerHistoryColumns}
       FROM test_assignments AS assignment JOIN tests AS test ON test.id = assignment.test_id
       WHERE test.course_id = $2 AND test.origin = 'authored'
         AND ((test.status = 'published' AND ${learnerAudienceSql}) OR ${learnerOwnAttemptSql})
         AND ($3::bigint IS NULL OR EXISTS (
            SELECT 1 FROM lessons AS lesson
            WHERE lesson.id = $3 AND lesson.course_id = test.course_id AND lesson.test_id = test.id
         ))
       ORDER BY assignment.opens_at, assignment.id`,
      [normalizeInternalId(userId), normalizeInternalId(courseId), lessonId],
   )
   return result.rows
}

// Serializes one student's starts of one assignment, so concurrent requests cannot both pick
// the first attempt or pass the attempt limit.
async function lockAttemptSlot(userId, assignmentId, client) {
   await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('test-attempt:' || $1::text || ':' || $2::text, 0))`,
      [normalizeInternalId(userId), normalizeInternalId(assignmentId)],
   )
}

async function hasActiveEnrollment(userId, courseId, at, db = pool) {
   const result = await db.query(
      `SELECT EXISTS (
         SELECT 1 FROM course_enrollments
         WHERE user_id = $1 AND course_id = $2 AND revoked_at IS NULL AND begins_at <= $3
           AND (expires_at IS NULL OR expires_at > $3)
       ) AS active`,
      [normalizeInternalId(userId), normalizeInternalId(courseId), at],
   )
   return result.rows[0].active
}

async function isActiveAccount(userId, db = pool) {
   const result = await db.query(
      `SELECT EXISTS (SELECT 1 FROM users WHERE id = $1 AND status = 'active') AS active`,
      [normalizeInternalId(userId)],
   )
   return result.rows[0].active
}

async function hasActiveModuleGrant(userId, moduleId, at, db = pool) {
   const result = await db.query(
      `SELECT EXISTS (
         SELECT 1 FROM module_access_grants
         WHERE user_id = $1 AND module_id = $2 AND revoked_at IS NULL AND begins_at <= $3
           AND (expires_at IS NULL OR expires_at > $3)
       ) AS active`,
      [normalizeInternalId(userId), normalizeInternalId(moduleId), at],
   )
   return result.rows[0].active
}

async function listUserAttempts(userId, assignmentIds, db = pool) {
   const result = await db.query(
      `SELECT ${attemptColumns} FROM test_attempts AS attempt
       WHERE attempt.user_id = $1 AND attempt.assignment_id = ANY($2::bigint[])
       ORDER BY attempt.assignment_id, attempt.attempt_number`,
      [normalizeInternalId(userId), assignmentIds.map(normalizeInternalId)],
   )
   return result.rows
}

async function listAttemptSource(testId, client) {
   const result = await client.query(
      `SELECT link.id AS test_question_id, link.question_id, link.points, link.position,
         question.question_type, question.interaction_settings, key.answer_data, key.explanation,
         (SELECT COALESCE(jsonb_agg(option_key ORDER BY position), '[]')
          FROM question_options WHERE question_id = question.id) AS option_keys,
         (SELECT COALESCE(jsonb_agg(item_key ORDER BY position), '[]')
          FROM question_matching_items WHERE question_id = question.id AND side = 'left') AS left_keys,
         (SELECT COALESCE(jsonb_agg(item_key ORDER BY position), '[]')
          FROM question_matching_items WHERE question_id = question.id AND side = 'right') AS right_keys
       FROM test_questions AS link
       JOIN questions AS question ON question.id = link.question_id
       JOIN question_answer_keys AS key ON key.question_id = question.id AND key.status = 'verified'
       WHERE link.test_id = $1
       ORDER BY link.position`,
      [normalizeInternalId(testId)],
   )
   return result.rows
}

async function createAttempt(attempt, client) {
   const result = await client.query(
      `INSERT INTO test_attempts
         (test_id, assignment_id, user_id, attempt_number, started_at, expires_at, policy_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
         normalizeInternalId(attempt.testId),
         normalizeInternalId(attempt.assignmentId),
         normalizeInternalId(attempt.userId),
         attempt.attemptNumber,
         attempt.startedAt,
         attempt.expiresAt,
         attempt.policySnapshot,
      ],
   )
   return result.rows[0].id
}

async function addAttemptQuestions(attemptId, testId, questions, client) {
   await client.query(
      `INSERT INTO attempt_questions
         (attempt_id, test_id, test_question_id, question_id, position, option_order,
          matching_order, max_points, grading_snapshot)
       SELECT $1, $2, row.test_question_id, row.question_id, row.position, row.option_order,
          row.matching_order, row.max_points, row.grading_snapshot
       FROM jsonb_to_recordset($3::jsonb) AS row(
          test_question_id BIGINT, question_id BIGINT, position INTEGER, option_order JSONB,
          matching_order JSONB, max_points NUMERIC, grading_snapshot JSONB
       )`,
      [normalizeInternalId(attemptId), normalizeInternalId(testId), JSON.stringify(questions)],
   )
}

async function findAttempt(userId, attemptId, db = pool) {
   const result = await db.query(
      `SELECT ${attemptContextColumns} ${attemptContextFrom}
       WHERE attempt.id = $2 AND attempt.user_id = $1`,
      [normalizeInternalId(userId), normalizeInternalId(attemptId)],
   )
   return result.rows[0] || null
}

async function lockAttempt(userId, attemptId, client) {
   const result = await client.query(
      `SELECT ${attemptContextColumns} ${attemptContextFrom}
       WHERE attempt.id = $2 AND attempt.user_id = $1
       FOR UPDATE OF attempt`,
      [normalizeInternalId(userId), normalizeInternalId(attemptId)],
   )
   return result.rows[0] || null
}

// One expired attempt per transaction. SKIP LOCKED lets API requests and several sweep
// processes finish different attempts at the same time.
async function lockNextExpiredAttempt(now, userId, client) {
   const result = await client.query(
      `SELECT ${attemptColumns} FROM test_attempts AS attempt
       WHERE attempt.status = 'in_progress' AND attempt.expires_at <= $1
         AND ($2::bigint IS NULL OR attempt.user_id = $2)
       ORDER BY attempt.expires_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [now, userId],
   )
   return result.rows[0] || null
}

// Keys exist only in grading_snapshot, which is selected on request and never for a question
// that a learner is still answering.
async function listAttemptQuestions(attemptId, { withSnapshot = false } = {}, db = pool) {
   const result = await db.query(
      `SELECT ${questionColumns}${withSnapshot ? ', item.grading_snapshot' : ''}
       FROM attempt_questions AS item
       JOIN questions AS question ON question.id = item.question_id
       LEFT JOIN student_answers AS answer ON answer.attempt_question_id = item.id
       WHERE item.attempt_id = $1
       ORDER BY item.position`,
      [normalizeInternalId(attemptId)],
   )
   return result.rows
}

async function listGradingRows(attemptId, client) {
   const result = await client.query(
      `SELECT item.id, item.question_id, item.max_points, item.grading_snapshot, answer.answer_data,
         answer.awarded_points
       FROM attempt_questions AS item
       LEFT JOIN student_answers AS answer ON answer.attempt_question_id = item.id
       WHERE item.attempt_id = $1
       ORDER BY item.position`,
      [normalizeInternalId(attemptId)],
   )
   return result.rows
}

// Grading writes a row for every question, so only a non-null answer_data is a real answer.
async function hasSavedAnswer(attemptId, client) {
   const result = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM attempt_questions AS item
         JOIN student_answers AS answer ON answer.attempt_question_id = item.id
         WHERE item.attempt_id = $1 AND answer.answer_data IS NOT NULL
       ) AS answered`,
      [normalizeInternalId(attemptId)],
   )
   return result.rows[0].answered
}

async function findAttemptQuestion(attemptId, attemptQuestionId, client) {
   const result = await client.query(
      `SELECT item.id, item.question_id, item.grading_snapshot, answer.answer_data, answer.revision,
         answer.saved_at
       FROM attempt_questions AS item
       LEFT JOIN student_answers AS answer ON answer.attempt_question_id = item.id
       WHERE item.attempt_id = $1 AND item.id = $2`,
      [normalizeInternalId(attemptId), normalizeInternalId(attemptQuestionId)],
   )
   return result.rows[0] || null
}

async function saveAnswer(answer, client) {
   const result = await client.query(
      `INSERT INTO student_answers (attempt_question_id, question_id, answer_data, revision, saved_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (attempt_question_id) DO UPDATE SET
         answer_data = EXCLUDED.answer_data, revision = EXCLUDED.revision, saved_at = EXCLUDED.saved_at
       RETURNING revision, saved_at`,
      [
         normalizeInternalId(answer.attemptQuestionId),
         normalizeInternalId(answer.questionId),
         answer.answerData === null ? null : JSON.stringify(answer.answerData),
         answer.revision,
         answer.savedAt,
      ],
   )
   return result.rows[0]
}

// Unanswered questions get a row too, so results and regrades read one complete set.
async function saveGrades(grades, gradedAt, client) {
   await client.query(
      `INSERT INTO student_answers
         (attempt_question_id, question_id, awarded_points, grading_status, graded_at)
       SELECT row.id, row.question_id, row.awarded_points, 'auto', $2
       FROM jsonb_to_recordset($1::jsonb) AS row(id BIGINT, question_id BIGINT, awarded_points NUMERIC)
       ON CONFLICT (attempt_question_id) DO UPDATE SET
         awarded_points = EXCLUDED.awarded_points, grading_status = 'auto', graded_at = $2`,
      [JSON.stringify(grades), gradedAt],
   )
}

async function finishAttempt(attemptId, result, client) {
   await client.query(
      `UPDATE test_attempts
       SET status = $2, submitted_at = $3, graded_at = $4, score = $5, max_score = $6
       WHERE id = $1`,
      [
         normalizeInternalId(attemptId),
         result.status,
         result.submittedAt,
         result.gradedAt,
         result.score,
         result.maxScore,
      ],
   )
}

// ---------------------------------------------------------------- staff results

const administratorSql = `EXISTS (
   SELECT 1 FROM user_roles AS membership JOIN roles AS role ON role.id = membership.role_id
   WHERE membership.user_id = $1 AND role.code IN ('owner', 'admin')
)`

const teacherSql = `EXISTS (
   SELECT 1 FROM user_roles AS membership JOIN roles AS role ON role.id = membership.role_id
   WHERE membership.user_id = $1 AND role.code = 'teacher'
)`

const courseResultsSql = `EXISTS (
   SELECT 1 FROM course_teachers AS grant_row
   WHERE grant_row.course_id = test.course_id
     AND grant_row.user_id = $1 AND grant_row.can_view_results
)`

// A group teacher sees only attempts of assignments made to a group they have the flag for.
const groupResultsSql = (condition) => `EXISTS (
   SELECT 1 FROM test_assignments AS group_assignment
   JOIN group_teachers AS grant_row ON grant_row.group_id = group_assignment.group_id
   WHERE ${condition} AND grant_row.user_id = $1 AND grant_row.can_view_results
)`

// A test is visible when the actor can read at least some of its attempts.
const resultsScopeSql = `(${administratorSql} OR (${teacherSql} AND (
   ${courseResultsSql} OR ${groupResultsSql('group_assignment.test_id = test.id')}
)))`

const attemptScopeSql = `(${administratorSql} OR (${teacherSql} AND (
   ${courseResultsSql} OR ${groupResultsSql('group_assignment.id = attempt.assignment_id')}
)))`

const attemptJoinSql = 'JOIN tests AS test ON test.id = attempt.test_id'

const staffAttemptColumns = `${attemptColumns},
   (SELECT concat_ws(' ', first_name, last_name) FROM user_profiles
    WHERE user_id = attempt.user_id) AS user_display_name`

// ---------------------------------------------------------------- extra attempts

// Sum of extra attempts per assignment for one student. Missing assignments have none.
async function sumExtraAttempts(userId, assignmentIds, db = pool) {
   const result = await db.query(
      `SELECT assignment_id, sum(extra_attempts)::integer AS extra
       FROM test_attempt_grants
       WHERE user_id = $1 AND assignment_id = ANY($2::bigint[])
       GROUP BY assignment_id`,
      [normalizeInternalId(userId), assignmentIds.map(normalizeInternalId)],
   )
   return new Map(result.rows.map((row) => [row.assignment_id, row.extra]))
}

// Who may grant: owner and admin for any assignment; a teacher only for an assignment made
// to a group they teach with can_view_results (the results scope of group teachers).
const grantScopeSql = `(${administratorSql} OR EXISTS (
   SELECT 1 FROM group_teachers AS grant_row
   JOIN user_roles AS membership ON membership.user_id = grant_row.user_id
   JOIN roles AS role ON role.id = membership.role_id AND role.code = 'teacher'
   WHERE grant_row.group_id = assignment.group_id AND grant_row.user_id = $1
     AND grant_row.can_view_results
))`

const grantAssignmentColumns = `assignment.id, assignment.test_id, assignment.status,
   assignment.group_id, assignment.user_id, assignment.closes_at, test.status AS test_status,
   test.max_attempts`

async function findGrantAssignment(actorId, testId, assignmentId, db = pool) {
   const result = await db.query(
      `SELECT ${grantAssignmentColumns}
       FROM test_assignments AS assignment JOIN tests AS test ON test.id = assignment.test_id
       WHERE assignment.id = $3 AND assignment.test_id = $2 AND test.origin = 'authored' AND ${grantScopeSql}`,
      [normalizeInternalId(actorId), normalizeInternalId(testId), normalizeInternalId(assignmentId)],
   )
   return result.rows[0] || null
}

// FOR SHARE keeps a concurrent revoke or window change from interleaving with the grant.
async function lockGrantAssignment(actorId, testId, assignmentId, client) {
   const result = await client.query(
      `SELECT ${grantAssignmentColumns}
       FROM test_assignments AS assignment JOIN tests AS test ON test.id = assignment.test_id
       WHERE assignment.id = $3 AND assignment.test_id = $2 AND test.origin = 'authored' AND ${grantScopeSql}
       FOR SHARE OF assignment`,
      [normalizeInternalId(actorId), normalizeInternalId(testId), normalizeInternalId(assignmentId)],
   )
   return result.rows[0] || null
}

// The student is the direct assignee, or an active member of the assigned group.
async function isAssignmentStudent(assignmentId, userId, db = pool) {
   const result = await db.query(
      `SELECT EXISTS (
         SELECT 1 FROM test_assignments AS assignment
         WHERE assignment.id = $1 AND (
            assignment.user_id = $2 OR EXISTS (
               SELECT 1 FROM group_members AS member
               WHERE member.group_id = assignment.group_id AND member.user_id = $2
                 AND member.status = 'active'
            )
         )
       ) AS assigned`,
      [normalizeInternalId(assignmentId), normalizeInternalId(userId)],
   )
   return result.rows[0].assigned
}

const attemptGrantColumns = `grant_row.id, grant_row.assignment_id, grant_row.user_id,
   grant_row.extra_attempts, grant_row.reason, grant_row.granted_by, grant_row.created_at,
   (SELECT concat_ws(' ', first_name, last_name) FROM user_profiles
    WHERE user_id = grant_row.granted_by) AS granted_by_name`

async function findAttemptGrantByKey(idempotencyKey, client) {
   const result = await client.query(
      `SELECT ${attemptGrantColumns} FROM test_attempt_grants AS grant_row
       WHERE grant_row.idempotency_key = $1`,
      [idempotencyKey],
   )
   return result.rows[0] || null
}

// Append-only. A concurrent request with the same key inserts nothing and returns null.
async function insertAttemptGrant(grant, client) {
   const result = await client.query(
      `INSERT INTO test_attempt_grants
         (assignment_id, user_id, extra_attempts, reason, granted_by, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
         normalizeInternalId(grant.assignmentId),
         normalizeInternalId(grant.userId),
         grant.extraAttempts,
         grant.reason,
         normalizeInternalId(grant.grantedBy),
         grant.idempotencyKey,
      ],
   )
   return result.rows[0] || null
}

async function listAttemptGrants(assignmentId, userId, db = pool) {
   const result = await db.query(
      `SELECT ${attemptGrantColumns} FROM test_attempt_grants AS grant_row
       WHERE grant_row.assignment_id = $1 AND grant_row.user_id = $2
       ORDER BY grant_row.id`,
      [normalizeInternalId(assignmentId), normalizeInternalId(userId)],
   )
   return result.rows
}

async function findResultsTest(userId, testId, db = pool) {
   const result = await db.query(
      `SELECT test.id, test.title, test.course_id FROM tests AS test
       WHERE test.id = $2 AND test.origin = 'authored' AND ${resultsScopeSql}`,
      [normalizeInternalId(userId), normalizeInternalId(testId)],
   )
   return result.rows[0] || null
}

async function listTestAttempts(userId, testId, filters, db = pool) {
   const result = await db.query(
      `SELECT ${staffAttemptColumns} FROM test_attempts AS attempt ${attemptJoinSql}
       WHERE attempt.test_id = $2 AND ${attemptScopeSql}
         AND ($3::bigint IS NULL OR attempt.assignment_id = $3)
         AND ($4::bigint IS NULL OR attempt.user_id = $4)
         AND ($5::text IS NULL OR attempt.status = $5)
       ORDER BY attempt.id DESC
       LIMIT $6 OFFSET $7`,
      [
         normalizeInternalId(userId),
         normalizeInternalId(testId),
         filters.assignmentId,
         filters.userId,
         filters.status,
         filters.limit + 1,
         filters.offset,
      ],
   )
   return result.rows
}

async function findTestAttempt(userId, testId, attemptId, db = pool) {
   const result = await db.query(
      `SELECT ${staffAttemptColumns} FROM test_attempts AS attempt ${attemptJoinSql}
       WHERE attempt.test_id = $2 AND attempt.id = $3 AND ${attemptScopeSql}`,
      [normalizeInternalId(userId), normalizeInternalId(testId), normalizeInternalId(attemptId)],
   )
   return result.rows[0] || null
}

async function lockTestAttempt(userId, testId, attemptId, client) {
   const result = await client.query(
      `SELECT ${attemptColumns} FROM test_attempts AS attempt ${attemptJoinSql}
       WHERE attempt.test_id = $2 AND attempt.id = $3 AND ${attemptScopeSql}
       FOR UPDATE OF attempt`,
      [normalizeInternalId(userId), normalizeInternalId(testId), normalizeInternalId(attemptId)],
   )
   return result.rows[0] || null
}

async function listScoreRevisions(attemptId, db = pool) {
   const result = await db.query(
      `SELECT id, attempt_id, revised_by, reason, previous_score, new_score, created_at
       FROM attempt_score_revisions WHERE attempt_id = $1 ORDER BY id`,
      [normalizeInternalId(attemptId)],
   )
   return result.rows
}

async function findScoreRevisionByKey(idempotencyKey, client) {
   const result = await client.query(
      'SELECT id, attempt_id FROM attempt_score_revisions WHERE idempotency_key = $1',
      [idempotencyKey],
   )
   return result.rows[0] || null
}

async function saveManualGrade(grade, client) {
   await client.query(
      `UPDATE student_answers
       SET awarded_points = $2, grading_status = 'manual', graded_by = $3, graded_at = $4
       WHERE attempt_question_id = $1`,
      [
         normalizeInternalId(grade.attemptQuestionId),
         grade.points,
         normalizeInternalId(grade.gradedBy),
         grade.gradedAt,
      ],
   )
}

async function setAttemptScore(attemptId, score, gradedAt, client) {
   await client.query(
      'UPDATE test_attempts SET score = $2, graded_at = $3 WHERE id = $1',
      [normalizeInternalId(attemptId), score, gradedAt],
   )
}

async function addScoreRevision(revision, client) {
   await client.query(
      `INSERT INTO attempt_score_revisions
         (attempt_id, revised_by, reason, previous_score, new_score, grading_snapshot, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
         normalizeInternalId(revision.attemptId),
         normalizeInternalId(revision.revisedBy),
         revision.reason,
         revision.previousScore,
         revision.newScore,
         revision.gradingSnapshot,
         revision.idempotencyKey,
      ],
   )
}

export {
   addAttemptQuestions,
   addScoreRevision,
   createAttempt,
   findAttempt,
   findAttemptGrantByKey,
   findAttemptQuestion,
   findGrantAssignment,
   findLearnerAssignment,
   findLearnerAssignmentHistory,
   findResultsTest,
   findScoreRevisionByKey,
   findTestAttempt,
   finishAttempt,
   hasActiveEnrollment,
   hasActiveModuleGrant,
   isActiveAccount,
   hasSavedAnswer,
   insertAttemptGrant,
   isAssignmentStudent,
   listAttemptGrants,
   listAttemptQuestions,
   listAttemptSource,
   listGradingRows,
   listLearnerAssignments,
   listScoreRevisions,
   listTestAttempts,
   listUserAttempts,
   lockAttempt,
   lockAttemptSlot,
   lockGrantAssignment,
   lockNextExpiredAttempt,
   lockTestAttempt,
   saveAnswer,
   saveGrades,
   saveManualGrade,
   setAttemptScore,
   sumExtraAttempts,
}
