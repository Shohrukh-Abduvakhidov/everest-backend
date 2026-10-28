import {
   archiveCourseModuleService,
   copyCourseService,
   createCourseModuleService,
   deleteCourseModuleService,
   previewCourseModulesService,
   publishCourseModuleService,
   reorderCourseModulesService,
   restoreCourseModuleService,
   updateCourseModuleService,
} from '../services/course-module-service.js'

function overrides(req) {
   return req.app.locals.serviceDependencies.courseModules
}

async function previewCourseModulesController(req, res, next) {
   try {
      const data = await previewCourseModulesService(
         req.auth.userId,
         req.params.courseId,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function createCourseModuleController(req, res, next) {
   try {
      const data = await createCourseModuleService(
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

async function updateCourseModuleController(req, res, next) {
   try {
      const data = await updateCourseModuleService(
         req.auth.userId,
         req.params.courseId,
         req.params.moduleId,
         req.body,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function publishCourseModuleController(req, res, next) {
   try {
      const data = await publishCourseModuleService(
         req.auth.userId,
         req.params.courseId,
         req.params.moduleId,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function archiveCourseModuleController(req, res, next) {
   try {
      const data = await archiveCourseModuleService(
         req.auth.userId,
         req.params.courseId,
         req.params.moduleId,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function restoreCourseModuleController(req, res, next) {
   try {
      const data = await restoreCourseModuleService(
         req.auth.userId,
         req.params.courseId,
         req.params.moduleId,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function deleteCourseModuleController(req, res, next) {
   try {
      const data = await deleteCourseModuleService(
         req.auth.userId,
         req.params.courseId,
         req.params.moduleId,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function reorderCourseModulesController(req, res, next) {
   try {
      const data = await reorderCourseModulesService(
         req.auth.userId,
         req.params.courseId,
         req.body,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function copyCourseController(req, res, next) {
   try {
      const data = await copyCourseService(
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

export {
   archiveCourseModuleController,
   copyCourseController,
   createCourseModuleController,
   deleteCourseModuleController,
   previewCourseModulesController,
   publishCourseModuleController,
   reorderCourseModulesController,
   restoreCourseModuleController,
   updateCourseModuleController,
}
