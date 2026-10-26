import * as authorizationRepository from '../repositories/authorization-repository.js'
import AppError from '../utils/app-error.js'
import { normalizeInternalId } from '../utils/internal-id.js'

const permissionCodePattern = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/

function dependencies(overrides = {}) {
   return {
      repository: overrides.repository || authorizationRepository,
   }
}

function normalizePermissionCode(value) {
   if (typeof value !== 'string' || !permissionCodePattern.test(value)) {
      throw new TypeError('Permission code is invalid')
   }

   return value
}

async function authorizePermissionService(userId, permissionCode, options = {}, overrides) {
   const { repository } = dependencies(overrides)
   const normalizedUserId = normalizeInternalId(userId)
   const normalizedPermissionCode = normalizePermissionCode(permissionCode)
   const allowed = await repository.hasPermission(normalizedUserId, normalizedPermissionCode)

   if (!allowed) {
      throw new AppError(
         403,
         options.errorCode || 'ACTION_FORBIDDEN',
         options.message || 'You are not authorized to perform this action',
      )
   }
}

export { authorizePermissionService, normalizePermissionCode }
