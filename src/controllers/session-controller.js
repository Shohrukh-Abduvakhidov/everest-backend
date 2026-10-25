import env from '../configs/env.js';
import { sessionLifecycleService } from '../services/session-lifecycle-service.js';
import {
  clearAuthCookies, readAccessToken, readRefreshToken, setAuthCookies,
} from '../utils/auth-cookies.js';

function safeResult(result) {
  const { accessToken: _accessToken, refreshToken: _refreshToken, ...safe } = result;
  return safe;
}

function createSessionController(service = sessionLifecycleService) {
  async function refresh(request, response) {
    try {
      const result = await service.refresh(readRefreshToken(request));
      setAuthCookies(response, result, env);
      response.json({ data: safeResult(result) });
    } catch (error) {
      clearAuthCookies(response, env);
      throw error;
    }
  }

  async function logout(request, response) {
    const result = await service.logout({
      accessToken: readAccessToken(request), refreshToken: readRefreshToken(request),
    });
    clearAuthCookies(response, env);
    response.json({ data: result });
  }

  async function logoutAll(request, response) {
    const result = await service.logoutAll(request.auth.userId);
    clearAuthCookies(response, env);
    response.json({ data: result });
  }

  async function list(request, response) {
    response.json({ data: await service.listSessions(request.auth.userId, request.auth.sessionId) });
  }

  async function revoke(request, response) {
    const result = await service.revokeOwnedSession(
      request.auth.userId, request.auth.sessionId, request.params.sessionId
    );
    if (result.currentSession) clearAuthCookies(response, env);
    response.json({ data: result });
  }

  return { list, logout, logoutAll, refresh, revoke };
}

export { createSessionController };
