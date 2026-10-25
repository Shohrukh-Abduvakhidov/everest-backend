const accessCookieName = 'everest_access';
const refreshCookieName = 'everest_refresh';

function cookieOptions(config, expires, path) {
  return { httpOnly: true, secure: config.nodeEnv === 'production', sameSite: 'lax', expires, path };
}

function readCookie(request, name) {
  for (const part of String(request.get('cookie') || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator >= 0 && part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return undefined;
}

function readAccessToken(request) {
  const authorization = request.get('authorization');
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7);
  return readCookie(request, accessCookieName);
}

function readRefreshToken(request) {
  return readCookie(request, refreshCookieName);
}

function setAuthCookies(response, result, config) {
  response.cookie(accessCookieName, result.accessToken, cookieOptions(config, result.expiresAt, '/'));
  response.cookie(refreshCookieName, result.refreshToken,
    cookieOptions(config, result.refreshExpiresAt, '/api/v1/auth'));
}

function clearAuthCookies(response, config) {
  const access = cookieOptions(config, new Date(0), '/');
  const refresh = cookieOptions(config, new Date(0), '/api/v1/auth');
  delete access.expires;
  delete refresh.expires;
  response.clearCookie(accessCookieName, access);
  response.clearCookie(refreshCookieName, refresh);
}

export { clearAuthCookies, readAccessToken, readRefreshToken, setAuthCookies };
