import { authorizeAdministratorService } from '../services/account-admin-service.js'

async function adminMiddleware(req, res, next) {
   try {
      void res
      await authorizeAdministratorService(
         req.auth.userId,
         req.app.locals.serviceDependencies.accountAdmin,
      )
      next()
   } catch (error) {
      next(error)
   }
}

export { adminMiddleware }
