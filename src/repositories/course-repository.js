import pool from '../configs/db.js'
import { normalizeInternalId } from '../utils/internal-id.js'

const administratorSql = `
   EXISTS (
      SELECT 1 FROM user_roles AS membership
      JOIN roles AS role ON role.id = membership.role_id
      WHERE membership.user_id = $1 AND role.code IN ('owner', 'admin')
   )`

async function listVisibleCourses(userId, { limit, offset }, db = pool) {
   const result = await db.query(
      `SELECT course.id, course.subject_id, course.title, course.description,
         course.language_code, course.translations, course.cover_asset_id,
         course.status, course.created_by, course.created_at, course.updated_at,
         ${administratorSql} AS administrator,
         assignment.id IS NOT NULL AS is_teacher,
         assignment.can_edit_course
       FROM courses AS course
       LEFT JOIN course_teachers AS assignment
         ON assignment.course_id = course.id AND assignment.user_id = $1
       WHERE ${administratorSql} OR assignment.id IS NOT NULL
       ORDER BY course.title, course.id
       LIMIT $2 OFFSET $3`,
      [normalizeInternalId(userId), limit + 1, offset],
   )
   return result.rows
}

async function findVisibleCourse(userId, courseId, db = pool) {
   const result = await db.query(
      `SELECT course.id, course.subject_id, course.title, course.description,
         course.language_code, course.translations, course.cover_asset_id,
         course.status, course.created_by, course.created_at, course.updated_at,
         ${administratorSql} AS administrator,
         assignment.id IS NOT NULL AS is_teacher,
         assignment.can_edit_course
       FROM courses AS course
       LEFT JOIN course_teachers AS assignment
         ON assignment.course_id = course.id AND assignment.user_id = $1
       WHERE course.id = $2 AND (${administratorSql} OR assignment.id IS NOT NULL)`,
      [normalizeInternalId(userId), normalizeInternalId(courseId)],
   )
   return result.rows[0] || null
}

async function createCourse(course, client) {
   const result = await client.query(
      `INSERT INTO courses
         (subject_id, title, description, language_code, translations,
          cover_asset_id, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7)
       RETURNING id, subject_id, title, description, language_code, translations,
         cover_asset_id, status, created_by, created_at, updated_at`,
      [
         course.subjectId,
         course.title,
         course.description,
         course.languageCode,
         course.translations,
         course.coverAssetId,
         normalizeInternalId(course.actorId),
      ],
   )
   return result.rows[0]
}

async function findCourseForUpdate(courseId, client) {
   const result = await client.query(
      `SELECT id, subject_id, title, description, language_code, translations,
         cover_asset_id, status, created_by, created_at, updated_at
       FROM courses WHERE id = $1 FOR UPDATE`,
      [normalizeInternalId(courseId)],
   )
   return result.rows[0] || null
}

async function findEditableCourseForUpdate(userId, courseId, client) {
   const result = await client.query(
      `SELECT course.id, course.subject_id, course.title, course.description,
         course.language_code, course.translations, course.cover_asset_id,
         course.status, course.created_by, course.created_at, course.updated_at,
         ${administratorSql} AS administrator,
         assignment.id IS NOT NULL AS is_teacher,
         assignment.can_edit_course
       FROM courses AS course
       LEFT JOIN course_teachers AS assignment
         ON assignment.course_id = course.id AND assignment.user_id = $1
       WHERE course.id = $2
         AND (${administratorSql} OR assignment.can_edit_course)
       FOR UPDATE OF course`,
      [normalizeInternalId(userId), normalizeInternalId(courseId)],
   )
   return result.rows[0] || null
}

async function updateCourse(courseId, changes, client) {
   const result = await client.query(
      `UPDATE courses SET
         subject_id = CASE WHEN $2 THEN $3 ELSE subject_id END,
         title = COALESCE($4, title),
         description = CASE WHEN $5 THEN $6 ELSE description END,
         language_code = COALESCE($7, language_code),
         translations = CASE WHEN $8 THEN $9 ELSE translations END,
         cover_asset_id = CASE WHEN $10 THEN $11 ELSE cover_asset_id END,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING id, subject_id, title, description, language_code, translations,
         cover_asset_id, status, created_by, created_at, updated_at`,
      [
         normalizeInternalId(courseId),
         changes.hasSubjectId,
         changes.subjectId,
         changes.title,
         changes.hasDescription,
         changes.description,
         changes.languageCode,
         changes.hasTranslations,
         changes.translations,
         changes.hasCoverAssetId,
         changes.coverAssetId,
      ],
   )
   return result.rows[0]
}

async function updateCourseStatus(courseId, status, client) {
   const result = await client.query(
      `UPDATE courses SET status = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING id, subject_id, title, description, language_code, translations,
         cover_asset_id, status, created_by, created_at, updated_at`,
      [normalizeInternalId(courseId), status],
   )
   return result.rows[0]
}

async function subjectExists(subjectId, db = pool) {
   const result = await db.query('SELECT id FROM subjects WHERE id = $1', [
      normalizeInternalId(subjectId),
   ])
   return result.rowCount > 0
}

async function assetExists(assetId, db = pool) {
   const result = await db.query('SELECT id FROM assets WHERE id = $1', [
      normalizeInternalId(assetId),
   ])
   return result.rowCount > 0
}

async function listVisibleTeachers(userId, courseId, db = pool) {
   const result = await db.query(
      `WITH accessible_course AS (
         SELECT course.id
         FROM courses AS course
         LEFT JOIN course_teachers AS own_assignment
           ON own_assignment.course_id = course.id AND own_assignment.user_id = $1
         WHERE course.id = $2 AND (${administratorSql} OR own_assignment.id IS NOT NULL)
       )
       SELECT assignment.id, assignment.user_id, profile.first_name, profile.last_name,
         profile.avatar_asset_id, assignment.can_edit_course,
         assignment.can_manage_lessons, assignment.can_manage_questions,
         assignment.can_manage_tests, assignment.can_view_results
       FROM accessible_course
       LEFT JOIN course_teachers AS assignment ON assignment.course_id = accessible_course.id
       LEFT JOIN user_profiles AS profile ON profile.user_id = assignment.user_id
       ORDER BY profile.last_name NULLS LAST, profile.first_name NULLS LAST,
         assignment.user_id`,
      [normalizeInternalId(userId), normalizeInternalId(courseId)],
   )
   return result.rows
}

async function findEligibleTeacherForUpdate(userId, client) {
   const result = await client.query(
      `SELECT account.id, account.status,
         EXISTS (
            SELECT 1 FROM user_roles AS membership
            JOIN roles AS role ON role.id = membership.role_id
            WHERE membership.user_id = account.id AND role.code = 'teacher'
         ) AS eligible
       FROM users AS account WHERE account.id = $1 FOR UPDATE`,
      [normalizeInternalId(userId)],
   )
   return result.rows[0] || null
}

async function findTeacherForUpdate(courseId, userId, client) {
   const result = await client.query(
      `SELECT id, user_id, can_edit_course, can_manage_lessons,
         can_manage_questions, can_manage_tests, can_view_results
       FROM course_teachers
       WHERE course_id = $1 AND user_id = $2 FOR UPDATE`,
      [normalizeInternalId(courseId), normalizeInternalId(userId)],
   )
   return result.rows[0] || null
}

async function createTeacher(assignment, client) {
   const result = await client.query(
      `INSERT INTO course_teachers
         (course_id, user_id, can_edit_course, can_manage_lessons,
          can_manage_questions, can_manage_tests, can_view_results, assigned_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, user_id, can_edit_course, can_manage_lessons,
         can_manage_questions, can_manage_tests, can_view_results`,
      [
         normalizeInternalId(assignment.courseId),
         normalizeInternalId(assignment.userId),
         assignment.canEditCourse,
         assignment.canManageLessons,
         assignment.canManageQuestions,
         assignment.canManageTests,
         assignment.canViewResults,
         normalizeInternalId(assignment.actorId),
      ],
   )
   return result.rows[0]
}

async function updateTeacher(courseId, userId, permissions, client) {
   const result = await client.query(
      `UPDATE course_teachers SET
         can_edit_course = COALESCE($3, can_edit_course),
         can_manage_lessons = COALESCE($4, can_manage_lessons),
         can_manage_questions = COALESCE($5, can_manage_questions),
         can_manage_tests = COALESCE($6, can_manage_tests),
         can_view_results = COALESCE($7, can_view_results)
       WHERE course_id = $1 AND user_id = $2
       RETURNING id, user_id, can_edit_course, can_manage_lessons,
         can_manage_questions, can_manage_tests, can_view_results`,
      [
         normalizeInternalId(courseId),
         normalizeInternalId(userId),
         permissions.canEditCourse,
         permissions.canManageLessons,
         permissions.canManageQuestions,
         permissions.canManageTests,
         permissions.canViewResults,
      ],
   )
   return result.rows[0]
}

async function removeTeacher(courseId, userId, client) {
   const result = await client.query(
      `DELETE FROM course_teachers WHERE course_id = $1 AND user_id = $2 RETURNING id`,
      [normalizeInternalId(courseId), normalizeInternalId(userId)],
   )
   return result.rowCount > 0
}

export {
   assetExists,
   createCourse,
   createTeacher,
   findCourseForUpdate,
   findEditableCourseForUpdate,
   findEligibleTeacherForUpdate,
   findTeacherForUpdate,
   findVisibleCourse,
   listVisibleCourses,
   listVisibleTeachers,
   removeTeacher,
   subjectExists,
   updateCourse,
   updateCourseStatus,
   updateTeacher,
}
