import express from 'express';

import * as healthController from '../controllers/health-controller.js';
import { telegramAuthService } from '../services/telegram-auth-service.js';
import asyncHandler from '../utils/async-handler.js';
import { createAuthRouter } from './auth.js';

function createRoutes(service = telegramAuthService) {
  const router = express.Router();

  router.get('/health', healthController.getLiveness);
  router.get('/ready', asyncHandler(healthController.getReadiness));
  router.use('/auth', createAuthRouter(service));
  return router;
}

export { createRoutes };
export default createRoutes();
