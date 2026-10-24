import { telegramAuthService } from '../services/telegram-auth-service.js';

function readAccessToken(request) {
  const authorization = request.get('authorization');
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7);
  const cookies = Object.fromEntries(
    String(request.get('cookie') || '')
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.includes('='))
      .map((part) => {
        const separator = part.indexOf('=');
        return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
      })
  );
  return cookies.everest_access;
}

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
