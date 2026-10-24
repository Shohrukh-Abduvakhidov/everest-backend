import express from 'express';

import { createTelegramAuthController } from '../controllers/telegram-auth-controller.js';
import { createAuthMiddleware } from '../middleware/auth-middleware.js';
import { telegramAuthService } from '../services/telegram-auth-service.js';
import asyncHandler from '../utils/async-handler.js';

function createAuthRouter(service = telegramAuthService) {
  const router = express.Router();
  const controller = createTelegramAuthController(service);
  const authenticate = createAuthMiddleware(service);

  router.get('/telegram/start', asyncHandler(controller.start));
  router.get('/telegram/callback', asyncHandler(controller.callback));
  router.post('/telegram/link', authenticate, asyncHandler(controller.link));
  router.delete('/telegram/link', authenticate, asyncHandler(controller.unlink));
  router.post('/telegram/test-message', authenticate, asyncHandler(controller.testMessage));
  return router;
}

export { createAuthRouter };
export default createAuthRouter();
