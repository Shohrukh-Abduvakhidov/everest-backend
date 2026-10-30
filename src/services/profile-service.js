import * as authRepository from '../repositories/auth-repository.js'
import * as profileRepository from '../repositories/profile-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import AppError from '../utils/app-error.js'
import { normalizeInternalId } from '../utils/internal-id.js'

const editableFields = ['firstName', 'lastName', 'preferredLanguage', 'timezone']
const languageToDatabase = { en: 'en', ru: 'ru', tj: 'tg' }
const languageToApi = { en: 'en', ru: 'ru', tg: 'tj' }

function dependencies(overrides = {}) {
   return {
      auth: overrides.auth || authRepository,
      repository: overrides.repository || profileRepository,
      transaction: overrides.transaction || withTransaction,
   }
}

function normalizeName(value, field) {
   if (value === null) return null
   if (typeof value !== 'string') {
      throw validationError(field, `${field} must be a string or null`)
   }
   const normalized = value.trim().replace(/\s+/g, ' ')
   if (normalized.length === 0 || normalized.length > 100) {
      throw validationError(field, `${field} must contain 1 to 100 characters`)
   }
   return normalized
}

function validationError(field, message) {
   return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [
      { field, message },
   ])
}

function normalizeTimezone(value) {
   if (typeof value !== 'string') {
      throw validationError('timezone', 'timezone must be a valid IANA time zone')
   }
   const timezone = value.trim()
   if (timezone.length === 0 || timezone.length > 64) {
      throw validationError('timezone', 'timezone must be a valid IANA time zone')
   }
   try {
      new Intl.DateTimeFormat('en', { timeZone: timezone }).format()
   } catch {
      throw validationError('timezone', 'timezone must be a valid IANA time zone')
   }
   return timezone
}

function parseProfileChanges(body) {
   if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw validationError('body', 'body must be an object')
   }
   const fields = Object.keys(body)
   const unknown = fields.find((field) => !editableFields.includes(field))
   if (unknown) throw validationError(unknown, `${unknown} is not editable`)
   if (fields.length === 0) throw validationError('body', 'at least one editable field is required')

   const changes = {
      hasFirstName: Object.hasOwn(body, 'firstName'),
      hasLastName: Object.hasOwn(body, 'lastName'),
      hasPreferredLanguage: Object.hasOwn(body, 'preferredLanguage'),
      hasTimezone: Object.hasOwn(body, 'timezone'),
   }
   if (changes.hasFirstName) changes.firstName = normalizeName(body.firstName, 'firstName')
   if (changes.hasLastName) changes.lastName = normalizeName(body.lastName, 'lastName')
   if (changes.hasPreferredLanguage) {
      if (typeof body.preferredLanguage !== 'string' || !languageToDatabase[body.preferredLanguage]) {
         throw validationError('preferredLanguage', 'preferredLanguage must be ru, tj, or en')
      }
      changes.preferredLanguage = languageToDatabase[body.preferredLanguage]
   }
   if (changes.hasTimezone) changes.timezone = normalizeTimezone(body.timezone)
   changes.changedFields = fields
   return changes
}

function onboardingState(row) {
   const missingRequiredFields = []
   if (!row.first_name) missingRequiredFields.push('firstName')
   if (!row.last_name) missingRequiredFields.push('lastName')
   return {
      state: row.onboarding_completed_at ? 'completed' : 'incomplete',
      completedSteps: ['firstName', 'lastName'].filter(
         (field) => !missingRequiredFields.includes(field),
      ),
      missingRequiredFields,
      canComplete:
         row.status === 'active'
         && !row.onboarding_completed_at
         && missingRequiredFields.length === 0,
      completedAt: row.onboarding_completed_at,
   }
}

function safeProfile(row) {
   const names = [row.first_name, row.last_name].filter(Boolean)
   return {
      id: row.id,
      firstName: row.first_name,
      lastName: row.last_name,
      displayName: names.length ? names.join(' ') : null,
      phone: row.phone_e164,
      telegramLinked: row.telegram_linked,
      avatarAssetId: row.avatar_asset_id,
      status: row.status,
      roles: row.roles,
      preferredLanguage: languageToApi[row.language_code],
      timezone: row.timezone,
      onboarding: onboardingState(row),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
   }
}

function requireProfile(row) {
   if (!row) throw new AppError(404, 'PROFILE_NOT_FOUND', 'Profile was not found')
   return row
}

async function getOwnProfileService(userId, overrides) {
   const { repository } = dependencies(overrides)
   const row = requireProfile(await repository.findOwnProfile(normalizeInternalId(userId)))
   return safeProfile(row)
}

async function updateProfile(userId, body, eventCode, overrides) {
   const { auth, repository, transaction } = dependencies(overrides)
   const normalizedUserId = normalizeInternalId(userId)
   const changes = parseProfileChanges(body)
   return transaction(async (client) => {
      requireProfile(await repository.findOwnProfileForUpdate(normalizedUserId, client))
      await repository.updateOwnProfile(normalizedUserId, changes, client)
      await auth.appendAuditEvent(
         {
            actorUserId: normalizedUserId,
            subjectUserId: normalizedUserId,
            code: eventCode,
            entityType: 'user_profile',
            entityId: normalizedUserId,
            metadata: { fields: changes.changedFields },
         },
         client,
      )
      return safeProfile(requireProfile(await repository.findOwnProfile(normalizedUserId, client)))
   })
}

async function updateOwnProfileService(userId, body, overrides) {
   return updateProfile(userId, body, 'profile.updated', overrides)
}

async function getOnboardingService(userId, overrides) {
   const { repository } = dependencies(overrides)
   const row = requireProfile(await repository.findOwnProfile(normalizeInternalId(userId)))
   return onboardingState(row)
}

async function updateOnboardingService(userId, body, overrides) {
   const updated = await updateProfile(userId, body, 'profile.onboarding.updated', overrides)
   return updated.onboarding
}

async function completeOnboardingService(userId, overrides) {
   const { auth, repository, transaction } = dependencies(overrides)
   const normalizedUserId = normalizeInternalId(userId)
   return transaction(async (client) => {
      const current = requireProfile(
         await repository.findOwnProfileForUpdate(normalizedUserId, client),
      )
      if (current.status !== 'active') {
         throw new AppError(409, 'ACCOUNT_NOT_ACTIVE', 'Account is not active')
      }
      const state = onboardingState(current)
      if (current.onboarding_completed_at) return state
      if (state.missingRequiredFields.length) {
         throw new AppError(409, 'ONBOARDING_INCOMPLETE', 'Onboarding is incomplete', [
            { field: 'missingRequiredFields', values: state.missingRequiredFields },
         ])
      }
      const completed = await repository.completeOnboarding(normalizedUserId, client)
      await auth.appendAuditEvent(
         {
            actorUserId: normalizedUserId,
            subjectUserId: normalizedUserId,
            code: 'profile.onboarding.completed',
            entityType: 'user',
            entityId: normalizedUserId,
            metadata: {},
         },
         client,
      )
      return onboardingState({ ...current, ...completed })
   })
}

export {
   completeOnboardingService,
   getOnboardingService,
   getOwnProfileService,
   parseProfileChanges,
   updateOnboardingService,
   updateOwnProfileService,
}
