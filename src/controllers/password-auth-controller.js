import env from '../configs/env.js';
import { passwordAuthService } from '../services/password-auth-service.js';

function setAccessCookie(response, result) {
  response.cookie('everest_access', result.accessToken, {
    httpOnly: true,
    secure: env.nodeEnv === 'production',
    sameSite: 'lax',
    expires: result.expiresAt,
    path: '/',
  });
}

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
    setAccessCookie(response, result);
    const { accessToken: _accessToken, ...safeResult } = result;
    response.json({ data: safeResult });
  }

  return { login, register };
}

const passwordAuthController = createPasswordAuthController();

export { createPasswordAuthController, passwordAuthController };
