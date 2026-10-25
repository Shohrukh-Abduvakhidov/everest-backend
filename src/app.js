import cors from 'cors';
import express from 'express';

import env from './configs/env.js';
import { errorHandler, notFoundHandler } from './configs/error-handler.js';
import { createRoutes } from './routes/index.js';
import { passwordAuthService } from './services/password-auth-service.js';
import { telegramAuthService } from './services/telegram-auth-service.js';

function createApp(service = telegramAuthService, passwordService = passwordAuthService) {
  const app = express();

  app.disable('x-powered-by');
  app.use(cors({ origin: env.corsOrigins, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v1', createRoutes(service, passwordService));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const app = createApp();

export { createApp };
export default app;
