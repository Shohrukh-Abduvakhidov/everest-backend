import * as authRepository from '../repositories/auth-repository.js'
import * as courseAccessRepository from '../repositories/course-access-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import AppError from '../utils/app-error.js'
import {
   parseCourseId,
   parseId,
   parsePagination,
   parseUserId,
   validateBody,
   validationError,
} from './course-service.js'

const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/
const latestAccessYear = 2100

function dependencies(overrides = {}) {
   return {
      repository: overrides.repository || courseAccessRepository,
      auth: overrides.auth || authRepository,
      transaction: overrides.transaction || withTransaction,
      clock: overrides.clock || (() => new Date()),
   }
}

function parseModuleId(value, field = 'moduleId') {
   try {
      return parseId(value, 'INVALID_MODULE_ID', 'Module identifier is invalid')
   } catch {
      throw validationError(field)
   }
}

function parseTimestamp(value, field) {
   if (typeof value !== 'string' || !isoTimestampPattern.test(value)) throw validationError(field)
   const parsed = new Date(value)
   if (Number.isNaN(parsed.getTime()) || parsed.getUTCFullYear() > latestAccessYear) {
      throw validationError(field)
   }
   return parsed
}

// expiresAt must be present on every grant so an unlimited grant is an explicit choice
// (null), never the result of an omitted field.
function parseWindow(body, now) {
   if (body.expiresAt === undefined) throw validationError('expiresAt', 'expiresAt is required')
   const beginsAt = body.beginsAt === undefined
      ? now
      : parseTimestamp(body.beginsAt, 'beginsAt')
   const expiresAt = body.expiresAt === null ? null : parseTimestamp(body.expiresAt, 'expiresAt')
   assertExpiryAfter(expiresAt, beginsAt, now)
   return { beginsAt: beginsAt.toISOString(), expiresAt: expiresAt && expiresAt.toISOString() }
}

function assertExpiryAfter(expiresAt, beginsAt, now) {
   if (expiresAt === null) return
   if (expiresAt.getTime() <= now.getTime() || expiresAt.getTime() <= beginsAt.getTime()) {
      throw validationError('expiresAt', 'expiresAt must be in the future and after beginsAt')
   }
}

function parseExtendBody(body, now, beginsAt) {
   validateBody(body, ['expiresAt'])
   if (body.expiresAt === undefined) throw validationError('expiresAt', 'expiresAt is required')
   const expiresAt = body.expiresAt === null ? null : parseTimestamp(body.expiresAt, 'expiresAt')
   assertExpiryAfter(expiresAt, beginsAt, now)
   return expiresAt && expiresAt.toISOString()
}

function parseEnrollmentState(value, repository) {
   if (value === undefined) return null
   if (typeof value !== 'string' || !repository.enrollmentStates.includes(value)) {
      throw validationError('state')
   }
   return value
}

function iso(value) {
   return value === null ? null : new Date(value).toISOString()
}

function safeGrant(row) {
   return {
      state: row.state,
      grantedBy: row.granted_by,
      grantedAt: iso(row.granted_at),
      beginsAt: iso(row.begins_at),
      expiresAt: iso(row.expires_at),
      revokedAt: iso(row.revoked_at),
      revokedBy: row.revoked_by,
   }
}

function safeEnrollment(row) {
   return {
      id: row.id,
      userId: row.user_id,
      courseId: row.course_id,
      ...(row.first_name === undefined ? {} : {
         user: { firstName: row.first_name, lastName: row.last_name },
      }),
      ...safeGrant(row),
   }
}

function safeModuleGrant(row) {
   return {
      id: row.id,
      userId: row.user_id,
      courseId: row.course_id,
      moduleId: row.module_id,
      ...(row.module_title === undefined ? {} : { moduleTitle: row.module_title }),
      ...safeGrant(row),
   }
}

function conflict(code, message) {
   return new AppError(409, code, message)
}

async function requireCourseExists(repository, courseId) {
   if (!await repository.findCourseStatus(courseId)) {
      throw new AppError(404, 'COURSE_NOT_FOUND', 'Course was not found')
   }
}

async function requirePublishedCourse(repository, courseId, client) {
   const course = await repository.findCourseForShare(courseId, client)
   if (!course) throw new AppError(404, 'COURSE_NOT_FOUND', 'Course was not found')
   if (course.status !== 'published') {
      throw conflict('COURSE_NOT_PUBLISHED', 'Access can only be granted for a published course')
   }
}

function requireEnrollment(row) {
   if (!row) throw new AppError(404, 'ENROLLMENT_NOT_FOUND', 'Course enrollment was not found')
   return row
}

function requireModuleGrant(row) {
   if (!row) throw new AppError(404, 'MODULE_ACCESS_NOT_FOUND', 'Module access grant was not found')
   return row
}

async function listCourseEnrollmentsService(userId, courseIdValue, query = {}, overrides) {
   const { repository } = dependencies(overrides)
   parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const pagination = parsePagination(query)
   const state = parseEnrollmentState(query.state, repository)
   await requireCourseExists(repository, courseId)
   const rows = await repository.listEnrollments(courseId, { ...pagination, state })
   return {
      enrollments: rows.slice(0, pagination.limit).map(safeEnrollment),
      pagination: { ...pagination, hasMore: rows.length > pagination.limit },
   }
}

async function grantCourseEnrollmentService(userId, courseIdValue, body, overrides) {
   const { repository, auth, transaction, clock } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   validateBody(body, ['userId', 'beginsAt', 'expiresAt'])
   let targetId
   try {
      targetId = parseId(body.userId, 'INVALID_USER_ID', 'User identifier is invalid')
   } catch {
      throw validationError('userId')
   }
   const window = parseWindow(body, clock())
   return transaction(async (client) => {
      await requirePublishedCourse(repository, courseId, client)
      const grantee = await repository.findGranteeForShare(targetId, client)
      if (!grantee) throw new AppError(404, 'USER_NOT_FOUND', 'User was not found')
      if (grantee.status !== 'active' || !grantee.is_student) {
         throw conflict(
            'ENROLLMENT_USER_INELIGIBLE',
            'Only active student accounts can be enrolled',
         )
      }
      const existing = await repository.findEnrollmentForUpdate(courseId, targetId, client)
      if (existing && existing.state !== 'revoked') {
         throw conflict('ENROLLMENT_ALREADY_EXISTS', 'User already has a course enrollment')
      }
      const values = { actorId, userId: targetId, courseId, ...window }
      const written = existing
         ? await repository.regrantEnrollment(existing.id, values, client)
         : await repository.insertEnrollment(values, client)
      if (!written) {
         throw conflict('ENROLLMENT_ALREADY_EXISTS', 'User already has a course enrollment')
      }
      await auth.appendAuditEvent({
         actorUserId: actorId,
         subjectUserId: targetId,
         code: existing ? 'course.enrollment.regranted' : 'course.enrollment.granted',
         entityType: 'course_enrollment',
         entityId: written.id,
         metadata: { courseId, ...window },
      }, client)
      return safeEnrollment(await repository.findEnrollmentForUpdate(courseId, targetId, client))
   })
}

async function extendCourseEnrollmentService(userId, courseIdValue, targetValue, body, overrides) {
   const { repository, auth, transaction, clock } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const targetId = parseUserId(targetValue)
   validateBody(body, ['expiresAt'])
   return transaction(async (client) => {
      const current = requireEnrollment(
         await repository.findEnrollmentForUpdate(courseId, targetId, client),
      )
      if (current.state === 'revoked') {
         throw conflict('ENROLLMENT_REVOKED', 'A revoked enrollment must be granted again')
      }
      const expiresAt = parseExtendBody(body, clock(), new Date(current.begins_at))
      await repository.updateEnrollmentExpiry(current.id, expiresAt, client)
      await auth.appendAuditEvent({
         actorUserId: actorId,
         subjectUserId: targetId,
         code: 'course.enrollment.extended',
         entityType: 'course_enrollment',
         entityId: current.id,
         metadata: { courseId, previousExpiresAt: iso(current.expires_at), expiresAt },
      }, client)
      return safeEnrollment(await repository.findEnrollmentForUpdate(courseId, targetId, client))
   })
}

// Revoking an enrollment also revokes its module grants in the same transaction so a later
// re-grant of the course can never silently restore module access.
async function revokeCourseEnrollmentService(userId, courseIdValue, targetValue, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const targetId = parseUserId(targetValue)
   return transaction(async (client) => {
      const current = requireEnrollment(
         await repository.findEnrollmentForUpdate(courseId, targetId, client),
      )
      if (current.state === 'revoked') {
         throw conflict('ENROLLMENT_ALREADY_REVOKED', 'Course enrollment is already revoked')
      }
      await repository.revokeEnrollment(current.id, actorId, client)
      const revokedModuleGrants = await repository.revokeActiveModuleGrantsForEnrollment(
         courseId,
         targetId,
         actorId,
         client,
      )
      await auth.appendAuditEvent({
         actorUserId: actorId,
         subjectUserId: targetId,
         code: 'course.enrollment.revoked',
         entityType: 'course_enrollment',
         entityId: current.id,
         metadata: { courseId, revokedModuleGrants },
      }, client)
      return safeEnrollment(await repository.findEnrollmentForUpdate(courseId, targetId, client))
   })
}

async function listModuleAccessGrantsService(userId, courseIdValue, targetValue, overrides) {
   const { repository } = dependencies(overrides)
   parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const targetId = parseUserId(targetValue)
   requireEnrollment(await repository.findEnrollment(courseId, targetId))
   const rows = await repository.listModuleGrants(courseId, targetId)
   return { moduleGrants: rows.map(safeModuleGrant) }
}

async function grantModuleAccessService(userId, courseIdValue, targetValue, body, overrides) {
   const { repository, auth, transaction, clock } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const targetId = parseUserId(targetValue)
   validateBody(body, ['moduleId', 'beginsAt', 'expiresAt'])
   const moduleId = parseModuleId(body.moduleId)
   const window = parseWindow(body, clock())
   return transaction(async (client) => {
      await requirePublishedCourse(repository, courseId, client)
      const module = await repository.findModuleForShare(courseId, moduleId, client)
      if (!module) throw new AppError(404, 'COURSE_MODULE_NOT_FOUND', 'Course module was not found')
      if (module.status !== 'published') {
         throw conflict('MODULE_NOT_PUBLISHED', 'Access can only be granted for a published module')
      }
      const enrollment = requireEnrollment(
         await repository.findEnrollmentForUpdate(courseId, targetId, client),
      )
      if (enrollment.state !== 'active' && enrollment.state !== 'scheduled') {
         throw conflict(
            'ENROLLMENT_NOT_ACTIVE',
            'Module access requires a current course enrollment',
         )
      }
      const existing = await repository.findModuleGrantForUpdate(
         targetId,
         moduleId,
         courseId,
         client,
      )
      if (existing && existing.state !== 'revoked') {
         throw conflict('MODULE_ACCESS_ALREADY_EXISTS', 'User already has a grant for this module')
      }
      const values = { actorId, userId: targetId, courseId, moduleId, ...window }
      const written = existing
         ? await repository.regrantModuleGrant(existing.id, values, client)
         : await repository.insertModuleGrant(values, client)
      if (!written) {
         throw conflict('MODULE_ACCESS_ALREADY_EXISTS', 'User already has a grant for this module')
      }
      await auth.appendAuditEvent({
         actorUserId: actorId,
         subjectUserId: targetId,
         code: existing ? 'course.module_access.regranted' : 'course.module_access.granted',
         entityType: 'module_access_grant',
         entityId: written.id,
         metadata: { courseId, moduleId, ...window },
      }, client)
      return safeModuleGrant(
         await repository.findModuleGrantForUpdate(targetId, moduleId, courseId, client),
      )
   })
}

async function extendModuleAccessService(
   userId,
   courseIdValue,
   targetValue,
   moduleValue,
   body,
   overrides,
) {
   const { repository, auth, transaction, clock } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const targetId = parseUserId(targetValue)
   const moduleId = parseModuleId(moduleValue)
   validateBody(body, ['expiresAt'])
   return transaction(async (client) => {
      requireEnrollment(await repository.findEnrollmentForUpdate(courseId, targetId, client))
      const current = requireModuleGrant(
         await repository.findModuleGrantForUpdate(targetId, moduleId, courseId, client),
      )
      if (current.state === 'revoked') {
         throw conflict('MODULE_ACCESS_REVOKED', 'A revoked module grant must be granted again')
      }
      const expiresAt = parseExtendBody(body, clock(), new Date(current.begins_at))
      await repository.updateModuleGrantExpiry(current.id, expiresAt, client)
      await auth.appendAuditEvent({
         actorUserId: actorId,
         subjectUserId: targetId,
         code: 'course.module_access.extended',
         entityType: 'module_access_grant',
         entityId: current.id,
         metadata: { courseId, moduleId, previousExpiresAt: iso(current.expires_at), expiresAt },
      }, client)
      return safeModuleGrant(
         await repository.findModuleGrantForUpdate(targetId, moduleId, courseId, client),
      )
   })
}

async function revokeModuleAccessService(
   userId,
   courseIdValue,
   targetValue,
   moduleValue,
   overrides,
) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const targetId = parseUserId(targetValue)
   const moduleId = parseModuleId(moduleValue)
   return transaction(async (client) => {
      requireEnrollment(await repository.findEnrollmentForUpdate(courseId, targetId, client))
      const current = requireModuleGrant(
         await repository.findModuleGrantForUpdate(targetId, moduleId, courseId, client),
      )
      if (current.state === 'revoked') {
         throw conflict('MODULE_ACCESS_ALREADY_REVOKED', 'Module access grant is already revoked')
      }
      await repository.revokeModuleGrant(current.id, actorId, client)
      await auth.appendAuditEvent({
         actorUserId: actorId,
         subjectUserId: targetId,
         code: 'course.module_access.revoked',
         entityType: 'module_access_grant',
         entityId: current.id,
         metadata: { courseId, moduleId },
      }, client)
      return safeModuleGrant(
         await repository.findModuleGrantForUpdate(targetId, moduleId, courseId, client),
      )
   })
}

export {
   extendCourseEnrollmentService,
   extendModuleAccessService,
   grantCourseEnrollmentService,
   grantModuleAccessService,
   listCourseEnrollmentsService,
   listModuleAccessGrantsService,
   revokeCourseEnrollmentService,
   revokeModuleAccessService,
}
