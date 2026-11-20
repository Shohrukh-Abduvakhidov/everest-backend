import * as capabilitiesRepository from '../repositories/staff-capabilities-repository.js'
import AppError from '../utils/app-error.js'
import { parseUserId } from './course-service.js'

// What the signed-in user may do as staff, for the frontend to decide which screens to show.
// Own data only and read-only. The flags mirror course_teachers and group_teachers; the server
// still checks every action itself, so this answer never grants anything.
//
// allAccess is true for owner and admin: they act on every course and group without an
// assignment, so the lists then hold only assignments that happen to exist. A teacher's
// assignments are listed only while the teacher role is held, because the teacher scopes of
// tests and progress require that role. Anyone else (a student) gets empty lists, not 403.

const allAccessRoles = ['owner', 'admin']

function dependencies(overrides = {}) {
   return { repository: overrides.repository || capabilitiesRepository }
}

function courseDto(row) {
   return {
      courseId: row.course_id,
      title: row.title,
      status: row.status,
      canEditCourse: row.can_edit_course,
      canManageLessons: row.can_manage_lessons,
      canManageQuestions: row.can_manage_questions,
      canManageTests: row.can_manage_tests,
      canViewResults: row.can_view_results,
   }
}

function groupDto(row) {
   return {
      groupId: row.group_id,
      code: row.code,
      name: row.title,
      status: row.status,
      canPublishAnnouncements: row.can_publish_announcements,
      canAssignTests: row.can_assign_tests,
      canViewResults: row.can_view_results,
   }
}

async function getStaffCapabilitiesService(userId, overrides) {
   const { repository } = dependencies(overrides)
   const actorId = parseUserId(userId)
   if (await repository.findAccountStatus(actorId) !== 'active') {
      throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'Account is not active')
   }
   const [roles, permissions] = await Promise.all([
      repository.listRoleCodes(actorId),
      repository.listPermissionCodes(actorId),
   ])
   const allAccess = roles.some((role) => allAccessRoles.includes(role))
   const isTeacher = roles.includes('teacher')
   const [courses, groups] = allAccess || isTeacher
      ? await Promise.all([
         repository.listCourseAssignments(actorId),
         repository.listGroupAssignments(actorId),
      ])
      : [[], []]
   return {
      roles,
      permissions,
      allAccess,
      isTeacher,
      courses: courses.map(courseDto),
      groups: groups.map(groupDto),
   }
}

export { getStaffCapabilitiesService }
