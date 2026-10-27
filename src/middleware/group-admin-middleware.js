import { authorizePermissionService } from '../services/authorization-service.js'

async function authorize(req, permissionCode) {
   await authorizePermissionService(
      req.auth.userId,
      permissionCode,
      undefined,
      req.app.locals.serviceDependencies.authorization,
   )
}

async function createGroupAuthorizationMiddleware(req, res, next) {
   try {
      void res
      await authorize(req, 'groups.create')
      next()
   } catch (error) {
      next(error)
   }
}

async function updateGroupAuthorizationMiddleware(req, res, next) {
   try {
      void res
      await authorize(req, 'groups.update')
      next()
   } catch (error) {
      next(error)
   }
}

async function manageGroupMembersAuthorizationMiddleware(req, res, next) {
   try {
      void res
      await authorize(req, 'groups.members.manage')
      next()
   } catch (error) {
      next(error)
   }
}

async function manageGroupTeachersAuthorizationMiddleware(req, res, next) {
   try {
      void res
      await authorize(req, 'groups.teachers.manage')
      next()
   } catch (error) {
      next(error)
   }
}

async function manageGroupAnnouncementsAuthorizationMiddleware(req, res, next) {
   try {
      void res
      await authorize(req, 'groups.announcements.manage')
      next()
   } catch (error) {
      next(error)
   }
}

export {
   createGroupAuthorizationMiddleware,
   manageGroupAnnouncementsAuthorizationMiddleware,
   manageGroupMembersAuthorizationMiddleware,
   manageGroupTeachersAuthorizationMiddleware,
   updateGroupAuthorizationMiddleware,
}
