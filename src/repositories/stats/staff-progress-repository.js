import pool from '../../configs/db.js'
import { normalizeInternalId } from '../../utils/internal-id.js'

// Staff progress views (M12 PR 3). Scope follows decision D1: owner and admin see everyone; a
// teacher sees a group with group_teachers.can_view_results and a course with
// course_teachers.can_view_results. Every per-student query takes the whole list of students
// (bigint[]) and aggregates in one statement, so a page never runs one query per student.
// Percentages and the "behind" rules are computed in src/utils/learning-metrics.js.

const ids = (values) => values.map(normalizeInternalId)

const administratorSql = `EXISTS (
   SELECT 1 FROM user_roles AS membership JOIN roles AS role ON role.id = membership.role_id
   WHERE membership.user_id = $1 AND role.code IN ('owner', 'admin')
)`

const teacherSql = `EXISTS (
   SELECT 1 FROM user_roles AS membership JOIN roles AS role ON role.id = membership.role_id
   WHERE membership.user_id = $1 AND role.code = 'teacher'
)`

const finishedSql = `attempt.status IN ('graded', 'expired') AND attempt.max_score > 0`

// ---------------------------------------------------------------- scope

async function findProgressGroup(actorId, groupId, db = pool) {
   const result = await db.query(
      `SELECT grp.id, grp.code, grp.title, grp.status
       FROM groups AS grp
       WHERE grp.id = $2 AND (${administratorSql} OR (${teacherSql} AND EXISTS (
          SELECT 1 FROM group_teachers AS grant_row
          WHERE grant_row.group_id = grp.id AND grant_row.user_id = $1 AND grant_row.can_view_results
       )))`,
      [normalizeInternalId(actorId), normalizeInternalId(groupId)],
   )
   return result.rows[0] || null
}

async function findProgressCourse(actorId, courseId, db = pool) {
   const result = await db.query(
      `SELECT course.id, course.title, course.status
       FROM courses AS course
       WHERE course.id = $2 AND (${administratorSql} OR (${teacherSql} AND EXISTS (
          SELECT 1 FROM course_teachers AS grant_row
          WHERE grant_row.course_id = course.id AND grant_row.user_id = $1 AND grant_row.can_view_results
       )))`,
      [normalizeInternalId(actorId), normalizeInternalId(courseId)],
   )
   return result.rows[0] || null
}

// The student and what the actor may see of them: everything (administrator, or a group teacher
// of an active membership) or only the courses the actor teaches with can_view_results and the
// student is enrolled in. A student outside every scope still returns a row; the service turns
// it into 404 so existence is not disclosed.
async function findStudentScope(actorId, studentId, db = pool) {
   const result = await db.query(
      `SELECT account.id, account.status, account.last_login_at,
         profile.first_name, profile.last_name,
         ${administratorSql} AS administrator,
         (${teacherSql} AND EXISTS (
            SELECT 1 FROM group_members AS member
            JOIN group_teachers AS grant_row ON grant_row.group_id = member.group_id
            WHERE member.user_id = account.id AND member.status = 'active'
              AND grant_row.user_id = $1 AND grant_row.can_view_results
         )) AS via_group,
         CASE WHEN ${teacherSql} THEN ARRAY(
            SELECT enrollment.course_id FROM course_enrollments AS enrollment
            JOIN course_teachers AS grant_row ON grant_row.course_id = enrollment.course_id
            WHERE enrollment.user_id = account.id AND enrollment.revoked_at IS NULL
              AND grant_row.user_id = $1 AND grant_row.can_view_results
            ORDER BY enrollment.course_id
         )::text[] ELSE '{}'::text[] END AS course_ids
       FROM users AS account
       LEFT JOIN user_profiles AS profile ON profile.user_id = account.id
       WHERE account.id = $2`,
      [normalizeInternalId(actorId), normalizeInternalId(studentId)],
   )
   return result.rows[0] || null
}

// ---------------------------------------------------------------- people

async function listGroupStudents(groupId, db = pool) {
   const result = await db.query(
      `SELECT member.user_id, member.joined_at, account.status AS account_status,
         account.last_login_at, profile.first_name, profile.last_name
       FROM group_members AS member
       JOIN users AS account ON account.id = member.user_id
       LEFT JOIN user_profiles AS profile ON profile.user_id = member.user_id
       WHERE member.group_id = $1 AND member.status = 'active'`,
      [normalizeInternalId(groupId)],
   )
   return result.rows
}

// Everyone with a non-revoked enrollment; enrollment_active tells whether it is open right now.
async function listCourseStudents(courseId, now, db = pool) {
   const result = await db.query(
      `SELECT enrollment.user_id, account.status AS account_status, account.last_login_at,
         profile.first_name, profile.last_name,
         (enrollment.begins_at <= $2 AND (enrollment.expires_at IS NULL OR enrollment.expires_at > $2))
            AS enrollment_active
       FROM course_enrollments AS enrollment
       JOIN users AS account ON account.id = enrollment.user_id
       LEFT JOIN user_profiles AS profile ON profile.user_id = enrollment.user_id
       WHERE enrollment.course_id = $1 AND enrollment.revoked_at IS NULL`,
      [normalizeInternalId(courseId), now],
   )
   return result.rows
}

// ---------------------------------------------------------------- per-student aggregates

// Latest activity of any kind: a learning event, a lesson progress write or an attempt start.
async function listLastActivity(userIds, db = pool) {
   const result = await db.query(
      `SELECT student.id AS user_id, GREATEST(
          (SELECT max(event.occurred_at) FROM learning_activity_events AS event WHERE event.user_id = student.id),
          (SELECT max(progress.updated_at) FROM lesson_progress AS progress WHERE progress.user_id = student.id),
          (SELECT max(attempt.started_at) FROM test_attempts AS attempt WHERE attempt.user_id = student.id)
       ) AS last_activity_at
       FROM unnest($1::bigint[]) AS student(id)`,
      [ids(userIds)],
   )
   return result.rows
}

// Course progress of every non-revoked enrollment, optionally of one course. As on the student's
// own course card: total = published lessons of published modules that can_access_module opens
// to the student at $3, and completed/started count only those lessons. total_published_lessons
// is every published lesson of the course, so staff see when not everything is open.
async function listCourseProgress(userIds, courseId, now, db = pool) {
   const result = await db.query(
      `WITH published AS (
          SELECT lesson.course_id, count(*)::integer AS total_published_lessons
          FROM lessons AS lesson JOIN course_modules AS module ON module.id = lesson.module_id
          WHERE lesson.status = 'published' AND module.status = 'published'
          GROUP BY lesson.course_id
       )
       SELECT enrollment.user_id, enrollment.course_id, course.title AS course_title,
         (enrollment.begins_at <= $3 AND (enrollment.expires_at IS NULL OR enrollment.expires_at > $3))
            AS enrollment_active,
         COALESCE(published.total_published_lessons, 0) AS total_published_lessons,
         open.total_lessons, open.completed_lessons, open.started_lessons
       FROM course_enrollments AS enrollment
       JOIN courses AS course ON course.id = enrollment.course_id
       LEFT JOIN published ON published.course_id = enrollment.course_id
       CROSS JOIN LATERAL (
          SELECT count(*)::integer AS total_lessons,
             count(*) FILTER (WHERE progress.status = 'completed')::integer AS completed_lessons,
             count(*) FILTER (WHERE progress.status = 'in_progress')::integer AS started_lessons
          FROM lessons AS lesson
          JOIN course_modules AS module ON module.id = lesson.module_id
          LEFT JOIN lesson_progress AS progress
             ON progress.lesson_id = lesson.id AND progress.user_id = enrollment.user_id
          WHERE lesson.course_id = enrollment.course_id
            AND lesson.status = 'published' AND module.status = 'published'
            AND can_access_module(enrollment.user_id, module.id, $3)
       ) AS open
       WHERE enrollment.user_id = ANY($1::bigint[]) AND enrollment.revoked_at IS NULL
         AND ($2::bigint IS NULL OR enrollment.course_id = $2)
       ORDER BY enrollment.user_id, course.title, enrollment.course_id`,
      [ids(userIds), courseId === null ? null : normalizeInternalId(courseId), now],
   )
   return result.rows
}

// The last `window` finished trainings of each subject per student, for readiness (D3), and
// the number of finished trainings per student. Repeat trainings (mode mistakes or unanswered) hold
// only questions the student got wrong or left blank, so they count as trainings but stay out of
// the readiness window.
async function listReadinessWindows(userIds, window, db = pool) {
   const result = await db.query(
      `SELECT user_id, subject_id, score, max_score, trainings
       FROM (
          SELECT attempt.user_id, (test.generation_filters ->> 'subjectId')::bigint AS subject_id,
             attempt.score, attempt.max_score,
             COALESCE(test.generation_filters ->> 'mode', 'standard') IN ('mistakes', 'unanswered') AS repeat_training,
             row_number() OVER (
                PARTITION BY attempt.user_id, test.generation_filters ->> 'subjectId',
                   COALESCE(test.generation_filters ->> 'mode', 'standard') IN ('mistakes', 'unanswered')
                ORDER BY attempt.submitted_at DESC, attempt.id DESC
             ) AS position,
             count(*) OVER (PARTITION BY attempt.user_id)::integer AS trainings
          FROM test_attempts AS attempt
          JOIN tests AS test ON test.id = attempt.test_id AND test.origin = 'trainer'
          WHERE attempt.user_id = ANY($1::bigint[]) AND ${finishedSql}
       ) AS ranked
       WHERE NOT repeat_training AND position <= $2`,
      [ids(userIds), window],
   )
   return result.rows
}

// The last `limit` finished course-test attempts per student, optionally of one course.
async function listRecentTestResults(userIds, courseId, limit, db = pool) {
   const result = await db.query(
      `SELECT user_id, id, test_id, assignment_id, course_id, title, attempt_number, status,
         score, max_score, policy_snapshot, submitted_at
       FROM (
          SELECT attempt.user_id, attempt.id, attempt.test_id, attempt.assignment_id, test.course_id,
             test.title, attempt.attempt_number, attempt.status, attempt.score, attempt.max_score,
             attempt.policy_snapshot, attempt.submitted_at,
             row_number() OVER (PARTITION BY attempt.user_id ORDER BY attempt.submitted_at DESC, attempt.id DESC)
                AS position
          FROM test_attempts AS attempt
          JOIN tests AS test ON test.id = attempt.test_id AND test.origin IN ('authored', 'standalone')
          WHERE attempt.user_id = ANY($1::bigint[]) AND ${finishedSql}
            AND ($2::bigint IS NULL OR test.course_id = $2)
       ) AS ranked
       WHERE position <= $3
       ORDER BY user_id, position`,
      [ids(userIds), courseId === null ? null : normalizeInternalId(courseId), limit],
   )
   return result.rows
}

// below_pass input (D5): the latest finished attempt of each test with a numeric passPercent,
// the last `limit` such tests per student.
async function listPassThresholdResults(userIds, courseId, limit, db = pool) {
   const result = await db.query(
      `SELECT user_id, score, max_score, policy_snapshot
       FROM (
          SELECT latest.*, row_number() OVER (
             PARTITION BY latest.user_id ORDER BY latest.submitted_at DESC, latest.id DESC
          ) AS position
          FROM (
             SELECT DISTINCT ON (attempt.user_id, attempt.test_id)
                attempt.user_id, attempt.id, attempt.score, attempt.max_score,
                attempt.policy_snapshot, attempt.submitted_at
             FROM test_attempts AS attempt
             JOIN tests AS test ON test.id = attempt.test_id AND test.origin IN ('authored', 'standalone')
             WHERE attempt.user_id = ANY($1::bigint[]) AND ${finishedSql}
               AND jsonb_typeof(attempt.policy_snapshot -> 'passPercent') = 'number'
               AND ($2::bigint IS NULL OR test.course_id = $2)
             ORDER BY attempt.user_id, attempt.test_id, attempt.submitted_at DESC, attempt.id DESC
          ) AS latest
       ) AS ranked
       WHERE position <= $3`,
      [ids(userIds), courseId === null ? null : normalizeInternalId(courseId), limit],
   )
   return result.rows
}

// missed_deadline (D5): assignments to the student or to a group they belonged to before the
// window closed, closed by $2, not revoked, in a course the student is enrolled in (a standalone
// test has no course: the assignment is enough), with no finished attempt of the student.
// Optionally only tests of one course (which leaves standalone tests out).
// The personal and the group branch are separate so each uses its own index; finished attempts
// are collected once for the candidate assignments and removed through a hashed NOT IN (both
// columns are NOT NULL, so NOT IN is exact).
async function listMissedAssignments(userIds, now, courseId, db = pool) {
   const closedSql = `assignment.status <> 'revoked' AND assignment.closes_at IS NOT NULL
      AND assignment.closes_at <= $2`
   const result = await db.query(
      `WITH assigned AS MATERIALIZED (
          SELECT assignment.user_id, assignment.id AS assignment_id, assignment.test_id, assignment.closes_at
          FROM test_assignments AS assignment
          WHERE assignment.user_id = ANY($1::bigint[]) AND ${closedSql}
          UNION ALL
          SELECT member.user_id, assignment.id, assignment.test_id, assignment.closes_at
          FROM group_members AS member
          JOIN test_assignments AS assignment ON assignment.group_id = member.group_id AND ${closedSql}
             AND member.joined_at < assignment.closes_at
          WHERE member.user_id = ANY($1::bigint[]) AND member.status = 'active'
       ), candidates AS MATERIALIZED (
          SELECT assigned.*, test.title, test.course_id
          FROM assigned
          JOIN tests AS test ON test.id = assigned.test_id AND test.origin IN ('authored', 'standalone')
          WHERE ($3::bigint IS NULL OR test.course_id = $3)
            AND (test.origin = 'standalone' OR EXISTS (
               SELECT 1 FROM course_enrollments AS enrollment
               WHERE enrollment.user_id = assigned.user_id AND enrollment.course_id = test.course_id
                 AND enrollment.revoked_at IS NULL
            ))
       ), finished AS MATERIALIZED (
          SELECT DISTINCT attempt.assignment_id, attempt.user_id
          FROM test_attempts AS attempt
          WHERE attempt.assignment_id IN (SELECT assignment_id FROM candidates)
            AND attempt.user_id = ANY($1::bigint[]) AND ${finishedSql}
       )
       SELECT candidates.user_id, candidates.assignment_id, candidates.test_id, candidates.title,
         candidates.course_id, candidates.closes_at
       FROM candidates
       WHERE (candidates.assignment_id, candidates.user_id) NOT IN (
          SELECT finished.assignment_id, finished.user_id FROM finished
       )
       ORDER BY candidates.user_id, candidates.closes_at DESC, candidates.assignment_id DESC`,
      [ids(userIds), now, courseId === null ? null : normalizeInternalId(courseId)],
   )
   return result.rows
}

// ---------------------------------------------------------------- course structure

async function listCourseLessons(courseId, db = pool) {
   const result = await db.query(
      `SELECT module.id AS module_id, module.title AS module_title, module.position AS module_position,
         lesson.id AS lesson_id, lesson.title, lesson.position, lesson.lesson_type
       FROM course_modules AS module
       JOIN lessons AS lesson ON lesson.module_id = module.id AND lesson.status = 'published'
       WHERE module.course_id = $1 AND module.status = 'published'
       ORDER BY module.position, lesson.position`,
      [normalizeInternalId(courseId)],
   )
   return result.rows
}

// Completed and started lessons per student and module, for the given students.
async function listModuleProgress(courseId, userIds, db = pool) {
   const result = await db.query(
      `SELECT progress.user_id, lesson.module_id, lesson.id AS lesson_id, progress.status
       FROM lesson_progress AS progress
       JOIN lessons AS lesson ON lesson.id = progress.lesson_id AND lesson.status = 'published'
       JOIN course_modules AS module ON module.id = lesson.module_id AND module.status = 'published'
       WHERE lesson.course_id = $1 AND progress.user_id = ANY($2::bigint[])
         AND progress.status IN ('completed', 'in_progress')`,
      [normalizeInternalId(courseId), ids(userIds)],
   )
   return result.rows
}

// ---------------------------------------------------------------- assignment results

async function findResultsAssignment(actorId, testId, assignmentId, db = pool) {
   const result = await db.query(
      `SELECT assignment.id, assignment.test_id, assignment.status, assignment.opens_at,
         assignment.closes_at, assignment.group_id, assignment.user_id, assignment.course_id,
         assignment.lesson_id, test.title, test.course_id AS test_course_id, test.max_attempts,
         test.result_policy, test.grading_policy
       FROM test_assignments AS assignment JOIN tests AS test ON test.id = assignment.test_id
       WHERE assignment.id = $3 AND assignment.test_id = $2 AND test.origin IN ('authored', 'standalone')
         AND (${administratorSql} OR (${teacherSql} AND (
            EXISTS (SELECT 1 FROM course_teachers AS grant_row
               WHERE grant_row.course_id = test.course_id AND grant_row.user_id = $1 AND grant_row.can_view_results)
            OR EXISTS (SELECT 1 FROM group_teachers AS grant_row
               WHERE grant_row.group_id = assignment.group_id AND grant_row.user_id = $1 AND grant_row.can_view_results)
            -- A personal assignment of a standalone test: a group of the student with the flag.
            OR (test.origin = 'standalone' AND assignment.user_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM group_members AS member
               JOIN group_teachers AS grant_row ON grant_row.group_id = member.group_id
               WHERE member.user_id = assignment.user_id AND member.status = 'active'
                  AND grant_row.user_id = $1 AND grant_row.can_view_results))
         )))`,
      [normalizeInternalId(actorId), normalizeInternalId(testId), normalizeInternalId(assignmentId)],
   )
   return result.rows[0] || null
}

// The audience of an assignment (the user, the group's active members, or the enrolled students
// of the course or lesson) plus anyone who already has an attempt on it, e.g. a former member.
async function listAssignmentStudents(assignment, db = pool) {
   const result = await db.query(
      `WITH audience AS (
          SELECT $2::bigint AS user_id WHERE $2::bigint IS NOT NULL
          UNION SELECT member.user_id FROM group_members AS member
             WHERE member.group_id = $3 AND member.status = 'active'
          UNION SELECT enrollment.user_id FROM course_enrollments AS enrollment
             WHERE enrollment.revoked_at IS NULL AND enrollment.course_id = COALESCE(
                $4::bigint, (SELECT course_id FROM lessons WHERE id = $5::bigint))
          UNION SELECT attempt.user_id FROM test_attempts AS attempt WHERE attempt.assignment_id = $1
       )
       SELECT audience.user_id, profile.first_name, profile.last_name,
         EXISTS (SELECT 1 FROM test_attempts AS attempt
            WHERE attempt.assignment_id = $1 AND attempt.user_id = audience.user_id) AS has_attempts
       FROM audience LEFT JOIN user_profiles AS profile ON profile.user_id = audience.user_id`,
      [
         normalizeInternalId(assignment.id),
         assignment.user_id === null ? null : normalizeInternalId(assignment.user_id),
         assignment.group_id === null ? null : normalizeInternalId(assignment.group_id),
         assignment.course_id === null ? null : normalizeInternalId(assignment.course_id),
         assignment.lesson_id === null ? null : normalizeInternalId(assignment.lesson_id),
      ],
   )
   return result.rows
}

async function listAssignmentAttempts(assignmentId, db = pool) {
   const result = await db.query(
      `SELECT id, user_id, attempt_number, status, score, max_score, policy_snapshot,
         started_at, submitted_at
       FROM test_attempts WHERE assignment_id = $1
       ORDER BY user_id, attempt_number`,
      [normalizeInternalId(assignmentId)],
   )
   return result.rows
}

async function listAssignmentExtraAttempts(assignmentId, db = pool) {
   const result = await db.query(
      `SELECT user_id, sum(extra_attempts)::integer AS extra
       FROM test_attempt_grants WHERE assignment_id = $1 GROUP BY user_id`,
      [normalizeInternalId(assignmentId)],
   )
   return result.rows
}

export {
   findProgressCourse,
   findProgressGroup,
   findResultsAssignment,
   findStudentScope,
   listAssignmentAttempts,
   listAssignmentExtraAttempts,
   listAssignmentStudents,
   listCourseLessons,
   listCourseProgress,
   listCourseStudents,
   listGroupStudents,
   listLastActivity,
   listMissedAssignments,
   listModuleProgress,
   listPassThresholdResults,
   listReadinessWindows,
   listRecentTestResults,
}
