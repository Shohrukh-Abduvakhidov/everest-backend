import {
   approveUserService,
   authorizeAdministratorService,
   blockUserService,
   bootstrapOwnerService,
   listPendingUsersService,
   rejectUserService,
   unblockUserService,
} from '../../src/services/account-admin-service.js'
import { issueSessionService } from '../../src/services/auth/session-service.js'
import {
   authLoginService,
   authRegisterService,
} from '../../src/services/password-auth-service.js'
import {
   requestPasswordRecoveryService,
   resetPasswordService,
   verifyPasswordRecoveryService,
} from '../../src/services/password-recovery-service.js'
import {
   listSessionsService,
   logoutAllService,
   logoutService,
   refreshSessionService,
   revokeOwnedSessionService,
} from '../../src/services/session-lifecycle-service.js'
import {
   authenticateService,
   beginTelegramAuthorizationService,
   handleTelegramCallbackService,
   sendTelegramTestMessageService,
   unlinkTelegramService,
} from '../../src/services/telegram-auth-service.js'

function createAccountAdminTestService(dependencies = {}) {
   return {
      dependencies,
      approve: (actor, user) => approveUserService(actor, user, dependencies),
      authorizeAdministrator: (user) => authorizeAdministratorService(user, dependencies),
      block: (actor, user) => blockUserService(actor, user, dependencies),
      bootstrapOwner: (phone) => bootstrapOwnerService(phone, dependencies),
      listPending: (query) => listPendingUsersService(query, dependencies),
      reject: (actor, user) => rejectUserService(actor, user, dependencies),
      unblock: (actor, user) => unblockUserService(actor, user, dependencies),
   }
}

function createPasswordAuthTestService(dependencies = {}) {
   return {
      dependencies,
      login: (body, context) => authLoginService(body, context, dependencies),
      register: (body) => authRegisterService(body, dependencies),
   }
}

function createPasswordRecoveryTestService(dependencies = {}) {
   return {
      dependencies,
      request: (body) => requestPasswordRecoveryService(body, dependencies),
      reset: (body) => resetPasswordService(body, dependencies),
      verify: (body) => verifyPasswordRecoveryService(body, dependencies),
   }
}

function createSessionLifecycleTestService(dependencies = {}) {
   return {
      dependencies,
      listSessions: (userId, sessionId) =>
         listSessionsService(userId, sessionId, dependencies),
      logout: (tokens) => logoutService(tokens, dependencies),
      logoutAll: (userId) => logoutAllService(userId, dependencies),
      refresh: (token) => refreshSessionService(token, dependencies),
      revokeOwnedSession: (userId, currentSessionId, sessionId) =>
         revokeOwnedSessionService(userId, currentSessionId, sessionId, dependencies),
   }
}

function createSessionTestService(dependencies = {}) {
   return {
      issueSession: (input) => issueSessionService(input, dependencies),
   }
}

function createTelegramAuthTestService(dependencies = {}) {
   return {
      dependencies,
      authenticate: (token) => authenticateService(token, dependencies),
      beginTelegramAuthorization: (input) =>
         beginTelegramAuthorizationService(input, dependencies),
      handleTelegramCallback: (input) => handleTelegramCallbackService(input, dependencies),
      sendTelegramTestMessage: (userId) =>
         sendTelegramTestMessageService(userId, dependencies),
      unlinkTelegram: (userId) => unlinkTelegramService(userId, dependencies),
   }
}

export {
   createAccountAdminTestService,
   createPasswordAuthTestService,
   createPasswordRecoveryTestService,
   createSessionLifecycleTestService,
   createSessionTestService,
   createTelegramAuthTestService,
}
