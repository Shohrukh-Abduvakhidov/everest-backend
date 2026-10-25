import express from 'express';

import * as healthController from '../controllers/health-controller.js';
import { passwordAuthService } from '../services/password-auth-service.js';
import { telegramAuthService } from '../services/telegram-auth-service.js';
import asyncHandler from '../utils/async-handler.js';
import { createAdminRouter } from './admin.js';
import { createAuthRouter } from './auth.js';

function createRoutes(service = telegramAuthService, passwordService = passwordAuthService, adminService) {
  const router = express.Router();

  router.get('/health', healthController.getLiveness);
  router.get('/ready', asyncHandler(healthController.getReadiness));
  router.use('/auth', createAuthRouter(service, passwordService));
  router.use('/admin', createAdminRouter(service, adminService));
  return router;
}

export { createRoutes };
export default createRoutes();
