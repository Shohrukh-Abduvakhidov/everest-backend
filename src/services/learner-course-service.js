import * as courseAccessRepository from '../repositories/course-access-repository.js'
import AppError from '../utils/app-error.js'
import { parseCourseId, parseId, parseUserId } from './course-service.js'

function dependencies(overrides = {}) {
   return {
      repository: overrides.repository || courseAccessRepository,
   }
}

function iso(value) {
   return value === null ? null : new Date(value).toISOString()
}

function safeCardMetadata(row) {
   return {
      subject: row.subject,
      moduleCount: row.module_count,
      lessonCount: row.lesson_count,
   }
}

function safeEnrollmentWindow(row) {
   return {
      state: row.state,
      beginsAt: iso(row.begins_at),
      expiresAt: iso(row.expires_at),
   }
}

// Coarse, learner-safe reasons. A revoked module grant is reported as not_granted so the
// reason never discloses administrative history.
function lockReason(enrollment, module) {
   if (!module.onboarded) return 'onboarding_required'
   if (enrollment.state === 'scheduled') return 'not_started'
   if (enrollment.state === 'expired') return 'expired'
   if (!module.has_grant) return 'not_granted'
   if (module.grant_scheduled) return 'not_started'
   if (module.grant_expired) return 'expired'
   return 'unavailable'
}

// Locked modules expose only published structure: no lessons, assets, tests or counts.
function safeLearnerModule(enrollment, module) {
   return {
      id: module.id,
      position: module.position,
      title: module.title,
      description: module.description,
      translations: module.translations,
      access: module.granted
         ? { granted: true, lockReason: null }
         : { granted: false, lockReason: lockReason(enrollment, module) },
   }
}

async function listLearnerCoursesService(userId, overrides) {
   const { repository } = dependencies(overrides)
   const rows = await repository.listLearnerCourses(parseUserId(userId))
   return {
      courses: rows.map((row) => ({
         id: row.course_id,
         title: row.title,
         description: row.description,
         languageCode: row.language_code,
         translations: row.translations,
         coverAssetId: row.cover_asset_id,
         ...safeCardMetadata(row),
         enrollment: safeEnrollmentWindow(row),
      })),
   }
}

async function listLearnerCourseModulesService(userId, courseIdValue, overrides) {
   const { repository } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const enrollment = await repository.findLearnerCourse(actorId, courseId)
   if (!enrollment) throw new AppError(404, 'COURSE_NOT_FOUND', 'Course was not found')
   const modules = await repository.listLearnerModules(actorId, courseId)
   return {
      course: {
         id: courseId,
         title: enrollment.title,
         ...safeCardMetadata(enrollment),
         enrollment: safeEnrollmentWindow(enrollment),
      },
      modules: modules.map((module) => safeLearnerModule(enrollment, module)),
   }
}

// Reusable guard for protected content (lessons, assets, tests). It is the single API-side
// entry to the database predicate; the caller must already have an authenticated live session.
async function requireModuleAccessService(userId, moduleIdValue, overrides) {
   const { repository } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const moduleId = parseId(moduleIdValue, 'INVALID_MODULE_ID', 'Module identifier is invalid')
   if (!await repository.canAccessModule(actorId, moduleId)) {
      throw new AppError(403, 'MODULE_ACCESS_DENIED', 'You do not have access to this module')
   }
}

export {
   listLearnerCourseModulesService,
   listLearnerCoursesService,
   requireModuleAccessService,
}
