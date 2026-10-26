import { authorizePermissionService } from '../services/authorization-service.js'

const denial = {
   errorCode: 'ADMIN_ROLE_REQUIRED',
   message: 'Administrator role is required',
}

async function authorizeAccountAction(req, permissionCode) {
   await authorizePermissionService(
      req.auth.userId,
      permissionCode,
      denial,
      req.app.locals.serviceDependencies.authorization,
   )
}

async function listPendingUsersAuthorizationMiddleware(req, res, next) {
   try {
      void res
      await authorizeAccountAction(req, 'accounts.pending.read')
      next()
   } catch (error) {
      next(error)
   }
}

async function approveUserAuthorizationMiddleware(req, res, next) {
   try {
      void res
      await authorizeAccountAction(req, 'accounts.approve')
      next()
   } catch (error) {
      next(error)
   }
}

async function rejectUserAuthorizationMiddleware(req, res, next) {
   try {
      void res
      await authorizeAccountAction(req, 'accounts.reject')
      next()
   } catch (error) {
      next(error)
   }
}

async function blockUserAuthorizationMiddleware(req, res, next) {
   try {
      void res
      await authorizeAccountAction(req, 'accounts.block')
      next()
   } catch (error) {
      next(error)
   }
}

async function unblockUserAuthorizationMiddleware(req, res, next) {
   try {
      void res
      await authorizeAccountAction(req, 'accounts.unblock')
      next()
   } catch (error) {
      next(error)
   }
}

export {
   approveUserAuthorizationMiddleware,
   blockUserAuthorizationMiddleware,
   listPendingUsersAuthorizationMiddleware,
   rejectUserAuthorizationMiddleware,
   unblockUserAuthorizationMiddleware,
}
