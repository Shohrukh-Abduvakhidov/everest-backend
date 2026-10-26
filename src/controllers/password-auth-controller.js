import env from '../configs/env.js'
import { authLoginService, authRegisterService } from '../services/password-auth-service.js'
import { setAuthCookies } from '../utils/auth-cookies.js'

async function registerController(req, res, next) {
   try {
      const data = await authRegisterService(
         req.body,
         req.app.locals.serviceDependencies.passwordAuth,
      )

      res.status(201).json({ data })
   } catch (error) {
      next(error)
   }
}

async function loginController(req, res, next) {
   try {
      const result = await authLoginService(
         req.body,
         {
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
         },
         req.app.locals.serviceDependencies.passwordAuth,
      )

      setAuthCookies(res, result, env)
      const { accessToken: _accessToken, refreshToken: _refreshToken, ...safeResult } = result
      res.json({ data: safeResult })
   } catch (error) {
      next(error)
   }
}

export { loginController, registerController }
