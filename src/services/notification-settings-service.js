import env from '../configs/env.js'
import * as authRepository from '../repositories/auth-repository.js'
import * as notificationRepository from '../repositories/notification-repository.js'
import * as telegramDeliveryRepository from '../repositories/telegram-delivery-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import AppError from '../utils/app-error.js'
import { normalizeInternalId } from '../utils/internal-id.js'
import { telegramEventCodes } from '../utils/notification-texts.js'
import { formatTime, parseTime } from '../utils/quiet-hours.js'

// D4/D5 (decisions.md 2026-11-21): in-app notifications are always on; the user controls only
// Telegram (a master switch and one switch per event) and the quiet hours.

function dependencies(overrides = {}) {
   return {
      config: overrides.config || env,
      settings: overrides.settings || telegramDeliveryRepository,
      notifications: overrides.notifications || notificationRepository,
      auth: overrides.auth || authRepository,
      transaction: overrides.transaction || withTransaction,
   }
}

function validationError(field, message = `${field} is invalid`) {
   return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ field, message }])
}

function isPlainObject(value) {
   return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseSettingsBody(body) {
   if (!isPlainObject(body)) throw validationError('body')
   const allowed = ['telegramEnabled', 'quietHours', 'events']
   const unknown = Object.keys(body).find((key) => !allowed.includes(key))
   if (unknown) throw validationError(unknown, `${unknown} is not allowed`)
   if (!Object.keys(body).length) throw validationError('body', 'at least one field is required')
   const changes = { telegramEnabled: null, hasQuietHours: false, quietStart: null, quietEnd: null, preferences: [] }
   if (body.telegramEnabled !== undefined) {
      if (typeof body.telegramEnabled !== 'boolean') throw validationError('telegramEnabled', 'telegramEnabled must be a boolean')
      changes.telegramEnabled = body.telegramEnabled
   }
   if (body.quietHours !== undefined) {
      changes.hasQuietHours = true
      if (body.quietHours !== null) {
         if (!isPlainObject(body.quietHours)
            || Object.keys(body.quietHours).some((key) => key !== 'start' && key !== 'end')) {
            throw validationError('quietHours', 'quietHours must be { start, end } or null')
         }
         const { start, end } = body.quietHours
         if (typeof start !== 'string' || start.length !== 5 || parseTime(start) === null) {
            throw validationError('quietHours.start', 'start must be HH:MM')
         }
         if (typeof end !== 'string' || end.length !== 5 || parseTime(end) === null) {
            throw validationError('quietHours.end', 'end must be HH:MM')
         }
         if (start === end) throw validationError('quietHours', 'start and end must differ')
         changes.quietStart = start
         changes.quietEnd = end
      }
   }
   if (body.events !== undefined) {
      if (!isPlainObject(body.events)) throw validationError('events', 'events must be an object')
      for (const [eventCode, value] of Object.entries(body.events)) {
         if (!telegramEventCodes.includes(eventCode)) {
            throw validationError(`events.${eventCode.slice(0, 40)}`, 'unknown event or not available on Telegram')
         }
         if (!isPlainObject(value) || Object.keys(value).length !== 1 || typeof value.telegram !== 'boolean') {
            throw validationError(`events.${eventCode}`, 'must be { telegram: boolean }')
         }
         changes.preferences.push({ eventCode, enabled: value.telegram })
      }
   }
   return changes
}

async function readSettings(deps, userId, db) {
   const row = await deps.settings.findSettings(userId, deps.config.telegram?.clientId, db)
   if (!row) throw new AppError(404, 'PROFILE_NOT_FOUND', 'Profile was not found')
   const preferences = new Map(
      (await deps.settings.listTelegramPreferences(userId, db)).map((preference) => [preference.event_code, preference.enabled]),
   )
   return {
      telegramEnabled: row.telegram_enabled,
      quietHours: row.quiet_start === null
         ? null
         : { start: formatTime(row.quiet_start), end: formatTime(row.quiet_end) },
      timeZone: row.timezone,
      messagingConnected: row.messaging_connected,
      events: Object.fromEntries(telegramEventCodes.map((eventCode) => [
         eventCode, { telegram: preferences.get(eventCode) ?? true },
      ])),
   }
}

async function requireActive(deps, userId) {
   if (!await deps.notifications.isActiveAccount(userId)) {
      throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'Account is not active')
   }
}

async function getNotificationSettingsService(userId, overrides) {
   const deps = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   await requireActive(deps, actorId)
   return readSettings(deps, actorId)
}

// Partial update. A switch turned off takes effect for queued messages too: the sender
// re-checks before every send and cancels them.
async function updateNotificationSettingsService(userId, body, overrides) {
   const deps = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const changes = parseSettingsBody(body)
   await requireActive(deps, actorId)
   return deps.transaction(async (client) => {
      await deps.settings.saveSettings(actorId, changes, client)
      await deps.settings.saveTelegramPreferences(actorId, changes.preferences, client)
      await deps.auth.appendAuditEvent({
         actorUserId: actorId,
         subjectUserId: actorId,
         code: 'notification.settings_updated',
         entityType: 'user',
         entityId: actorId,
         metadata: { fields: Object.keys(body), events: changes.preferences.map((preference) => preference.eventCode) },
      }, client)
      return readSettings(deps, actorId, client)
   })
}

export { getNotificationSettingsService, parseSettingsBody, updateNotificationSettingsService }
