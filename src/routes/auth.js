import express from 'express'

import { loginController, registerController } from '../controllers/password-auth-controller.js'
import {
   requestPasswordRecoveryController,
   resetPasswordController,
   verifyPasswordRecoveryController,
} from '../controllers/password-recovery-controller.js'
import {
   listSessionsController,
   logoutAllController,
   logoutController,
   refreshSessionController,
   revokeSessionController,
} from '../controllers/session-controller.js'
import {
   linkTelegramController,
   startTelegramController,
   telegramCallbackController,
   testTelegramMessageController,
   unlinkTelegramController,
} from '../controllers/telegram-auth-controller.js'
import { authMiddleware } from '../middleware/auth-middleware.js'
import {
   authenticatedCsrfMiddleware,
   logoutCsrfMiddleware,
   publicRateMiddleware,
   refreshCsrfMiddleware,
} from '../middleware/auth-protection-middleware.js'

const authRouter = express.Router()

authRouter.post('/register', publicRateMiddleware('register.ip'), registerController)
authRouter.post('/login/password', publicRateMiddleware('login.ip'), loginController)
authRouter.post('/password-recovery/request', publicRateMiddleware('recovery.request.ip'), requestPasswordRecoveryController)
authRouter.post('/password-recovery/verify', publicRateMiddleware('recovery.verify.ip'), verifyPasswordRecoveryController)
authRouter.post('/password-recovery/reset', publicRateMiddleware('recovery.reset.ip'), resetPasswordController)
authRouter.post('/refresh', publicRateMiddleware('refresh.ip'), refreshCsrfMiddleware, refreshSessionController)
authRouter.post('/logout', logoutCsrfMiddleware, logoutController)
authRouter.post('/logout-all', authMiddleware, authenticatedCsrfMiddleware, logoutAllController)
authRouter.get('/sessions', authMiddleware, listSessionsController)
authRouter.delete('/sessions/:sessionId', authMiddleware, authenticatedCsrfMiddleware, revokeSessionController)
authRouter.get('/telegram/start', publicRateMiddleware('telegram.start.ip'), startTelegramController)
authRouter.get('/telegram/callback', publicRateMiddleware('telegram.callback.ip'), telegramCallbackController)
authRouter.post('/telegram/link', authMiddleware, authenticatedCsrfMiddleware, linkTelegramController)
authRouter.delete('/telegram/link', authMiddleware, authenticatedCsrfMiddleware, unlinkTelegramController)
authRouter.post('/telegram/test-message', authMiddleware, authenticatedCsrfMiddleware, testTelegramMessageController)

export default authRouter
