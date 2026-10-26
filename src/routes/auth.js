import express from 'express'

import { createPasswordAuthController } from '../controllers/password-auth-controller.js'
import { createPasswordRecoveryController } from '../controllers/password-recovery-controller.js'
import { createTelegramAuthController } from '../controllers/telegram-auth-controller.js'
import { createSessionController } from '../controllers/session-controller.js'
import { createAuthMiddleware } from '../middleware/auth-middleware.js'
import { passwordAuthService } from '../services/password-auth-service.js'
import { passwordRecoveryService } from '../services/password-recovery-service.js'
import { telegramAuthService } from '../services/telegram-auth-service.js'
import { sessionLifecycleService } from '../services/session-lifecycle-service.js'

function createAuthRouter(
   service = telegramAuthService,
   passwordService = passwordAuthService,
   lifecycleService = sessionLifecycleService,
   recoveryService = passwordRecoveryService,
) {
   const router = express.Router()
   const controller = createTelegramAuthController(service)
   const passwordController = createPasswordAuthController(passwordService)
   const recoveryController = createPasswordRecoveryController(recoveryService)
   const sessionController = createSessionController(lifecycleService)
   const authenticate = createAuthMiddleware(service)

   router.post('/register', passwordController.registerController)
   router.post('/login/password', passwordController.loginController)
   router.post('/password-recovery/request', recoveryController.requestPasswordRecoveryController)
   router.post('/password-recovery/verify', recoveryController.verifyPasswordRecoveryController)
   router.post('/password-recovery/reset', recoveryController.resetPasswordController)
   router.post('/refresh', sessionController.refreshSessionController)
   router.post('/logout', sessionController.logoutController)
   router.post('/logout-all', authenticate, sessionController.logoutAllController)
   router.get('/sessions', authenticate, sessionController.listSessionsController)
   router.delete('/sessions/:sessionId', authenticate, sessionController.revokeSessionController)
   router.get('/telegram/start', controller.startTelegramController)
   router.get('/telegram/callback', controller.telegramCallbackController)
   router.post('/telegram/link', authenticate, controller.linkTelegramController)
   router.delete('/telegram/link', authenticate, controller.unlinkTelegramController)
   router.post('/telegram/test-message', authenticate, controller.testTelegramMessageController)
   return router
}

export { createAuthRouter }
export default createAuthRouter()
