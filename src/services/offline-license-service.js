import { getStorageProvider } from '../providers/storage/index.js'
import * as authRepository from '../repositories/auth-repository.js'
import * as learnerLessonRepository from '../repositories/learner-lesson-repository.js'
import * as lessonRepository from '../repositories/lesson-repository.js'
import * as offlineLicenseRepository from '../repositories/offline-license-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import AppError from '../utils/app-error.js'
import { parseCourseId, parseId, parseUserId, validateBody, validationError } from './course-service.js'
import { requireModuleAccessService } from './learner-course-service.js'
import { parseLessonId, videoPlayable } from './lesson-service.js'

const maximumLeaseMs = 3 * 24 * 60 * 60 * 1000
const maximumDevices = 2
const downloadUrlTtlSeconds = 15 * 60

function dependencies(overrides = {}) {
   return {
      offline: overrides.offline || offlineLicenseRepository,
      learner: overrides.learner || learnerLessonRepository,
      lessons: overrides.repository || lessonRepository,
      auth: overrides.auth || authRepository,
      transaction: overrides.transaction || withTransaction,
      storage: () => overrides.storage || getStorageProvider(),
      clock: overrides.clock || (() => new Date()),
      requireAccess: overrides.requireAccess || requireModuleAccessService,
   }
}

function iso(value) {
   return value === null || value === undefined ? null : new Date(value).toISOString()
}

function parseLicenseId(value) {
   return parseId(value, 'INVALID_LICENSE_ID', 'Offline license identifier is invalid')
}

function parseSessionId(value) {
   return parseId(value, 'INVALID_SESSION_ID', 'Session identifier is invalid')
}

function licenseNotFound() {
   return new AppError(404, 'OFFLINE_LICENSE_NOT_FOUND', 'Offline license was not found')
}

function offlineDenied(reason) {
   return new AppError(403, 'OFFLINE_ACCESS_DENIED', 'Offline access is no longer allowed; delete the downloaded files', [
      { reason },
   ])
}

function licenseStatus(row) {
   if (row.revoked_at) return 'revoked'
   return row.is_active ? 'active' : 'expired'
}

function safeLicense(row) {
   return {
      id: row.id,
      courseId: row.course_id,
      lessonId: row.lesson_id,
      status: licenseStatus(row),
      grantedAt: iso(row.granted_at),
      renewedAt: iso(row.renewed_at),
      lastCheckedAt: iso(row.last_checked_at),
      leaseExpiresAt: iso(row.lease_expires_at),
      deviceLabel: row.device_label,
      revokeReason: row.revoke_reason,
   }
}

function parseDeviceLabel(body) {
   const value = body === undefined ? {} : body
   validateBody(value, ['deviceLabel'])
   if (value.deviceLabel === undefined || value.deviceLabel === null) return null
   if (typeof value.deviceLabel !== 'string') throw validationError('deviceLabel')
   const label = value.deviceLabel.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()
   if (!label || label.length > 100) throw validationError('deviceLabel')
   return label
}

// Every check that must hold for a learner to keep an offline copy. Returns the
// playable asset, or a stable reason code the PWA uses to delete its files.
async function evaluateOfflineAccess(deps, actorId, lesson) {
   if (!lesson) return { reason: 'lesson_unavailable' }
   try {
      await deps.requireAccess(actorId, lesson.module_id)
   } catch (error) {
      if (error.code === 'MODULE_ACCESS_DENIED') return { reason: 'module_access' }
      throw error
   }
   if (!lesson.allow_offline) return { reason: 'offline_not_allowed' }
   const asset = lesson.video_asset_id && await deps.lessons.findAsset(lesson.video_asset_id)
   if (!videoPlayable(asset)) return { reason: 'video_unavailable' }
   return { asset }
}

// The lease never exceeds 3 days, the enrollment expiry or the module grant expiry.
function computeLease(now, window) {
   const limits = [now.getTime() + maximumLeaseMs]
   if (window.enrollment_expires_at) limits.push(new Date(window.enrollment_expires_at).getTime())
   if (window.grant_expires_at) limits.push(new Date(window.grant_expires_at).getTime())
   return new Date(Math.min(...limits))
}

async function issueDownload(deps, asset) {
   const url = await deps.storage().presignDownload({
      key: asset.storage_key,
      expiresIn: downloadUrlTtlSeconds,
      contentType: asset.mime_type,
      fileName: asset.file_name,
      disposition: 'attachment',
   })
   return {
      url,
      expiresAt: new Date(deps.clock().getTime() + downloadUrlTtlSeconds * 1000).toISOString(),
      mimeType: asset.mime_type,
      sizeBytes: Number(asset.size_bytes),
   }
}

async function auditOffline(deps, actorId, subjectId, code, licenseId, metadata, client) {
   await deps.auth.appendAuditEvent({
      actorUserId: actorId,
      subjectUserId: subjectId,
      code,
      entityType: licenseId ? 'offline_download' : 'lesson',
      entityId: licenseId || metadata.lessonId,
      metadata,
   }, client)
}

async function issueOfflineLicenseService(userId, sessionIdValue, courseIdValue, lessonIdValue, body, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const sessionId = parseSessionId(sessionIdValue)
   const courseId = parseCourseId(courseIdValue)
   const lessonId = parseLessonId(lessonIdValue)
   const deviceLabel = parseDeviceLabel(body)
   const lesson = await deps.learner.findLearnerLesson(actorId, courseId, lessonId)
   if (!lesson) throw new AppError(404, 'LESSON_NOT_FOUND', 'Lesson was not found')
   const outcome = await deps.transaction(async (client) => {
      await deps.learner.lockUser(actorId, client)
      const access = await evaluateOfflineAccess(deps, actorId, lesson)
      const existing = lesson.video_asset_id
         ? await deps.offline.findSessionLicenseForUpdate(sessionId, lessonId, lesson.video_asset_id, client)
         : null
      const adminRevoked = existing?.revoked_at && existing.revoke_reason !== 'user_deleted'
      const reason = access.reason || (adminRevoked ? 'license_revoked' : null)
      if (reason) {
         if (existing?.is_active) {
            await deps.offline.revokeLicense(existing.id, actorId, 'access_lost', client)
         }
         await auditOffline(deps, actorId, actorId, 'lesson.offline.denied', existing?.id, {
            courseId,
            lessonId,
            reason,
         }, client)
         return { denied: reason }
      }
      const window = await deps.offline.findAccessWindow(actorId, lesson.module_id, client)
      if (!window) return { denied: 'module_access' }
      const now = deps.clock()
      const lease = computeLease(now, window)
      if (lease.getTime() <= now.getTime()) return { denied: 'module_access' }
      const devices = await deps.offline.listActiveDeviceSessions(actorId, client)
      if (!devices.includes(sessionId) && devices.length >= maximumDevices) {
         throw new AppError(409, 'OFFLINE_DEVICE_LIMIT', 'Offline downloads are limited to two devices', [
            { maximumDevices },
         ])
      }
      let licenseId
      if (existing) {
         await deps.offline.renewLicense(existing.id, lease.toISOString(), deviceLabel, client)
         licenseId = existing.id
      } else {
         licenseId = (await deps.offline.insertLicense({
            userId: actorId,
            sessionId,
            lessonId,
            assetId: lesson.video_asset_id,
            leaseExpiresAt: lease.toISOString(),
            deviceLabel,
         }, client)).id
      }
      await auditOffline(
         deps,
         actorId,
         actorId,
         existing ? 'lesson.offline.renewed' : 'lesson.offline.granted',
         licenseId,
         { courseId, lessonId, leaseExpiresAt: lease.toISOString() },
         client,
      )
      return { licenseId, asset: access.asset }
   })
   if (outcome.denied) throw offlineDenied(outcome.denied)
   return {
      license: safeLicense(await deps.offline.findLicense(outcome.licenseId)),
      download: await issueDownload(deps, outcome.asset),
   }
}

async function listSessionOfflineLicensesService(userId, sessionIdValue, overrides) {
   const deps = dependencies(overrides)
   const rows = await deps.offline.listSessionLicenses(parseUserId(userId), parseSessionId(sessionIdValue))
   return { licenses: rows.map(safeLicense) }
}

// Licenses are managed from the device that holds them; another device is freed by
// signing that session out.
async function requireOwnSessionLicense(license, actorId, sessionId) {
   if (!license || license.user_id !== actorId || license.session_id !== sessionId) {
      throw licenseNotFound()
   }
   return license
}

async function getOfflineLicenseDownloadService(userId, sessionIdValue, licenseIdValue, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const sessionId = parseSessionId(sessionIdValue)
   const licenseId = parseLicenseId(licenseIdValue)
   const license = await requireOwnSessionLicense(await deps.offline.findLicense(licenseId), actorId, sessionId)
   const lesson = await deps.learner.findLearnerLesson(actorId, license.course_id, license.lesson_id)
   if (!license.is_active) {
      // A license revoked because access was lost reports the current cause, e.g.
      // video_unavailable after the lesson video was replaced.
      if (license.revoke_reason === 'access_lost') {
         const lost = await evaluateOfflineAccess(deps, actorId, lesson)
         const replaced = !lost.reason && lost.asset.id !== license.asset_id
         throw offlineDenied(lost.reason || (replaced ? 'video_unavailable' : 'license_revoked'))
      }
      throw offlineDenied(license.revoked_at ? 'license_revoked' : 'license_expired')
   }
   const access = await evaluateOfflineAccess(deps, actorId, lesson)
   const reason = access.reason
      || (access.asset.id !== license.asset_id ? 'video_unavailable' : null)
   await deps.transaction(async (client) => {
      const current = await deps.offline.findLicenseForUpdate(licenseId, client)
      if (reason) {
         if (current.is_active) await deps.offline.revokeLicense(licenseId, actorId, 'access_lost', client)
         await auditOffline(deps, actorId, actorId, 'lesson.offline.denied', licenseId, {
            courseId: license.course_id,
            lessonId: license.lesson_id,
            reason,
         }, client)
      } else {
         await deps.offline.touchLicense(licenseId, client)
      }
   })
   if (reason) throw offlineDenied(reason)
   return { license: safeLicense(license), download: await issueDownload(deps, access.asset) }
}

async function deleteOfflineLicenseService(userId, sessionIdValue, licenseIdValue, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const sessionId = parseSessionId(sessionIdValue)
   const licenseId = parseLicenseId(licenseIdValue)
   await deps.transaction(async (client) => {
      const license = await requireOwnSessionLicense(
         await deps.offline.findLicenseForUpdate(licenseId, client),
         actorId,
         sessionId,
      )
      if (license.revoked_at) return
      await deps.offline.revokeLicense(licenseId, actorId, 'user_deleted', client)
      await auditOffline(deps, actorId, actorId, 'lesson.offline.deleted', licenseId, {
         courseId: license.course_id,
         lessonId: license.lesson_id,
      }, client)
   })
   return { license: safeLicense(await deps.offline.findLicense(licenseId)) }
}

async function listUserOfflineLicensesService(actorIdValue, userIdValue, overrides) {
   const deps = dependencies(overrides)
   parseUserId(actorIdValue)
   const rows = await deps.offline.listUserLicenses(parseUserId(userIdValue))
   return { licenses: rows.map((row) => ({ ...safeLicense(row), sessionId: row.session_id })) }
}

async function revokeOfflineLicenseService(actorIdValue, licenseIdValue, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(actorIdValue)
   const licenseId = parseLicenseId(licenseIdValue)
   await deps.transaction(async (client) => {
      const license = await deps.offline.findLicenseForUpdate(licenseId, client)
      if (!license) throw licenseNotFound()
      if (license.revoked_at) return
      await deps.offline.revokeLicense(licenseId, actorId, 'admin_revoked', client)
      await auditOffline(deps, actorId, license.user_id, 'lesson.offline.revoked', licenseId, {
         courseId: license.course_id,
         lessonId: license.lesson_id,
      }, client)
   })
   return { license: safeLicense(await deps.offline.findLicense(licenseId)) }
}

export {
   deleteOfflineLicenseService,
   getOfflineLicenseDownloadService,
   issueOfflineLicenseService,
   listSessionOfflineLicensesService,
   listUserOfflineLicensesService,
   revokeOfflineLicenseService,
}
