import {
   getAssignmentResultsService,
   getCourseProgressService,
   getGroupProgressService,
   getStaffStudentAnalyticsService,
   listStaffStudentAttemptsService,
} from '../services/staff-progress-service.js'

async function getGroupProgressController(req, res, next) {
   try {
      const data = await getGroupProgressService(
         req.auth.userId,
         req.params.groupId,
         req.query,
         req.app.locals.serviceDependencies.staffProgress,
      )

      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function getCourseProgressController(req, res, next) {
   try {
      const data = await getCourseProgressService(
         req.auth.userId,
         req.params.courseId,
         req.query,
         req.app.locals.serviceDependencies.staffProgress,
      )

      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function getStaffStudentAnalyticsController(req, res, next) {
   try {
      const data = await getStaffStudentAnalyticsService(
         req.auth.userId,
         req.params.userId,
         req.app.locals.serviceDependencies.staffProgress,
      )

      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function listStaffStudentAttemptsController(req, res, next) {
   try {
      const data = await listStaffStudentAttemptsService(
         req.auth.userId,
         req.params.userId,
         req.query,
         req.app.locals.serviceDependencies.staffProgress,
      )

      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function getAssignmentResultsController(req, res, next) {
   try {
      const data = await getAssignmentResultsService(
         req.auth.userId,
         req.params.testId,
         req.params.assignmentId,
         req.query,
         req.app.locals.serviceDependencies.staffProgress,
      )

      res.json({ data })
   } catch (error) {
      next(error)
   }
}

export {
   getAssignmentResultsController,
   getCourseProgressController,
   getGroupProgressController,
   getStaffStudentAnalyticsController,
   listStaffStudentAttemptsController,
}
