import express from 'express';

import { createAccountAdminController } from '../controllers/account-admin-controller.js';
import { createAdminMiddleware } from '../middleware/admin-middleware.js';
import { createAuthMiddleware } from '../middleware/auth-middleware.js';
import { accountAdminService } from '../services/account-admin-service.js';
import { telegramAuthService } from '../services/telegram-auth-service.js';
import asyncHandler from '../utils/async-handler.js';

function createAdminRouter(authService = telegramAuthService, service = accountAdminService) {
  const router = express.Router();
  const controller = createAccountAdminController(service);
  router.use(createAuthMiddleware(authService), createAdminMiddleware(service));
  router.get('/users/pending', asyncHandler(controller.listPending));
  router.post('/users/:userId/approve', asyncHandler(controller.approve));
  router.post('/users/:userId/reject', asyncHandler(controller.reject));
  router.post('/users/:userId/block', asyncHandler(controller.block));
  router.post('/users/:userId/unblock', asyncHandler(controller.unblock));
  return router;
}

export { createAdminRouter };
