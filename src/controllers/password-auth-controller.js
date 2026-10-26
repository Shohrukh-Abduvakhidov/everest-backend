import env from '../configs/env.js'
import { passwordAuthService } from '../services/password-auth-service.js'
import { setAuthCookies } from '../utils/auth-cookies.js'

function createPasswordAuthController(service = passwordAuthService) {
   async function registerController(req, res, next) {
      try {
         const result = await service.register(req.body)
         res.status(201).json({ data: result })
      } catch (error) {
         next(error)
      }
   }

   async function loginController(req, res, next) {
      try {
         const result = await service.login(req.body, {
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
         })
         setAuthCookies(res, result, env)
         const { accessToken: _accessToken, refreshToken: _refreshToken, ...safeResult } = result
         res.json({ data: safeResult })
      } catch (error) {
         next(error)
      }
   }

   return { loginController, registerController }
}

const { loginController, registerController } = createPasswordAuthController()

export { createPasswordAuthController, loginController, registerController }
