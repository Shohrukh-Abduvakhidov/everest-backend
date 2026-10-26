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

const authRouter = express.Router()

authRouter.post('/register', registerController)
authRouter.post('/login/password', loginController)
authRouter.post('/password-recovery/request', requestPasswordRecoveryController)
authRouter.post('/password-recovery/verify', verifyPasswordRecoveryController)
authRouter.post('/password-recovery/reset', resetPasswordController)
authRouter.post('/refresh', refreshSessionController)
authRouter.post('/logout', logoutController)
authRouter.post('/logout-all', authMiddleware, logoutAllController)
authRouter.get('/sessions', authMiddleware, listSessionsController)
authRouter.delete('/sessions/:sessionId', authMiddleware, revokeSessionController)
authRouter.get('/telegram/start', startTelegramController)
authRouter.get('/telegram/callback', telegramCallbackController)
authRouter.post('/telegram/link', authMiddleware, linkTelegramController)
authRouter.delete('/telegram/link', authMiddleware, unlinkTelegramController)
authRouter.post('/telegram/test-message', authMiddleware, testTelegramMessageController)

export default authRouter
