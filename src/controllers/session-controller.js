import env from '../configs/env.js'
import { sessionLifecycleService } from '../services/session-lifecycle-service.js'
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

function createSessionController(service = sessionLifecycleService) {
   async function refreshSessionController(req, res, next) {
      try {
         const result = await service.refresh(readRefreshToken(req))
         setAuthCookies(res, result, env)
         res.json({ data: safeResult(result) })
      } catch (error) {
         clearAuthCookies(res, env)
         next(error)
      }
   }

   async function logoutController(req, res, next) {
      try {
         const result = await service.logout({
            accessToken: readAccessToken(req),
            refreshToken: readRefreshToken(req),
         })
         clearAuthCookies(res, env)
         res.json({ data: result })
      } catch (error) {
         next(error)
      }
   }

   async function logoutAllController(req, res, next) {
      try {
         const result = await service.logoutAll(req.auth.userId)
         clearAuthCookies(res, env)
         res.json({ data: result })
      } catch (error) {
         next(error)
      }
   }

   async function listSessionsController(req, res, next) {
      try {
         res.json({
            data: await service.listSessions(req.auth.userId, req.auth.sessionId),
         })
      } catch (error) {
         next(error)
      }
   }

   async function revokeSessionController(req, res, next) {
      try {
         const result = await service.revokeOwnedSession(
            req.auth.userId,
            req.auth.sessionId,
            req.params.sessionId,
         )
         if (result.currentSession) clearAuthCookies(res, env)
         res.json({ data: result })
      } catch (error) {
         next(error)
      }
   }

   return {
      listSessionsController,
      logoutAllController,
      logoutController,
      refreshSessionController,
      revokeSessionController,
   }
}

const {
   listSessionsController,
   logoutAllController,
   logoutController,
   refreshSessionController,
   revokeSessionController,
} = createSessionController()

export {
   createSessionController,
   listSessionsController,
   logoutAllController,
   logoutController,
   refreshSessionController,
   revokeSessionController,
}
