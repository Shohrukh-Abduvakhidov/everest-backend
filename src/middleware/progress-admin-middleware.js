import { authorizePermissionService } from '../services/authorization-service.js'

// Staff progress views (decision D2). The resource scope of D1 is applied by the services.
async function readProgressAuthorizationMiddleware(req, res, next) {
   try {
      void res
      await authorizePermissionService(
         req.auth.userId,
         'progress.read',
         undefined,
         req.app.locals.serviceDependencies.authorization,
      )
      next()
   } catch (error) {
      next(error)
   }
}

export { readProgressAuthorizationMiddleware }
