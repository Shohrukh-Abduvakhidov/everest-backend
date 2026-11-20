import pool from '../configs/db.js'
import { normalizeInternalId } from '../utils/internal-id.js'

// The signed-in user's own staff rights: roles, permissions from role_permissions and the
// course_teachers / group_teachers assignments with their flags. Every query is keyed by the
// caller's user id only.

async function findAccountStatus(userId, db = pool) {
   const result = await db.query('SELECT status FROM users WHERE id = $1', [normalizeInternalId(userId)])
   return result.rows[0]?.status ?? null
}

async function listRoleCodes(userId, db = pool) {
   const result = await db.query(
      `SELECT role.code
       FROM user_roles AS membership
       JOIN roles AS role ON role.id = membership.role_id
       WHERE membership.user_id = $1
       ORDER BY role.code`,
      [normalizeInternalId(userId)],
   )
   return result.rows.map((row) => row.code)
}

async function listPermissionCodes(userId, db = pool) {
   const result = await db.query(
      `SELECT DISTINCT permission.code
       FROM user_roles AS membership
       JOIN role_permissions AS grant_record ON grant_record.role_id = membership.role_id
       JOIN permissions AS permission ON permission.id = grant_record.permission_id
       WHERE membership.user_id = $1
       ORDER BY permission.code`,
      [normalizeInternalId(userId)],
   )
   return result.rows.map((row) => row.code)
}

async function listCourseAssignments(userId, db = pool) {
   const result = await db.query(
      `SELECT course.id::text AS course_id, course.title, course.status,
         assignment.can_edit_course, assignment.can_manage_lessons, assignment.can_manage_questions,
         assignment.can_manage_tests, assignment.can_view_results
       FROM course_teachers AS assignment
       JOIN courses AS course ON course.id = assignment.course_id
       WHERE assignment.user_id = $1
       ORDER BY course.title, course.id`,
      [normalizeInternalId(userId)],
   )
   return result.rows
}

async function listGroupAssignments(userId, db = pool) {
   const result = await db.query(
      `SELECT grp.id::text AS group_id, grp.code, grp.title, grp.status,
         assignment.can_publish_announcements, assignment.can_assign_tests, assignment.can_view_results
       FROM group_teachers AS assignment
       JOIN groups AS grp ON grp.id = assignment.group_id
       WHERE assignment.user_id = $1
       ORDER BY grp.title, grp.id`,
      [normalizeInternalId(userId)],
   )
   return result.rows
}

export {
   findAccountStatus,
   listCourseAssignments,
   listGroupAssignments,
   listPermissionCodes,
   listRoleCodes,
}
