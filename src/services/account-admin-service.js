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

const accountStatuses = ['pending', 'active', 'blocked', 'rejected']
const roleCodes = ['owner', 'admin', 'teacher', 'student']
const privilegedRoles = ['owner', 'admin']
const listQueryFields = ['limit', 'offset', 'status', 'role', 'q', 'sort']
const searchMinLength = 2
const searchMaxLength = 100

function validationError(field, message = `${field} is invalid`) {
   return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ field, message }])
}

function displayName(row) {
   const name = [row.first_name, row.last_name].filter((part) => part && part.trim()).join(' ')
   return name || null
}

function safeAccount(row) {
   return {
      id: row.id,
      firstName: row.first_name,
      lastName: row.last_name,
      displayName: displayName(row),
      phone: row.phone_e164,
      status: row.status,
      roles: row.roles,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
      telegramLinked: row.telegram_linked,
   }
}

// LIKE wildcards and the escape character in user input are matched literally.
function escapeLike(value) {
   return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

function parseListQuery(query = {}) {
   const unknown = Object.keys(query).find((field) => !listQueryFields.includes(field))
   if (unknown) throw validationError(unknown, `${unknown} is not allowed`)
   for (const field of ['status', 'role', 'q', 'sort']) {
      if (query[field] !== undefined && typeof query[field] !== 'string') throw validationError(field)
   }
   if (query.status !== undefined && !accountStatuses.includes(query.status)) throw validationError('status')
   if (query.role !== undefined && !roleCodes.includes(query.role)) throw validationError('role')
   const sort = query.sort ?? '-createdAt'
   if (!Object.hasOwn(accountAdminRepository.accountOrders, sort)) throw validationError('sort')
   let pattern = null
   if (query.q !== undefined) {
      const search = query.q.trim()
      if (search.length < searchMinLength || search.length > searchMaxLength) {
         throw validationError('q', `q must be ${searchMinLength}-${searchMaxLength} characters`)
      }
      pattern = `%${escapeLike(search)}%`
   }
   return {
      ...parsePagination(query),
      status: query.status ?? null,
      role: query.role ?? null,
      pattern,
      sort,
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

async function listPendingUsersService(query, overrides) {
   const { repository } = dependencies(overrides)
   const pagination = parsePagination(query)
   const rows = await repository.listPendingUsers(pagination)
   const total = await repository.countPendingUsers()

   return {
      users: rows.slice(0, pagination.limit).map(safeUser),
      pagination: { ...pagination, hasMore: rows.length > pagination.limit, total },
   }
}

async function listUsersService(query, overrides) {
   const { repository } = dependencies(overrides)
   const filters = parseListQuery(query || {})
   const rows = await repository.listUsers(filters)
   const total = await repository.countUsers(filters)

   return {
      users: rows.map(safeAccount),
      pagination: {
         limit: filters.limit,
         offset: filters.offset,
         hasMore: filters.offset + rows.length < total,
         total,
      },
   }
}

function hasOwner(roles) {
   return roles.includes('owner')
}

// Owner accounts can be acted on only by an owner, and the last active owner never
// loses access. The caller holds the owner-set advisory lock.
async function protectOwner(repository, client, { actorRoles, targetRoles, targetStatus, losesOwnerAccess }) {
   if (!hasOwner(targetRoles)) return
   if (!hasOwner(actorRoles)) {
      throw new AppError(403, 'OWNER_ACTION_FORBIDDEN', 'Only an owner can change an owner account')
   }
   if (losesOwnerAccess && targetStatus === 'active' && await repository.countActiveOwners(client) <= 1) {
      throw new AppError(409, 'LAST_OWNER_PROTECTED', 'The last active owner cannot lose owner access')
   }
}

function parseRoleSet(body) {
   if (!body || typeof body !== 'object' || Array.isArray(body)) throw validationError('body')
   const unknown = Object.keys(body).find((field) => field !== 'roles')
   if (unknown) throw validationError(unknown, `${unknown} is not allowed`)
   const { roles } = body
   if (!Array.isArray(roles) || !roles.length || roles.length > roleCodes.length
      || roles.some((role) => typeof role !== 'string') || new Set(roles).size !== roles.length) {
      throw new AppError(400, 'INVALID_ROLES', 'roles must be a non-empty list of distinct role codes', [
         { field: 'roles', message: `allowed: ${roleCodes.join(', ')}` },
      ])
   }
   const unknownRole = roles.find((role) => !roleCodes.includes(role))
   if (unknownRole) {
      throw new AppError(400, 'INVALID_ROLES', 'Unknown role', [
         { field: 'roles', message: `${unknownRole.slice(0, 24)} is not a role` },
      ])
   }
   // Registration gives every account the student role; it stays the base role.
   if (!roles.includes('student')) {
      throw new AppError(422, 'STUDENT_ROLE_REQUIRED', 'Every account keeps the student role')
   }
   return [...roles].sort()
}

async function replaceUserRolesService(actorValue, targetValue, body, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorUserId = parseUserId(actorValue)
   const userId = parseUserId(targetValue)
   const requested = parseRoleSet(body)
   if (actorUserId === userId) {
      throw new AppError(409, 'SELF_ROLE_CHANGE_FORBIDDEN', 'Cannot change your own roles')
   }

   return transaction(async (client) => {
      // Same lock as owner bootstrap and owner status changes: owner-set checks are serialized.
      await repository.lockOwnerBootstrap(client)
      const current = await repository.findUserForUpdate(userId, client)
      if (!current) throw new AppError(404, 'USER_NOT_FOUND', 'User was not found')
      const actorRoles = await repository.findUserRoles(actorUserId, client)
      const before = await repository.findUserRoles(userId, client)
      const changedRoles = roleCodes.filter((role) => before.includes(role) !== requested.includes(role))
      const actorIsOwner = hasOwner(actorRoles)

      // Deny by default: owners manage every role; admins manage teacher/student of accounts
      // that hold no privileged role; anyone else manages nothing.
      if (!actorIsOwner) {
         const actorIsAdmin = actorRoles.includes('admin')
         const touchesPrivileged = changedRoles.some((role) => privilegedRoles.includes(role))
            || before.some((role) => privilegedRoles.includes(role))
         if (!actorIsAdmin || touchesPrivileged) {
            throw new AppError(403, 'ROLE_ASSIGNMENT_FORBIDDEN', 'You cannot change these roles for this account')
         }
      }
      // The owner role is created only by bootstrap:owner; nobody grants it through the API.
      if (hasOwner(requested) && !hasOwner(before)) {
         throw new AppError(403, 'ROLE_ASSIGNMENT_FORBIDDEN', 'You cannot change these roles for this account')
      }
      if (!changedRoles.length) {
         return {
            changed: false,
            user: safeAccount(await repository.findAccount(userId, client)),
            revokedSessions: 0,
         }
      }
      await protectOwner(repository, client, {
         actorRoles,
         targetRoles: before,
         targetStatus: current.status,
         losesOwnerAccess: hasOwner(before) && !hasOwner(requested),
      })

      await repository.replaceUserRoles(userId, requested, actorUserId, client)
      // Permissions are read live on each request; revoking also ends cached client state.
      const revokedSessions = await repository.revokeLiveSessions(userId, 'roles_changed', client)
      await repository.revokeUserRefreshTokens(userId, client)
      await auth.appendAuditEvent(
         {
            actorUserId,
            subjectUserId: userId,
            code: 'admin.account.roles_changed',
            entityType: 'user',
            entityId: userId,
            metadata: { before, after: requested, revokedSessions },
         },
         client,
      )

      return {
         changed: true,
         user: safeAccount(await repository.findAccount(userId, client)),
         revokedSessions,
      }
   })
}

async function changeAccountStateService(action, actorValue, targetValue, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorUserId = parseUserId(actorValue)
   const userId = parseUserId(targetValue)
   const transition = accountTransitions[action]
   validateSelfAction(action, actorUserId, userId)

   return transaction(async (client) => {
      await repository.lockOwnerBootstrap(client)
      const current = await repository.findUserForUpdate(userId, client)
      if (!current) throw new AppError(404, 'USER_NOT_FOUND', 'User was not found')
      if (current.status !== transition.from) {
         throw new AppError(
            409,
            'INVALID_ACCOUNT_TRANSITION',
            'Account state transition is not allowed',
         )
      }
      if (['block', 'reject', 'unblock'].includes(action)) {
         await protectOwner(repository, client, {
            actorRoles: await repository.findUserRoles(actorUserId, client),
            targetRoles: await repository.findUserRoles(userId, client),
            targetStatus: current.status,
            losesOwnerAccess: action !== 'unblock',
         })
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
   blockUserService,
   bootstrapOwnerService,
   listPendingUsersService,
   listUsersService,
   parsePagination,
   parseUserId,
   rejectUserService,
   replaceUserRolesService,
   unblockUserService,
}
