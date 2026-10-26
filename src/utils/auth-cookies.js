const accessCookieName = 'everest_access'
const refreshCookieName = 'everest_refresh'
const csrfCookieName = 'everest_csrf'

function cookieOptions(config, expires, path, httpOnly = true) {
   return { httpOnly, secure: config.nodeEnv === 'production', sameSite: 'lax', expires, path }
}

function readCookie(req, name) {
   for (const part of String(req.get('cookie') || '').split(';')) {
      const separator = part.indexOf('=')
      if (separator >= 0 && part.slice(0, separator).trim() === name) {
         return decodeURIComponent(part.slice(separator + 1).trim())
      }
   }
   return undefined
}

function readAccessToken(req) {
   const authorization = req.get('authorization')
   if (authorization?.startsWith('Bearer ')) return authorization.slice(7)
   return readCookie(req, accessCookieName)
}

function readRefreshToken(req) {
   return readCookie(req, refreshCookieName)
}

function readCsrfToken(req) {
   return req.get('x-csrf-token')
}

function usesCookieAccess(req) {
   return !req.get('authorization') && Boolean(readCookie(req, accessCookieName))
}

function setAuthCookies(res, result, config) {
   res.cookie(accessCookieName, result.accessToken, cookieOptions(config, result.expiresAt, '/'))
   res.cookie(
      refreshCookieName,
      result.refreshToken,
      cookieOptions(config, result.refreshExpiresAt, '/api/v1/auth'),
   )
   if (result.csrfToken) {
      res.cookie(
         csrfCookieName,
         result.csrfToken,
         cookieOptions(config, result.refreshExpiresAt, '/', false),
      )
   }
}

function clearAuthCookies(res, config) {
   for (const [name, path, httpOnly] of [
      [accessCookieName, '/', true],
      [refreshCookieName, '/api/v1/auth', true],
      [csrfCookieName, '/', false],
   ]) {
      const options = cookieOptions(config, new Date(0), path, httpOnly)
      delete options.expires
      res.clearCookie(name, options)
   }
}

export {
   clearAuthCookies,
   readAccessToken,
   readCsrfToken,
   readRefreshToken,
   setAuthCookies,
   usesCookieAccess,
}
