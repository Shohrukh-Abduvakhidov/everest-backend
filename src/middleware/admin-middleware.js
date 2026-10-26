import { accountAdminService } from '../services/account-admin-service.js'

function createAdminMiddleware(service = accountAdminService) {
   return async function adminMiddleware(req, res, next) {
      try {
         void res
         await service.authorizeAdministrator(req.auth.userId)
         next()
      } catch (error) {
         next(error)
      }
   }
}

const adminMiddleware = createAdminMiddleware()

export { adminMiddleware, createAdminMiddleware }
