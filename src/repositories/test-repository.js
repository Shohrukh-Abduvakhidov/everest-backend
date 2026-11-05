import pool from '../configs/db.js'
import { normalizeInternalId } from '../utils/internal-id.js'

const administratorSql = `
   EXISTS (
      SELECT 1 FROM user_roles AS membership
      JOIN roles AS role ON role.id = membership.role_id
      WHERE membership.user_id = $1 AND role.code IN ('owner', 'admin')
   )`

const teacherRoleSql = `
   EXISTS (
      SELECT 1 FROM user_roles AS membership
      JOIN roles AS role ON role.id = membership.role_id
      WHERE membership.user_id = $1 AND role.code = 'teacher'
   )`

// Owner/admin reach every test. A teacher reaches the tests of courses where the assignment
// has can_manage_tests. Everything else looks missing.
const courseScopeSql = (courseColumn) => `(${administratorSql} OR (${teacherRoleSql} AND EXISTS (
   SELECT 1 FROM course_teachers AS assignment
   WHERE assignment.course_id = ${courseColumn}
     AND assignment.user_id = $1 AND assignment.can_manage_tests
)))`

const testColumns = `test.id, test.course_id, test.module_id, test.title, test.mode, test.status,
   test.duration_seconds, test.max_attempts, test.result_policy, test.answer_reveal_policy,
   test.shuffle_questions, test.shuffle_options, test.grading_policy, test.copied_from_id,
   test.created_by, test.created_at, test.updated_at,
   (SELECT status FROM courses WHERE id = test.course_id) AS course_status,
   (SELECT count(*)::integer FROM test_questions WHERE test_id = test.id) AS question_count,
   (SELECT COALESCE(sum(points), 0)::text FROM test_questions WHERE test_id = test.id) AS total_points,
   (SELECT count(*)::integer FROM test_assignments
    WHERE test_id = test.id AND status = 'active') AS active_assignment_count`

const assignmentColumns = `assignment.id, assignment.test_id, assignment.group_id, assignment.user_id,
   assignment.status, assignment.opens_at, assignment.closes_at, assignment.personal_window_minutes,
   assignment.assigned_by,
   assignment.created_at,
   (SELECT title FROM groups WHERE id = assignment.group_id) AS group_title,
   (SELECT concat_ws(' ', first_name, last_name) FROM user_profiles
    WHERE user_id = assignment.user_id) AS user_display_name`

async function lockManageableCourse(userId, courseId, client) {
   const result = await client.query(
      `SELECT course.id, course.status FROM courses AS course
       WHERE course.id = $2 AND ${courseScopeSql('course.id')}
       FOR SHARE OF course`,
      [normalizeInternalId(userId), normalizeInternalId(courseId)],
   )
   return result.rows[0] || null
}

async function listTests(userId, filters, db = pool) {
   const result = await db.query(
      `SELECT ${testColumns} FROM tests AS test
       WHERE ${courseScopeSql('test.course_id')}
         AND ($2::bigint IS NULL OR test.course_id = $2)
         AND ($3::text IS NULL OR test.status = $3)
       ORDER BY test.id DESC
       LIMIT $4 OFFSET $5`,
      [
         normalizeInternalId(userId),
         filters.courseId,
         filters.status,
         filters.limit + 1,
         filters.offset,
      ],
   )
   return result.rows
}

async function findTest(userId, testId, db = pool) {
   const result = await db.query(
      `SELECT ${testColumns} FROM tests AS test
       WHERE test.id = $2 AND ${courseScopeSql('test.course_id')}`,
      [normalizeInternalId(userId), normalizeInternalId(testId)],
   )
   return result.rows[0] || null
}

async function lockTest(userId, testId, client) {
   const result = await client.query(
      `SELECT ${testColumns} FROM tests AS test
       WHERE test.id = $2 AND ${courseScopeSql('test.course_id')}
       FOR UPDATE OF test`,
      [normalizeInternalId(userId), normalizeInternalId(testId)],
   )
   return result.rows[0] || null
}

async function createTest(test, client) {
   const result = await client.query(
      `INSERT INTO tests (
         course_id, title, mode, duration_seconds, max_attempts, result_policy,
         answer_reveal_policy, shuffle_questions, shuffle_options, grading_policy, created_by,
         module_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
         normalizeInternalId(test.courseId),
         test.title,
         test.mode,
         test.durationSeconds,
         test.maxAttempts,
         test.resultPolicy,
         test.answerRevealPolicy,
         test.shuffleQuestions,
         test.shuffleOptions,
         test.gradingPolicy,
         normalizeInternalId(test.createdBy),
         test.moduleId,
      ],
   )
   return result.rows[0].id
}

async function updateTest(testId, test, client) {
   await client.query(
      `UPDATE tests SET
         title = $2, mode = $3, duration_seconds = $4, max_attempts = $5, result_policy = $6,
         answer_reveal_policy = $7, shuffle_questions = $8, shuffle_options = $9,
         grading_policy = $10, module_id = $11, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [
         normalizeInternalId(testId),
         test.title,
         test.mode,
         test.durationSeconds,
         test.maxAttempts,
         test.resultPolicy,
         test.answerRevealPolicy,
         test.shuffleQuestions,
         test.shuffleOptions,
         test.gradingPolicy,
         test.moduleId,
      ],
   )
}

async function setTestStatus(testId, status, client) {
   await client.query(
      'UPDATE tests SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [normalizeInternalId(testId), status],
   )
}

async function hasCopies(testId, client) {
   const result = await client.query(
      'SELECT EXISTS (SELECT 1 FROM tests WHERE copied_from_id = $1) AS present',
      [normalizeInternalId(testId)],
   )
   return result.rows[0].present
}

async function deleteDraftTest(testId, client) {
   const id = normalizeInternalId(testId)
   await client.query('DELETE FROM test_questions WHERE test_id = $1', [id])
   await client.query('DELETE FROM tests WHERE id = $1', [id])
}

async function courseHasModule(courseId, moduleId, client) {
   const result = await client.query(
      'SELECT EXISTS (SELECT 1 FROM course_modules WHERE id = $1 AND course_id = $2) AS present',
      [normalizeInternalId(moduleId), normalizeInternalId(courseId)],
   )
   return result.rows[0].present
}

// Lessons that hold a link to this test; publishedOnly narrows to links that must not break.
async function listLinkedLessons(testId, { publishedOnly }, client) {
   const result = await client.query(
      `SELECT id, title, status FROM lessons
       WHERE test_id = $1 AND ($2::boolean = FALSE OR status = 'published')
       ORDER BY id`,
      [normalizeInternalId(testId), publishedOnly],
   )
   return result.rows
}

async function copyTest(testId, title, actorId, client) {
   const id = normalizeInternalId(testId)
   const result = await client.query(
      `INSERT INTO tests (
         course_id, module_id, title, mode, duration_seconds, max_attempts, result_policy,
         answer_reveal_policy, shuffle_questions, shuffle_options, grading_policy,
         generation_filters, copied_from_id, created_by
       )
       SELECT course_id, module_id, $2, mode, duration_seconds, max_attempts, result_policy,
         answer_reveal_policy, shuffle_questions, shuffle_options, grading_policy,
         generation_filters, id, $3
       FROM tests WHERE id = $1
       RETURNING id`,
      [id, title, normalizeInternalId(actorId)],
   )
   const copyId = result.rows[0].id
   await client.query(
      `INSERT INTO test_questions (test_id, question_id, position, points)
       SELECT $2, question_id, position, points FROM test_questions WHERE test_id = $1`,
      [id, copyId],
   )
   return copyId
}

async function listTestQuestions(testId, db = pool) {
   const result = await db.query(
      `SELECT link.question_id, link.position, link.points, question.bank_id,
         question.question_type, question.language_code, question.status, question.content,
         COALESCE(answer_key.status, 'unknown') AS key_status
       FROM test_questions AS link
       JOIN questions AS question ON question.id = link.question_id
       LEFT JOIN question_answer_keys AS answer_key ON answer_key.question_id = question.id
       WHERE link.test_id = $1
       ORDER BY link.position`,
      [normalizeInternalId(testId)],
   )
   return result.rows
}

// Shared locks keep a question from being archived while it joins a test.
async function lockReadableQuestions(userId, questionIds, client) {
   const result = await client.query(
      `SELECT question.id, question.status, COALESCE(answer_key.status, 'unknown') AS key_status
       FROM questions AS question
       JOIN question_banks AS bank ON bank.id = question.bank_id
       LEFT JOIN question_answer_keys AS answer_key ON answer_key.question_id = question.id
       WHERE question.id = ANY($2::bigint[])
         AND (${administratorSql} OR bank.owner_id = $1 OR bank.visibility = 'staff')
       ORDER BY question.id
       FOR SHARE OF question`,
      [normalizeInternalId(userId), questionIds.map(normalizeInternalId)],
   )
   return result.rows
}

async function findUnpublishableQuestions(testId, client) {
   const result = await client.query(
      `SELECT question.id
       FROM test_questions AS link
       JOIN questions AS question ON question.id = link.question_id
       LEFT JOIN question_answer_keys AS answer_key ON answer_key.question_id = question.id
       WHERE link.test_id = $1
         AND (question.status <> 'published' OR answer_key.status IS DISTINCT FROM 'verified')
       ORDER BY question.id
       FOR SHARE OF question`,
      [normalizeInternalId(testId)],
   )
   return result.rows.map((row) => row.id)
}

async function findTestQuestionIds(testId, client) {
   const result = await client.query(
      'SELECT question_id FROM test_questions WHERE test_id = $1 ORDER BY position',
      [normalizeInternalId(testId)],
   )
   return result.rows.map((row) => row.question_id)
}

async function addTestQuestions(testId, questions, client) {
   await client.query(
      `INSERT INTO test_questions (test_id, question_id, position, points)
       SELECT $1, added.question_id,
         (SELECT COALESCE(max(position), 0) FROM test_questions WHERE test_id = $1) + added.rank,
         added.points
       FROM unnest($2::bigint[], $3::numeric[]) WITH ORDINALITY
         AS added(question_id, points, rank)`,
      [
         normalizeInternalId(testId),
         questions.map((question) => question.questionId),
         questions.map((question) => question.points),
      ],
   )
}

async function removeTestQuestion(testId, questionId, client) {
   const result = await client.query(
      'DELETE FROM test_questions WHERE test_id = $1 AND question_id = $2',
      [normalizeInternalId(testId), normalizeInternalId(questionId)],
   )
   return result.rowCount > 0
}

// UNIQUE (test_id, position) is not deferrable, so positions first move above the used range.
async function setTestQuestionOrder(testId, questionIds, client) {
   const id = normalizeInternalId(testId)
   await client.query(
      `UPDATE test_questions SET position = position + (
          SELECT max(position) FROM test_questions WHERE test_id = $1
       ) + $2
       WHERE test_id = $1`,
      [id, questionIds.length],
   )
   await client.query(
      `UPDATE test_questions AS link
       SET position = ordered.position
       FROM unnest($2::bigint[]) WITH ORDINALITY AS ordered(question_id, position)
       WHERE link.test_id = $1 AND link.question_id = ordered.question_id`,
      [id, questionIds.map(normalizeInternalId)],
   )
}

async function setTestQuestionPoints(testId, questionId, points, client) {
   const result = await client.query(
      'UPDATE test_questions SET points = $3 WHERE test_id = $1 AND question_id = $2',
      [normalizeInternalId(testId), normalizeInternalId(questionId), points],
   )
   return result.rowCount > 0
}

async function listAssignments(testId, filters, db = pool) {
   const result = await db.query(
      `SELECT ${assignmentColumns} FROM test_assignments AS assignment
       WHERE assignment.test_id = $1
         AND ($2::text IS NULL OR assignment.status = $2)
       ORDER BY assignment.id DESC
       LIMIT $3 OFFSET $4`,
      [normalizeInternalId(testId), filters.status, filters.limit + 1, filters.offset],
   )
   return result.rows
}

async function findAssignment(testId, assignmentId, db = pool) {
   const result = await db.query(
      `SELECT ${assignmentColumns} FROM test_assignments AS assignment
       WHERE assignment.id = $2 AND assignment.test_id = $1`,
      [normalizeInternalId(testId), normalizeInternalId(assignmentId)],
   )
   return result.rows[0] || null
}

async function lockAssignableGroup(userId, groupId, client) {
   const result = await client.query(
      `SELECT group_record.id, group_record.status FROM groups AS group_record
       WHERE group_record.id = $2 AND (${administratorSql} OR EXISTS (
          SELECT 1 FROM group_teachers AS teacher
          WHERE teacher.group_id = group_record.id
            AND teacher.user_id = $1 AND teacher.can_assign_tests
       ))
       FOR SHARE OF group_record`,
      [normalizeInternalId(userId), normalizeInternalId(groupId)],
   )
   return result.rows[0] || null
}

async function findAssignableStudent(userId, courseId, client) {
   const result = await client.query(
      `SELECT account.id, account.status, EXISTS (
          SELECT 1 FROM course_enrollments AS enrollment
          WHERE enrollment.user_id = account.id AND enrollment.course_id = $2
            AND enrollment.revoked_at IS NULL
            AND (enrollment.expires_at IS NULL OR enrollment.expires_at > CURRENT_TIMESTAMP)
       ) AS enrolled
       FROM users AS account WHERE account.id = $1`,
      [normalizeInternalId(userId), normalizeInternalId(courseId)],
   )
   return result.rows[0] || null
}

async function hasActiveAssignment(testId, audience, client) {
   const result = await client.query(
      `SELECT EXISTS (
          SELECT 1 FROM test_assignments
          WHERE test_id = $1 AND status = 'active'
            AND (group_id = $2::bigint OR user_id = $3::bigint)
       ) AS present`,
      [normalizeInternalId(testId), audience.groupId, audience.userId],
   )
   return result.rows[0].present
}

async function createAssignment(assignment, client) {
   const result = await client.query(
      `INSERT INTO test_assignments (test_id, group_id, user_id, assigned_by, opens_at, closes_at, personal_window_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
         normalizeInternalId(assignment.testId),
         assignment.groupId,
         assignment.userId,
         normalizeInternalId(assignment.assignedBy),
         assignment.opensAt,
         assignment.closesAt,
         assignment.personalWindowMinutes ?? null,
      ],
   )
   return result.rows[0].id
}

async function updateAssignmentWindow(assignmentId, window, client) {
   await client.query(
      'UPDATE test_assignments SET opens_at = $2, closes_at = $3, personal_window_minutes = $4 WHERE id = $1',
      [normalizeInternalId(assignmentId), window.opensAt, window.closesAt, window.personalWindowMinutes],
   )
}

async function revokeAssignment(assignmentId, client) {
   await client.query(
      `UPDATE test_assignments SET status = 'revoked' WHERE id = $1`,
      [normalizeInternalId(assignmentId)],
   )
}

export {
   courseHasModule,
   listLinkedLessons,
   addTestQuestions,
   copyTest,
   createAssignment,
   createTest,
   deleteDraftTest,
   findAssignableStudent,
   findAssignment,
   findTest,
   findTestQuestionIds,
   findUnpublishableQuestions,
   hasActiveAssignment,
   hasCopies,
   listAssignments,
   listTestQuestions,
   listTests,
   lockAssignableGroup,
   lockManageableCourse,
   lockReadableQuestions,
   lockTest,
   removeTestQuestion,
   revokeAssignment,
   setTestQuestionOrder,
   setTestQuestionPoints,
   setTestStatus,
   updateAssignmentWindow,
   updateTest,
}
