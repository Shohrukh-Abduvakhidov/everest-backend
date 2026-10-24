import cors from 'cors';
import express from 'express';

import env from './configs/env.js';
import { errorHandler, notFoundHandler } from './configs/error-handler.js';
import { createRoutes } from './routes/index.js';
import { telegramAuthService } from './services/telegram-auth-service.js';

function createApp(service = telegramAuthService) {
  const app = express();

  app.disable('x-powered-by');
  app.use(cors({ origin: env.corsOrigins, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v1', createRoutes(service));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const app = createApp();

export { createApp };
export default app;
