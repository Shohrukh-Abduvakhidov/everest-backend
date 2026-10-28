import * as authRepository from '../repositories/auth-repository.js'
import * as courseModuleRepository from '../repositories/course-module-repository.js'
import * as courseRepository from '../repositories/course-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import AppError from '../utils/app-error.js'
import {
   parseCourseId,
   parseId,
   parseText,
   parseTranslations,
   parseUserId,
   requireCourse,
   safeCourse,
   validateBody,
   validationError,
} from './course-service.js'

const moduleFields = ['title', 'description', 'translations']
const copySuffix = ' (copy)'
const maximumTitleLength = 200
const maximumModulesPerOrder = 1000

function dependencies(overrides = {}) {
   return {
      repository: overrides.repository || courseModuleRepository,
      courses: overrides.courses || courseRepository,
      auth: overrides.auth || authRepository,
      transaction: overrides.transaction || withTransaction,
   }
}

function parseModuleId(value) {
   return parseId(value, 'INVALID_MODULE_ID', 'Module identifier is invalid')
}

function requireModule(row) {
   if (!row) throw new AppError(404, 'COURSE_MODULE_NOT_FOUND', 'Course module was not found')
   return row
}

function safeModule(row) {
   return {
      id: row.id,
      courseId: row.course_id,
      title: row.title,
      description: row.description,
      translations: row.translations,
      position: row.position,
      status: row.status,
      createdAt: row.created_at,
   }
}

function safePreviewModule(row) {
   return {
      id: row.id,
      title: row.title,
      description: row.description,
      position: row.position,
      status: row.status,
      lessonsCount: row.lessons_count,
      testsCount: row.tests_count,
   }
}

function parseModuleBody(body, partial = false) {
   validateBody(body, moduleFields)
   if (partial && !Object.keys(body).length) throw validationError('body')
   return {
      title: body.title === undefined && partial
         ? null
         : parseText(body.title, 'title', maximumTitleLength),
      hasDescription: body.description !== undefined,
      description: body.description === undefined
         ? null
         : parseText(body.description, 'description', 5000, true),
      hasTranslations: body.translations !== undefined,
      translations: body.translations === undefined ? {} : parseTranslations(body.translations),
   }
}

function parseModuleOrder(body) {
   validateBody(body, ['moduleIds'])
   const { moduleIds } = body
   if (!Array.isArray(moduleIds) || !moduleIds.length || moduleIds.length > maximumModulesPerOrder) {
      throw validationError('moduleIds')
   }
   const normalized = moduleIds.map((value) => {
      try {
         return parseModuleId(value)
      } catch {
         throw validationError('moduleIds')
      }
   })
   if (new Set(normalized).size !== normalized.length) {
      throw validationError('moduleIds', 'moduleIds must not contain duplicates')
   }
   return normalized
}

function defaultCopyTitle(title) {
   return `${title.slice(0, maximumTitleLength - copySuffix.length).trimEnd()}${copySuffix}`
}

function parseCopyBody(body) {
   const value = body === undefined ? {} : body
   validateBody(value, ['title'])
   return {
      title: value.title === undefined ? null : parseText(value.title, 'title', maximumTitleLength),
   }
}

async function requireEditableCourse(courses, actorId, courseId, client) {
   return requireCourse(await courses.findEditableCourseForUpdate(actorId, courseId, client))
}

// Each step copies one part of the course structure inside the copy transaction and
// returns a summary. M07 appends lesson, video, chapter and material steps that read
// context.moduleIdMap to attach copied lessons to the copied modules.
const courseCopySteps = [
   async function copyModulesStep(context) {
      const rows = await context.repository.copyModules(
         context.sourceCourseId,
         context.targetCourseId,
         context.client,
      )
      for (const row of rows) context.moduleIdMap.set(row.source_id, row.target_id)
      return { modules: rows.length }
   },
]

async function previewCourseModulesService(userId, courseIdValue, overrides) {
   const { repository, courses } = dependencies(overrides)
   const courseId = parseCourseId(courseIdValue)
   const course = requireCourse(await courses.findVisibleCourse(parseUserId(userId), courseId))
   const modules = await repository.listModulePreview(courseId)
   return {
      course: { id: course.id, title: course.title, status: course.status },
      modules: modules.map(safePreviewModule),
   }
}

async function createCourseModuleService(userId, courseIdValue, body, overrides) {
   const { repository, courses, auth, transaction } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const values = parseModuleBody(body)
   return transaction(async (client) => {
      await requireEditableCourse(courses, actorId, courseId, client)
      const position = await repository.findNextModulePosition(courseId, client)
      const module = await repository.createModule({ ...values, courseId, position }, client)
      await auth.appendAuditEvent({
         actorUserId: actorId,
         subjectUserId: null,
         code: 'course.module.created',
         entityType: 'course_module',
         entityId: module.id,
         metadata: { courseId, position },
      }, client)
      return safeModule(module)
   })
}

async function updateCourseModuleService(userId, courseIdValue, moduleIdValue, body, overrides) {
   const { repository, courses, auth, transaction } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const moduleId = parseModuleId(moduleIdValue)
   const values = parseModuleBody(body, true)
   return transaction(async (client) => {
      await requireEditableCourse(courses, actorId, courseId, client)
      requireModule(await repository.findModuleForUpdate(courseId, moduleId, client))
      const module = await repository.updateModule(moduleId, values, client)
      await auth.appendAuditEvent({
         actorUserId: actorId,
         subjectUserId: null,
         code: 'course.module.updated',
         entityType: 'course_module',
         entityId: moduleId,
         metadata: { courseId, fields: Object.keys(body) },
      }, client)
      return safeModule(module)
   })
}

async function changeModuleStatusService(
   userId,
   courseIdValue,
   moduleIdValue,
   from,
   to,
   eventCode,
   overrides,
) {
   const { repository, courses, auth, transaction } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const moduleId = parseModuleId(moduleIdValue)
   return transaction(async (client) => {
      await requireEditableCourse(courses, actorId, courseId, client)
      const current = requireModule(await repository.findModuleForUpdate(courseId, moduleId, client))
      if (current.status !== from) {
         throw new AppError(
            409,
            'INVALID_MODULE_TRANSITION',
            'Course module lifecycle transition is not allowed',
         )
      }
      const module = await repository.updateModuleStatus(moduleId, to, client)
      await auth.appendAuditEvent({
         actorUserId: actorId,
         subjectUserId: null,
         code: eventCode,
         entityType: 'course_module',
         entityId: moduleId,
         metadata: { courseId, fromStatus: from, toStatus: to },
      }, client)
      return safeModule(module)
   })
}

async function publishCourseModuleService(userId, courseId, moduleId, overrides) {
   return changeModuleStatusService(
      userId,
      courseId,
      moduleId,
      'draft',
      'published',
      'course.module.published',
      overrides,
   )
}

async function archiveCourseModuleService(userId, courseId, moduleId, overrides) {
   return changeModuleStatusService(
      userId,
      courseId,
      moduleId,
      'published',
      'archived',
      'course.module.archived',
      overrides,
   )
}

async function restoreCourseModuleService(userId, courseId, moduleId, overrides) {
   return changeModuleStatusService(
      userId,
      courseId,
      moduleId,
      'archived',
      'draft',
      'course.module.restored',
      overrides,
   )
}

async function deleteCourseModuleService(userId, courseIdValue, moduleIdValue, overrides) {
   const { repository, courses, auth, transaction } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const moduleId = parseModuleId(moduleIdValue)
   return transaction(async (client) => {
      await requireEditableCourse(courses, actorId, courseId, client)
      const current = requireModule(await repository.findModuleForUpdate(courseId, moduleId, client))
      if (current.status !== 'draft' || await repository.moduleHasLessons(moduleId, client)) {
         throw new AppError(
            409,
            'COURSE_MODULE_NOT_DELETABLE',
            'Only an empty draft module can be deleted',
         )
      }
      await repository.deleteModule(moduleId, client)
      await auth.appendAuditEvent({
         actorUserId: actorId,
         subjectUserId: null,
         code: 'course.module.deleted',
         entityType: 'course_module',
         entityId: moduleId,
         metadata: { courseId, title: current.title, position: current.position },
      }, client)
      return { id: moduleId, status: 'deleted' }
   })
}

async function reorderCourseModulesService(userId, courseIdValue, body, overrides) {
   const { repository, courses, auth, transaction } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const moduleIds = parseModuleOrder(body)
   return transaction(async (client) => {
      await requireEditableCourse(courses, actorId, courseId, client)
      const currentIds = await repository.listModuleIdsForUpdate(courseId, client)
      const current = new Set(currentIds)
      if (currentIds.length !== moduleIds.length || moduleIds.some((id) => !current.has(id))) {
         throw new AppError(
            409,
            'COURSE_MODULE_ORDER_MISMATCH',
            'Module order must list every module of the course exactly once',
         )
      }
      await repository.applyModuleOrder(courseId, moduleIds, client)
      await auth.appendAuditEvent({
         actorUserId: actorId,
         subjectUserId: null,
         code: 'course.modules.reordered',
         entityType: 'course',
         entityId: courseId,
         metadata: { previousOrder: currentIds, newOrder: moduleIds },
      }, client)
      const modules = await repository.listModules(courseId, client)
      return { modules: modules.map(safeModule) }
   })
}

async function copyCourseService(userId, courseIdValue, body, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const sourceCourseId = parseCourseId(courseIdValue)
   const values = parseCopyBody(body)
   return transaction(async (client) => {
      const source = requireCourse(await repository.findCourseForShare(sourceCourseId, client))
      const course = await repository.createCourseCopy(source, {
         title: values.title || defaultCopyTitle(source.title),
         actorId,
      }, client)
      const context = {
         client,
         repository,
         actorId,
         sourceCourseId,
         targetCourseId: course.id,
         moduleIdMap: new Map(),
      }
      const copied = {}
      for (const step of courseCopySteps) Object.assign(copied, await step(context))
      await auth.appendAuditEvent({
         actorUserId: actorId,
         subjectUserId: null,
         code: 'course.copied',
         entityType: 'course',
         entityId: course.id,
         metadata: { sourceCourseId, copied },
      }, client)
      return { course: safeCourse(course), sourceCourseId, copied }
   })
}

export {
   archiveCourseModuleService,
   copyCourseService,
   createCourseModuleService,
   deleteCourseModuleService,
   previewCourseModulesService,
   publishCourseModuleService,
   reorderCourseModulesService,
   restoreCourseModuleService,
   updateCourseModuleService,
}
