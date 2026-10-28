import {
   extendCourseEnrollmentService,
   extendModuleAccessService,
   grantCourseEnrollmentService,
   grantModuleAccessService,
   listCourseEnrollmentsService,
   listModuleAccessGrantsService,
   revokeCourseEnrollmentService,
   revokeModuleAccessService,
} from '../services/course-access-service.js'

function overrides(req) {
   return req.app.locals.serviceDependencies.courseAccess
}

async function listCourseEnrollmentsController(req, res, next) {
   try {
      const data = await listCourseEnrollmentsService(
         req.auth.userId,
         req.params.courseId,
         req.query,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function grantCourseEnrollmentController(req, res, next) {
   try {
      const data = await grantCourseEnrollmentService(
         req.auth.userId,
         req.params.courseId,
         req.body,
         overrides(req),
      )
      res.status(201).json({ data })
   } catch (error) {
      next(error)
   }
}

async function extendCourseEnrollmentController(req, res, next) {
   try {
      const data = await extendCourseEnrollmentService(
         req.auth.userId,
         req.params.courseId,
         req.params.userId,
         req.body,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function revokeCourseEnrollmentController(req, res, next) {
   try {
      const data = await revokeCourseEnrollmentService(
         req.auth.userId,
         req.params.courseId,
         req.params.userId,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function listModuleAccessGrantsController(req, res, next) {
   try {
      const data = await listModuleAccessGrantsService(
         req.auth.userId,
         req.params.courseId,
         req.params.userId,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function grantModuleAccessController(req, res, next) {
   try {
      const data = await grantModuleAccessService(
         req.auth.userId,
         req.params.courseId,
         req.params.userId,
         req.body,
         overrides(req),
      )
      res.status(201).json({ data })
   } catch (error) {
      next(error)
   }
}

async function extendModuleAccessController(req, res, next) {
   try {
      const data = await extendModuleAccessService(
         req.auth.userId,
         req.params.courseId,
         req.params.userId,
         req.params.moduleId,
         req.body,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function revokeModuleAccessController(req, res, next) {
   try {
      const data = await revokeModuleAccessService(
         req.auth.userId,
         req.params.courseId,
         req.params.userId,
         req.params.moduleId,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

export {
   extendCourseEnrollmentController,
   extendModuleAccessController,
   grantCourseEnrollmentController,
   grantModuleAccessController,
   listCourseEnrollmentsController,
   listModuleAccessGrantsController,
   revokeCourseEnrollmentController,
   revokeModuleAccessController,
}
