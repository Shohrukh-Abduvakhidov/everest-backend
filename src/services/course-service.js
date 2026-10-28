import * as authRepository from '../repositories/auth-repository.js'
import * as courseRepository from '../repositories/course-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import AppError from '../utils/app-error.js'
import { normalizeInternalId } from '../utils/internal-id.js'

const languages = ['tg', 'ru', 'en']
const courseFields = [
   'subjectId',
   'title',
   'description',
   'languageCode',
   'translations',
   'coverAssetId',
]
const teacherPermissionFields = [
   'canEditCourse',
   'canManageLessons',
   'canManageQuestions',
   'canManageTests',
   'canViewResults',
]

function dependencies(overrides = {}) {
   return {
      repository: overrides.repository || courseRepository,
      auth: overrides.auth || authRepository,
      transaction: overrides.transaction || withTransaction,
   }
}

function validationError(field, message = `${field} is invalid`) {
   return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ field, message }])
}

function parseId(value, code, message) {
   try {
      return normalizeInternalId(value)
   } catch {
      throw new AppError(400, code, message)
   }
}

function parseCourseId(value) {
   return parseId(value, 'INVALID_COURSE_ID', 'Course identifier is invalid')
}

function parseUserId(value) {
   return parseId(value, 'INVALID_USER_ID', 'User identifier is invalid')
}

function parseNullableId(value, field) {
   if (value === null) return null
   try {
      return normalizeInternalId(value)
   } catch {
      throw validationError(field)
   }
}

function validateBody(body, allowedFields) {
   if (!body || typeof body !== 'object' || Array.isArray(body)) throw validationError('body')
   const unknown = Object.keys(body).find((field) => !allowedFields.includes(field))
   if (unknown) throw validationError(unknown, `${unknown} is not allowed`)
}

function parseText(value, field, maximum, nullable = false) {
   if (nullable && value === null) return null
   if (typeof value !== 'string') throw validationError(field)
   const normalized = value.trim()
   if (!normalized || normalized.length > maximum) throw validationError(field)
   return normalized
}

function parseLanguage(value, fallback = null) {
   if (value === undefined) return fallback
   if (!languages.includes(value)) throw validationError('languageCode')
   return value
}

function parseTranslations(value) {
   if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw validationError('translations')
   }
   const normalized = {}
   for (const [language, translation] of Object.entries(value)) {
      if (!languages.includes(language) || !translation || typeof translation !== 'object'
         || Array.isArray(translation)) {
         throw validationError('translations')
      }
      const unknown = Object.keys(translation).find((field) => !['title', 'description'].includes(field))
      if (unknown) throw validationError('translations')
      normalized[language] = {}
      if (translation.title !== undefined) {
         normalized[language].title = parseText(translation.title, 'translations', 200)
      }
      if (translation.description !== undefined) {
         normalized[language].description = parseText(
            translation.description,
            'translations',
            5000,
            true,
         )
      }
      if (!Object.keys(normalized[language]).length) throw validationError('translations')
   }
   return normalized
}

function parsePaginationValue(value, fallback, minimum, maximum, field) {
   if (value === undefined) return fallback
   if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
      throw validationError(field)
   }
   const parsed = Number(value)
   if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
      throw validationError(field)
   }
   return parsed
}

function parsePagination(query = {}) {
   return {
      limit: parsePaginationValue(query.limit, 20, 1, 100, 'limit'),
      offset: parsePaginationValue(query.offset, 0, 0, 1000000, 'offset'),
   }
}

function safeCourse(row) {
   return {
      id: row.id,
      subjectId: row.subject_id,
      title: row.title,
      description: row.description,
      languageCode: row.language_code,
      translations: row.translations,
      coverAssetId: row.cover_asset_id,
      status: row.status,
      creatorId: row.created_by,
      ...(row.administrator === undefined ? {} : {
         relationship: {
            administrator: row.administrator,
            teacher: row.is_teacher,
            canEdit: Boolean(row.can_edit_course),
         },
      }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
   }
}

function safeTeacher(row) {
   return {
      id: row.user_id,
      firstName: row.first_name,
      lastName: row.last_name,
      avatarAssetId: row.avatar_asset_id,
      permissions: {
         editCourse: row.can_edit_course,
         manageLessons: row.can_manage_lessons,
         manageQuestions: row.can_manage_questions,
         manageTests: row.can_manage_tests,
         viewResults: row.can_view_results,
      },
   }
}

function requireCourse(row) {
   if (!row) throw new AppError(404, 'COURSE_NOT_FOUND', 'Course was not found')
   return row
}

async function validateReferences(values, repository, client) {
   if (values.hasSubjectId && values.subjectId !== null
      && !await repository.subjectExists(values.subjectId, client)) {
      throw validationError('subjectId')
   }
   if (values.hasCoverAssetId && values.coverAssetId !== null
      && !await repository.assetExists(values.coverAssetId, client)) {
      throw validationError('coverAssetId')
   }
}

function parseCourseBody(body, partial = false) {
   validateBody(body, courseFields)
   if (partial && !Object.keys(body).length) throw validationError('body')
   return {
      hasSubjectId: body.subjectId !== undefined,
      subjectId: body.subjectId === undefined ? null : parseNullableId(body.subjectId, 'subjectId'),
      title: body.title === undefined && partial ? null : parseText(body.title, 'title', 200),
      hasDescription: body.description !== undefined,
      description: body.description === undefined
         ? null
         : parseText(body.description, 'description', 5000, true),
      languageCode: parseLanguage(body.languageCode, partial ? null : 'ru'),
      hasTranslations: body.translations !== undefined,
      translations: body.translations === undefined ? {} : parseTranslations(body.translations),
      hasCoverAssetId: body.coverAssetId !== undefined,
      coverAssetId: body.coverAssetId === undefined
         ? null
         : parseNullableId(body.coverAssetId, 'coverAssetId'),
   }
}

function parsePermission(value, field, fallback) {
   if (value === undefined) return fallback
   if (typeof value !== 'boolean') throw validationError(field)
   return value
}

function parseTeacherPermissions(body, partial = false) {
   validateBody(body, partial ? teacherPermissionFields : ['userId', ...teacherPermissionFields])
   if (partial && !Object.keys(body).length) throw validationError('body')
   return {
      canEditCourse: parsePermission(body.canEditCourse, 'canEditCourse', partial ? null : false),
      canManageLessons: parsePermission(
         body.canManageLessons,
         'canManageLessons',
         partial ? null : false,
      ),
      canManageQuestions: parsePermission(
         body.canManageQuestions,
         'canManageQuestions',
         partial ? null : false,
      ),
      canManageTests: parsePermission(
         body.canManageTests,
         'canManageTests',
         partial ? null : false,
      ),
      canViewResults: parsePermission(body.canViewResults, 'canViewResults', partial ? null : false),
   }
}

async function appendAudit(auth, client, event) {
   await auth.appendAuditEvent(event, client)
}

async function listCoursesService(userId, query, overrides) {
   const { repository } = dependencies(overrides)
   const pagination = parsePagination(query)
   const rows = await repository.listVisibleCourses(parseUserId(userId), pagination)
   return {
      courses: rows.slice(0, pagination.limit).map(safeCourse),
      pagination: { ...pagination, hasMore: rows.length > pagination.limit },
   }
}

async function getCourseService(userId, courseIdValue, overrides) {
   const { repository } = dependencies(overrides)
   const row = await repository.findVisibleCourse(
      parseUserId(userId),
      parseCourseId(courseIdValue),
   )
   return safeCourse(requireCourse(row))
}

async function createCourseService(userId, body, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const values = parseCourseBody(body)
   return transaction(async (client) => {
      await validateReferences(values, repository, client)
      const course = await repository.createCourse({ ...values, actorId }, client)
      await appendAudit(auth, client, {
         actorUserId: actorId,
         subjectUserId: null,
         code: 'course.created',
         entityType: 'course',
         entityId: course.id,
         metadata: {},
      })
      return safeCourse(course)
   })
}

async function updateCourseService(userId, courseIdValue, body, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const values = parseCourseBody(body, true)
   return transaction(async (client) => {
      requireCourse(await repository.findEditableCourseForUpdate(actorId, courseId, client))
      await validateReferences(values, repository, client)
      const course = await repository.updateCourse(courseId, values, client)
      await appendAudit(auth, client, {
         actorUserId: actorId,
         subjectUserId: null,
         code: 'course.updated',
         entityType: 'course',
         entityId: courseId,
         metadata: { fields: Object.keys(body) },
      })
      return safeCourse(course)
   })
}

async function changeCourseStatusService(userId, courseIdValue, from, to, eventCode, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   return transaction(async (client) => {
      const current = requireCourse(await repository.findCourseForUpdate(courseId, client))
      if (current.status !== from) {
         throw new AppError(409, 'INVALID_COURSE_TRANSITION', 'Course lifecycle transition is not allowed')
      }
      if (to === 'published' && (!current.title.trim() || current.subject_id === null)) {
         throw new AppError(
            409,
            'COURSE_NOT_READY_FOR_PUBLICATION',
            'Course is missing required publication fields',
         )
      }
      const course = await repository.updateCourseStatus(courseId, to, client)
      await appendAudit(auth, client, {
         actorUserId: actorId,
         subjectUserId: null,
         code: eventCode,
         entityType: 'course',
         entityId: courseId,
         metadata: { fromStatus: from, toStatus: to },
      })
      return safeCourse(course)
   })
}

async function publishCourseService(userId, courseId, overrides) {
   return changeCourseStatusService(
      userId,
      courseId,
      'draft',
      'published',
      'course.published',
      overrides,
   )
}

async function unpublishCourseService(userId, courseId, overrides) {
   return changeCourseStatusService(
      userId,
      courseId,
      'published',
      'draft',
      'course.unpublished',
      overrides,
   )
}

async function listCourseTeachersService(userId, courseIdValue, overrides) {
   const { repository } = dependencies(overrides)
   const rows = await repository.listVisibleTeachers(
      parseUserId(userId),
      parseCourseId(courseIdValue),
   )
   if (!rows.length) requireCourse(null)
   return { teachers: rows.filter((row) => row.id).map(safeTeacher) }
}

async function addCourseTeacherService(userId, courseIdValue, body, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const assignment = {
      actorId,
      courseId,
      userId: parseUserId(body?.userId),
      ...parseTeacherPermissions(body),
   }
   return transaction(async (client) => {
      requireCourse(await repository.findCourseForUpdate(courseId, client))
      const teacher = await repository.findEligibleTeacherForUpdate(assignment.userId, client)
      if (!teacher || teacher.status !== 'active' || !teacher.eligible) {
         throw new AppError(409, 'COURSE_TEACHER_INELIGIBLE', 'User is not eligible for course teaching')
      }
      if (await repository.findTeacherForUpdate(courseId, assignment.userId, client)) {
         throw new AppError(409, 'COURSE_TEACHER_ALREADY_ASSIGNED', 'Teacher is already assigned to the course')
      }
      const created = await repository.createTeacher(assignment, client)
      await appendAudit(auth, client, {
         actorUserId: actorId,
         subjectUserId: assignment.userId,
         code: 'course.teacher.assigned',
         entityType: 'course',
         entityId: courseId,
         metadata: { permissions: safeTeacher(created).permissions },
      })
      return safeTeacher(created)
   })
}

async function updateCourseTeacherService(userId, courseIdValue, targetValue, body, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const targetUserId = parseUserId(targetValue)
   const permissions = parseTeacherPermissions(body, true)
   return transaction(async (client) => {
      requireCourse(await repository.findCourseForUpdate(courseId, client))
      if (!await repository.findTeacherForUpdate(courseId, targetUserId, client)) {
         throw new AppError(404, 'COURSE_TEACHER_NOT_FOUND', 'Course teacher was not found')
      }
      const updated = await repository.updateTeacher(courseId, targetUserId, permissions, client)
      await appendAudit(auth, client, {
         actorUserId: actorId,
         subjectUserId: targetUserId,
         code: 'course.teacher.updated',
         entityType: 'course',
         entityId: courseId,
         metadata: { fields: Object.keys(body) },
      })
      return safeTeacher(updated)
   })
}

async function removeCourseTeacherService(userId, courseIdValue, targetValue, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const targetUserId = parseUserId(targetValue)
   return transaction(async (client) => {
      requireCourse(await repository.findCourseForUpdate(courseId, client))
      if (!await repository.findTeacherForUpdate(courseId, targetUserId, client)) {
         throw new AppError(404, 'COURSE_TEACHER_NOT_FOUND', 'Course teacher was not found')
      }
      await repository.removeTeacher(courseId, targetUserId, client)
      await appendAudit(auth, client, {
         actorUserId: actorId,
         subjectUserId: targetUserId,
         code: 'course.teacher.removed',
         entityType: 'course',
         entityId: courseId,
         metadata: {},
      })
      return { userId: targetUserId, status: 'removed' }
   })
}

export {
   addCourseTeacherService,
   createCourseService,
   getCourseService,
   listCoursesService,
   listCourseTeachersService,
   parseCourseId,
   parsePagination,
   publishCourseService,
   removeCourseTeacherService,
   unpublishCourseService,
   updateCourseService,
   updateCourseTeacherService,
}
