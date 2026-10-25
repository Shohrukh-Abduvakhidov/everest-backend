import express from 'express';

import { createPasswordAuthController } from '../controllers/password-auth-controller.js';
import { createPasswordRecoveryController } from '../controllers/password-recovery-controller.js';
import { createTelegramAuthController } from '../controllers/telegram-auth-controller.js';
import { createSessionController } from '../controllers/session-controller.js';
import { createAuthMiddleware } from '../middleware/auth-middleware.js';
import { passwordAuthService } from '../services/password-auth-service.js';
import { passwordRecoveryService } from '../services/password-recovery-service.js';
import { telegramAuthService } from '../services/telegram-auth-service.js';
import { sessionLifecycleService } from '../services/session-lifecycle-service.js';
import asyncHandler from '../utils/async-handler.js';

function createAuthRouter(
  service = telegramAuthService,
  passwordService = passwordAuthService,
  lifecycleService = sessionLifecycleService,
  recoveryService = passwordRecoveryService
) {
  const router = express.Router();
  const controller = createTelegramAuthController(service);
  const passwordController = createPasswordAuthController(passwordService);
  const recoveryController = createPasswordRecoveryController(recoveryService);
  const sessionController = createSessionController(lifecycleService);
  const authenticate = createAuthMiddleware(service);

  router.post('/register', asyncHandler(passwordController.register));
  router.post('/login/password', asyncHandler(passwordController.login));
  router.post('/password-recovery/request', asyncHandler(recoveryController.request));
  router.post('/password-recovery/verify', asyncHandler(recoveryController.verify));
  router.post('/password-recovery/reset', asyncHandler(recoveryController.reset));
  router.post('/refresh', asyncHandler(sessionController.refresh));
  router.post('/logout', asyncHandler(sessionController.logout));
  router.post('/logout-all', authenticate, asyncHandler(sessionController.logoutAll));
  router.get('/sessions', authenticate, asyncHandler(sessionController.list));
  router.delete('/sessions/:sessionId', authenticate, asyncHandler(sessionController.revoke));
  router.get('/telegram/start', asyncHandler(controller.start));
  router.get('/telegram/callback', asyncHandler(controller.callback));
  router.post('/telegram/link', authenticate, asyncHandler(controller.link));
  router.delete('/telegram/link', authenticate, asyncHandler(controller.unlink));
  router.post('/telegram/test-message', authenticate, asyncHandler(controller.testMessage));
  return router;
}

export { createAuthRouter };
export default createAuthRouter();
