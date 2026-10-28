import {
   listLearnerCourseModulesService,
   listLearnerCoursesService,
} from '../services/learner-course-service.js'

function overrides(req) {
   return req.app.locals.serviceDependencies.learnerCourses
}

async function listLearnerCoursesController(req, res, next) {
   try {
      const data = await listLearnerCoursesService(req.auth.userId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function listLearnerCourseModulesController(req, res, next) {
   try {
      const data = await listLearnerCourseModulesService(
         req.auth.userId,
         req.params.courseId,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

export { listLearnerCourseModulesController, listLearnerCoursesController }
