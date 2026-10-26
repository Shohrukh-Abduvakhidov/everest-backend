import env from '../configs/env.js'
import {
   listSessionsService,
   logoutAllService,
   logoutService,
   refreshSessionService,
   revokeOwnedSessionService,
} from '../services/session-lifecycle-service.js'
import {
   clearAuthCookies,
   readAccessToken,
   readRefreshToken,
   setAuthCookies,
} from '../utils/auth-cookies.js'

function safeResult(result) {
   const { accessToken: _accessToken, refreshToken: _refreshToken, ...safe } = result
   return safe
}

async function refreshSessionController(req, res, next) {
   try {
      const result = await refreshSessionService(
         readRefreshToken(req),
         req.app.locals.serviceDependencies.sessionLifecycle,
      )

      setAuthCookies(res, result, env)
      res.json({ data: safeResult(result) })
   } catch (error) {
      clearAuthCookies(res, env)
      next(error)
   }
}

async function logoutController(req, res, next) {
   try {
      const result = await logoutService(
         {
            accessToken: readAccessToken(req),
            refreshToken: readRefreshToken(req),
         },
         req.app.locals.serviceDependencies.sessionLifecycle,
      )

      clearAuthCookies(res, env)
      res.json({ data: result })
   } catch (error) {
      next(error)
   }
}

async function logoutAllController(req, res, next) {
   try {
      const result = await logoutAllService(
         req.auth.userId,
         req.app.locals.serviceDependencies.sessionLifecycle,
      )

      clearAuthCookies(res, env)
      res.json({ data: result })
   } catch (error) {
      next(error)
   }
}

async function listSessionsController(req, res, next) {
   try {
      const data = await listSessionsService(
         req.auth.userId,
         req.auth.sessionId,
         req.app.locals.serviceDependencies.sessionLifecycle,
      )

      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function revokeSessionController(req, res, next) {
   try {
      const result = await revokeOwnedSessionService(
         req.auth.userId,
         req.auth.sessionId,
         req.params.sessionId,
         req.app.locals.serviceDependencies.sessionLifecycle,
      )

      if (result.currentSession) clearAuthCookies(res, env)
      res.json({ data: result })
   } catch (error) {
      next(error)
   }
}

export {
   listSessionsController,
   logoutAllController,
   logoutController,
   refreshSessionController,
   revokeSessionController,
}
