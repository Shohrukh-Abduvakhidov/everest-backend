import { authenticateService } from '../services/telegram-auth-service.js'
import { readAccessToken } from '../utils/auth-cookies.js'

async function authMiddleware(req, res, next) {
   try {
      void res
      req.auth = await authenticateService(
         readAccessToken(req),
         req.app.locals.serviceDependencies.telegramAuth,
      )
      next()
   } catch (error) {
      next(error)
   }
}

export { authMiddleware }
