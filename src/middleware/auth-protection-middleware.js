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
   await limitKey(req, scope, req.ip, limitName)
}

async function limitKey(req, scope, key, limitName) {
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
         key,
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

// Per-user limit for signed media URL issuance (playback, materials, offline).
async function learnerMediaRateMiddleware(req, res, next) {
   try {
      void res
      await limitKey(req, 'learner.media', `user:${req.auth.userId}`, 'playbackRateLimit')
      next()
   } catch (error) {
      next(error)
   }
}

export {
   adminMutationRateMiddleware,
   authenticatedCsrfMiddleware,
   learnerMediaRateMiddleware,
   publicRateMiddleware,
   logoutCsrfMiddleware,
   refreshCsrfMiddleware,
}
