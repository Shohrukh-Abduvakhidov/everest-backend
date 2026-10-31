import {
   approveUserService,
   blockUserService,
   listPendingUsersService,
   listUsersService,
   rejectUserService,
   replaceUserRolesService,
   unblockUserService,
} from '../services/account-admin-service.js'

async function listPendingUsersController(req, res, next) {
   try {
      const data = await listPendingUsersService(
         req.query,
         req.app.locals.serviceDependencies.accountAdmin,
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function listUsersController(req, res, next) {
   try {
      const data = await listUsersService(
         req.query,
         req.app.locals.serviceDependencies.accountAdmin,
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function replaceUserRolesController(req, res, next) {
   try {
      const data = await replaceUserRolesService(
         req.auth.userId,
         req.params.userId,
         req.body,
         req.app.locals.serviceDependencies.accountAdmin,
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function approveUserController(req, res, next) {
   try {
      const data = await approveUserService(
         req.auth.userId,
         req.params.userId,
         req.app.locals.serviceDependencies.accountAdmin,
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function rejectUserController(req, res, next) {
   try {
      const data = await rejectUserService(
         req.auth.userId,
         req.params.userId,
         req.app.locals.serviceDependencies.accountAdmin,
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function blockUserController(req, res, next) {
   try {
      const data = await blockUserService(
         req.auth.userId,
         req.params.userId,
         req.app.locals.serviceDependencies.accountAdmin,
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function unblockUserController(req, res, next) {
   try {
      const data = await unblockUserService(
         req.auth.userId,
         req.params.userId,
         req.app.locals.serviceDependencies.accountAdmin,
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

export {
   approveUserController,
   blockUserController,
   listPendingUsersController,
   listUsersController,
   rejectUserController,
   replaceUserRolesController,
   unblockUserController,
}
