import env from '../configs/env.js'
import * as authRepository from '../repositories/auth-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import * as userRepository from '../repositories/user-repository.js'
import AppError from '../utils/app-error.js'
import {
   normalizePhone,
   validateBody,
   validateName,
   validatePassword,
} from '../utils/auth-input.js'
import { hashPassword, verifyPassword } from '../utils/password.js'
import { issueSessionService } from './auth/session-service.js'
import {
   clearRateLimitService,
   consumeRateLimitService,
} from './auth-protection-service.js'

const dummyPasswordHash =
   'scrypt$16384$8$1$YPIwZaby56dLwoJeEAVCKQ$WmyiT5x22N7vIWUPlYs8wJTOB3XsvKr3RBultfXmx-FwcIYNQJkBaoVibAGfr3D86KtJWqKzbG91FNdWa4D0Jw'

function dependencies(overrides = {}) {
   const config = overrides.config || env
   const auth = overrides.auth || authRepository
   const now = overrides.now || (() => new Date())

   return {
      config,
      users: overrides.users || userRepository,
      auth,
      transaction: overrides.transaction || withTransaction,
      passwordHasher: overrides.passwordHasher || {
         hash: hashPassword,
         verify: verifyPassword,
      },
      sessions: overrides.sessions || {
         issueSession: (input) =>
            issueSessionService(input, {
               config,
               repository: auth,
               now,
            }),
      },
      protection: overrides.protection || {
         consume: (input) => consumeRateLimitService(input, { config }),
         clear: (scope, key) => clearRateLimitService(scope, key, { config }),
      },
   }
}

async function authRegisterService(body, overrides) {
   const { users, auth, transaction, passwordHasher } = dependencies(overrides)
   validateBody(body, ['phone', 'password', 'firstName', 'lastName'])
   const phoneE164 = normalizePhone(body.phone)
   const password = validatePassword(body.password)
   const firstName = validateName(body.firstName, 'firstName')
   const lastName = validateName(body.lastName, 'lastName')
   const passwordHash = await passwordHasher.hash(password)

   try {
      return await transaction(async (client) => {
         const user = await users.createPendingUser(client)
         const userId = user.id
         await users.createProfile({ userId, firstName, lastName }, client)
         await users.createPhone({ userId, phoneE164 }, client)
         await users.createPassword(userId, passwordHash, client)
         await users.assignRole(userId, 'student', client)
         await auth.appendAuditEvent(
            {
               actorUserId: null,
               subjectUserId: userId,
               code: 'auth.password.registered',
               entityType: 'user',
               entityId: userId,
               metadata: {},
            },
            client,
         )

         return {
            status: 'pending',
            user: {
               id: user.id,
               status: user.status,
               firstName,
               lastName,
               phone: phoneE164,
            },
         }
      })
   } catch (error) {
      if (error.code === '23505' && error.constraint === 'user_phones_phone_e164_key') {
         throw new AppError(409, 'PHONE_ALREADY_REGISTERED', 'Phone is already registered')
      }
      throw error
   }
}

async function authLoginService(body, requestContext, overrides) {
   const { users, auth, transaction, passwordHasher, sessions, protection, config } = dependencies(overrides)
   validateBody(body, ['phone', 'password'])
   const phoneE164 = normalizePhone(body.phone)
   const password = body.password

   await protection.consume({
      scope: 'login.account',
      key: phoneE164,
      limit: config.authLoginMaxAttempts,
      windowSeconds: config.authRateWindowSeconds,
      blockSeconds: config.authRateBlockSeconds,
   })

   if (typeof password !== 'string' || password.length === 0 || [...password].length > 128) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Phone or password is invalid')
   }

   const account = await users.findPasswordAccountByPhone(phoneE164)
   const passwordMatches = await passwordHasher.verify(
      password,
      account?.password_hash || dummyPasswordHash,
   )
   if (!account || !passwordMatches) {
      if (account) {
         await transaction((client) => auth.appendAuditEvent(
            {
               actorUserId: null,
               subjectUserId: account.user_id,
               code: 'auth.password.login_failed',
               entityType: 'user',
               entityId: account.user_id,
               metadata: {},
            },
            client,
         ))
      }
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Phone or password is invalid')
   }

   const result = await transaction(async (client) => {
      const locked = await users.findPasswordAccountForUpdate(phoneE164, client)
      if (
         !locked ||
         locked.user_id !== account.user_id ||
         locked.password_hash !== account.password_hash
      ) {
         throw new AppError(401, 'INVALID_CREDENTIALS', 'Phone or password is invalid')
      }
      if (locked.status !== 'active') {
         throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'Account is not active')
      }

      const session = await sessions.issueSession({
         userId: locked.user_id,
         requestContext,
         client,
      })
      await users.touchLastLogin(locked.user_id, client)
      await auth.appendAuditEvent(
         {
            actorUserId: locked.user_id,
            subjectUserId: locked.user_id,
            code: 'auth.password.login_succeeded',
            entityType: 'auth_session',
            entityId: session.sessionId,
            metadata: {},
         },
         client,
      )
      return {
         status: 'authenticated',
         accessToken: session.accessToken,
         expiresAt: session.expiresAt,
         refreshToken: session.refreshToken,
         csrfToken: session.csrfToken,
         refreshExpiresAt: session.refreshExpiresAt,
         user: { id: locked.user_id },
      }
   })
   await protection.clear('login.account', phoneE164)
   return result
}

export { authLoginService, authRegisterService }
