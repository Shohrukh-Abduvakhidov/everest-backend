import { telegramAuthService } from '../services/telegram-auth-service.js';
import { readAccessToken } from '../utils/auth-cookies.js';

function createAuthMiddleware(service = telegramAuthService) {
  return async function authMiddleware(request, _response, next) {
    try {
      request.auth = await service.authenticate(readAccessToken(request));
      next();
    } catch (error) {
      next(error);
    }
  };
}

const authMiddleware = createAuthMiddleware();

export { authMiddleware, createAuthMiddleware };
