import * as accountAdminRepository from '../repositories/account-admin-repository.js'
import * as authRepository from '../repositories/auth-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import AppError from '../utils/app-error.js'
import { normalizePhone } from '../utils/auth-input.js'
import { normalizeInternalId } from '../utils/internal-id.js'

const accountTransitions = {
   approve: { from: 'pending', to: 'active', event: 'admin.account.approved' },
   reject: { from: 'pending', to: 'rejected', event: 'admin.account.rejected' },
   block: { from: 'active', to: 'blocked', event: 'admin.account.blocked' },
   unblock: { from: 'blocked', to: 'active', event: 'admin.account.unblocked' },
}

function dependencies(overrides = {}) {
   return {
      repository: overrides.repository || accountAdminRepository,
      auth: overrides.auth || authRepository,
      transaction: overrides.transaction || withTransaction,
   }
}

function parseUserId(value) {
   try {
      return normalizeInternalId(value)
   } catch {
      throw new AppError(400, 'INVALID_USER_ID', 'User identifier is invalid')
   }
}

function parsePaginationValue(value, fallback, minimum, maximum, field) {
   if (value === undefined) return fallback
   const validFormat = typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)
   const parsed = validFormat ? Number(value) : NaN

   if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [
         { field, message: `${field} is invalid` },
      ])
   }

   return parsed
}

function parsePagination(query = {}) {
   return {
      limit: parsePaginationValue(query.limit, 20, 1, 100, 'limit'),
      offset: parsePaginationValue(query.offset, 0, 0, 1000000, 'offset'),
   }
}

function safeUser(row) {
   return {
      id: row.id,
      status: row.status,
      firstName: row.first_name,
      lastName: row.last_name,
      phone: row.phone_e164,
      createdAt: row.created_at,
      onboardingCompletedAt: row.onboarding_completed_at,
   }
}

function validateSelfAction(action, actorUserId, userId) {
   if (action === 'reject' && actorUserId === userId) {
      throw new AppError(409, 'SELF_REJECTION_FORBIDDEN', 'Cannot reject your own account')
   }
   if (action === 'block' && actorUserId === userId) {
      throw new AppError(409, 'SELF_BLOCK_FORBIDDEN', 'Cannot block your own account')
   }
}

async function authorizeAdministratorService(userId, overrides) {
   const { repository } = dependencies(overrides)
   const allowed = await repository.hasAdministratorRole(parseUserId(userId))
   if (!allowed) {
      throw new AppError(403, 'ADMIN_ROLE_REQUIRED', 'Administrator role is required')
   }
}

async function listPendingUsersService(query, overrides) {
   const { repository } = dependencies(overrides)
   const pagination = parsePagination(query)
   const rows = await repository.listPendingUsers(pagination)

   return {
      users: rows.slice(0, pagination.limit).map(safeUser),
      pagination: { ...pagination, hasMore: rows.length > pagination.limit },
   }
}

async function changeAccountStateService(action, actorValue, targetValue, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorUserId = parseUserId(actorValue)
   const userId = parseUserId(targetValue)
   const transition = accountTransitions[action]
   validateSelfAction(action, actorUserId, userId)

   return transaction(async (client) => {
      const current = await repository.findUserForUpdate(userId, client)
      if (!current) throw new AppError(404, 'USER_NOT_FOUND', 'User was not found')
      if (current.status !== transition.from) {
         throw new AppError(
            409,
            'INVALID_ACCOUNT_TRANSITION',
            'Account state transition is not allowed',
         )
      }

      const updated = await repository.updateAccountState({ userId, action, actorUserId }, client)
      let revokedSessions = 0

      if (action === 'block') {
         revokedSessions = await repository.revokeLiveSessions(userId, 'account_blocked', client)
         await repository.revokeUserRefreshTokens(userId, client)
      }

      await auth.appendAuditEvent(
         {
            actorUserId,
            subjectUserId: userId,
            code: transition.event,
            entityType: 'user',
            entityId: userId,
            metadata: {
               fromStatus: transition.from,
               toStatus: transition.to,
               revokedSessions,
            },
         },
         client,
      )

      return {
         action,
         user: { ...safeUser({ ...current, ...updated }), updatedAt: updated.updated_at },
         ...(action === 'block' ? { revokedSessions } : {}),
      }
   })
}

async function approveUserService(actorUserId, userId, overrides) {
   return changeAccountStateService('approve', actorUserId, userId, overrides)
}

async function rejectUserService(actorUserId, userId, overrides) {
   return changeAccountStateService('reject', actorUserId, userId, overrides)
}

async function blockUserService(actorUserId, userId, overrides) {
   return changeAccountStateService('block', actorUserId, userId, overrides)
}

async function unblockUserService(actorUserId, userId, overrides) {
   return changeAccountStateService('unblock', actorUserId, userId, overrides)
}

async function bootstrapOwnerService(phoneValue, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const phoneE164 = normalizePhone(phoneValue)

   return transaction(async (client) => {
      await repository.lockOwnerBootstrap(client)
      if (await repository.findOwnerAssignment(client)) {
         throw new AppError(409, 'OWNER_ALREADY_CONFIGURED', 'An owner is already configured')
      }

      const user = await repository.findUserByPhoneForUpdate(phoneE164, client)
      if (!user) {
         throw new AppError(404, 'BOOTSTRAP_USER_NOT_FOUND', 'Registered account was not found')
      }

      await repository.activateBootstrapOwner(user.id, client)
      await repository.assignOwnerRole(user.id, client)
      await auth.appendAuditEvent(
         {
            actorUserId: null,
            subjectUserId: user.id,
            code: 'admin.owner.bootstrapped',
            entityType: 'user',
            entityId: user.id,
            metadata: { previousStatus: user.status },
         },
         client,
      )

      return { userId: user.id, status: 'active', role: 'owner' }
   })
}

export {
   approveUserService,
   authorizeAdministratorService,
   blockUserService,
   bootstrapOwnerService,
   listPendingUsersService,
   parsePagination,
   parseUserId,
   rejectUserService,
   unblockUserService,
}
