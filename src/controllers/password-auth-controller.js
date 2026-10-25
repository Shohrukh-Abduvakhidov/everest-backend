import env from '../configs/env.js';
import { passwordAuthService } from '../services/password-auth-service.js';
import { setAuthCookies } from '../utils/auth-cookies.js';

function createPasswordAuthController(service = passwordAuthService) {
  async function register(request, response) {
    const result = await service.register(request.body);
    response.status(201).json({ data: result });
  }

  async function login(request, response) {
    const result = await service.login(request.body, {
      ipAddress: request.ip,
      userAgent: request.get('user-agent'),
    });
    setAuthCookies(response, result, env);
    const { accessToken: _accessToken, refreshToken: _refreshToken, ...safeResult } = result;
    response.json({ data: safeResult });
  }

  return { login, register };
}

const passwordAuthController = createPasswordAuthController();

export { createPasswordAuthController, passwordAuthController };
