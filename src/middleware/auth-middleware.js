import { telegramAuthService } from '../services/telegram-auth-service.js'
import { readAccessToken } from '../utils/auth-cookies.js'

function createAuthMiddleware(service = telegramAuthService) {
   return async function authMiddleware(req, res, next) {
      try {
         void res
         req.auth = await service.authenticate(readAccessToken(req))
         next()
      } catch (error) {
         next(error)
      }
   }
}

const authMiddleware = createAuthMiddleware()

export { authMiddleware, createAuthMiddleware }
