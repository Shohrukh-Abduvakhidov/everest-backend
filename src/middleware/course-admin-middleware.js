import { authorizePermissionService } from '../services/authorization-service.js'

async function authorize(req, permissionCode) {
   await authorizePermissionService(
      req.auth.userId,
      permissionCode,
      undefined,
      req.app.locals.serviceDependencies.authorization,
   )
}

async function readCoursesAuthorizationMiddleware(req, res, next) {
   try {
      void res
      await authorize(req, 'courses.read')
      next()
   } catch (error) {
      next(error)
   }
}

async function createCourseAuthorizationMiddleware(req, res, next) {
   try {
      void res
      await authorize(req, 'courses.create')
      next()
   } catch (error) {
      next(error)
   }
}

async function updateCourseAuthorizationMiddleware(req, res, next) {
   try {
      void res
      await authorize(req, 'courses.update')
      next()
   } catch (error) {
      next(error)
   }
}

async function publishCourseAuthorizationMiddleware(req, res, next) {
   try {
      void res
      await authorize(req, 'courses.publish')
      next()
   } catch (error) {
      next(error)
   }
}

async function manageCourseTeachersAuthorizationMiddleware(req, res, next) {
   try {
      void res
      await authorize(req, 'courses.teachers.manage')
      next()
   } catch (error) {
      next(error)
   }
}

async function manageCourseModulesAuthorizationMiddleware(req, res, next) {
   try {
      void res
      await authorize(req, 'courses.modules.manage')
      next()
   } catch (error) {
      next(error)
   }
}

async function copyCourseAuthorizationMiddleware(req, res, next) {
   try {
      void res
      await authorize(req, 'courses.copy')
      next()
   } catch (error) {
      next(error)
   }
}

export {
   copyCourseAuthorizationMiddleware,
   createCourseAuthorizationMiddleware,
   manageCourseModulesAuthorizationMiddleware,
   manageCourseTeachersAuthorizationMiddleware,
   publishCourseAuthorizationMiddleware,
   readCoursesAuthorizationMiddleware,
   updateCourseAuthorizationMiddleware,
}
