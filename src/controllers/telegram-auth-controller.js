import env from '../configs/env.js';
import { telegramAuthService } from '../services/telegram-auth-service.js';
import { setAuthCookies } from '../utils/auth-cookies.js';

function createTelegramAuthController(service = telegramAuthService) {
  async function start(_request, response) {
    const result = await service.beginTelegramAuthorization({ intent: 'login' });
    response.json({ data: result });
  }

  async function callback(request, response) {
    const result = await service.handleTelegramCallback({
      code: request.query.code,
      state: request.query.state,
      error: request.query.error,
      requestContext: { ipAddress: request.ip, userAgent: request.get('user-agent') },
    });
    if (result.accessToken) {
      setAuthCookies(response, result, env);
    }
    const { accessToken: _accessToken, refreshToken: _refreshToken, ...safeResult } = result;
    response.json({ data: safeResult });
  }

  async function link(request, response) {
    const result = await service.beginTelegramAuthorization({
      intent: 'link', userId: request.auth.userId,
    });
    response.json({ data: result });
  }

  async function unlink(request, response) {
    response.json({ data: await service.unlinkTelegram(request.auth.userId) });
  }

  async function testMessage(request, response) {
    response.json({ data: await service.sendTelegramTestMessage(request.auth.userId) });
  }

  return { callback, link, start, testMessage, unlink };
}

const telegramAuthController = createTelegramAuthController();

export { createTelegramAuthController, telegramAuthController };
