import env from '../configs/env.js'
import { authenticateService } from '../services/telegram-auth-service.js'
import {
   consumeRateLimitService,
   validateRefreshCsrfService,
   validateSessionCsrfService,
} from '../services/auth-protection-service.js'
import {
   readCsrfToken,
   readAccessToken,
   readRefreshToken,
   usesCookieAccess,
} from '../utils/auth-cookies.js'

async function limit(req, scope, limitName) {
   const overrides = req.app.locals.serviceDependencies.authProtection || {
      config:
         req.app.locals.serviceDependencies.passwordAuth?.config
         || req.app.locals.serviceDependencies.telegramAuth?.config
         || env,
   }
   const config = overrides.config || env
   await consumeRateLimitService(
      {
         scope,
         key: req.ip,
         limit: config[limitName],
         windowSeconds: config.authRateWindowSeconds,
         blockSeconds: config.authRateBlockSeconds,
      },
      overrides,
   )
}

function publicRateMiddleware(scope) {
   return async function publicAuthRateMiddleware(req, res, next) {
      try {
         void res
         await limit(req, scope, 'authPublicRateLimit')
         next()
      } catch (error) {
         next(error)
      }
   }
}

async function authenticatedCsrfMiddleware(req, res, next) {
   try {
      void res
      if (usesCookieAccess(req)) {
         await validateSessionCsrfService(
            {
               sessionId: req.auth.sessionId,
               token: readCsrfToken(req),
               origin: req.get('origin'),
            },
            req.app.locals.serviceDependencies.authProtection,
         )
      }
      next()
   } catch (error) {
      next(error)
   }
}

async function refreshCsrfMiddleware(req, res, next) {
   try {
      void res
      const refreshToken = readRefreshToken(req)
      if (refreshToken) {
         await validateRefreshCsrfService(
            { refreshToken, token: readCsrfToken(req), origin: req.get('origin') },
            req.app.locals.serviceDependencies.authProtection,
         )
      }
      next()
   } catch (error) {
      next(error)
   }
}

async function logoutCsrfMiddleware(req, res, next) {
   try {
      void res
      const refreshToken = readRefreshToken(req)
      if (refreshToken) {
         await validateRefreshCsrfService(
            { refreshToken, token: readCsrfToken(req), origin: req.get('origin') },
            req.app.locals.serviceDependencies.authProtection,
         )
      } else if (usesCookieAccess(req)) {
         const auth = await authenticateService(
            readAccessToken(req),
            req.app.locals.serviceDependencies.telegramAuth,
         )
         await validateSessionCsrfService(
            { sessionId: auth.sessionId, token: readCsrfToken(req), origin: req.get('origin') },
            req.app.locals.serviceDependencies.authProtection,
         )
      }
      next()
   } catch (error) {
      next(error)
   }
}

async function adminMutationRateMiddleware(req, res, next) {
   try {
      void res
      await limit(req, `admin.${req.path.split('/').at(-1)}`, 'authAdminRateLimit')
      next()
   } catch (error) {
      next(error)
   }
}

export {
   adminMutationRateMiddleware,
   authenticatedCsrfMiddleware,
   publicRateMiddleware,
   logoutCsrfMiddleware,
   refreshCsrfMiddleware,
}
