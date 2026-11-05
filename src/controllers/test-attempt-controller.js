import {
   getAssignmentResultService,
   getAttemptResultService,
   getAttemptService,
   listMyAssignmentsService,
   saveAnswerService,
   startAttemptService,
   submitAttemptService,
} from '../services/test-attempt-service.js'
import {
   getTestAttemptService,
   listTestAttemptsService,
   regradeAttemptService,
} from '../services/test-results-service.js'

function overrides(req) {
   return req.app.locals.serviceDependencies.testAttempts
}

async function listMyAssignmentsController(req, res, next) {
   try {
      const data = await listMyAssignmentsService(req.auth.userId, req.params.courseId, req.query, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function startAttemptController(req, res, next) {
   try {
      const data = await startAttemptService(req.auth.userId, req.params.assignmentId, overrides(req))
      res.status(data.resumed ? 200 : 201).json({ data })
   } catch (error) {
      next(error)
   }
}

async function getAssignmentResultController(req, res, next) {
   try {
      const data = await getAssignmentResultService(req.auth.userId, req.params.assignmentId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function getAttemptController(req, res, next) {
   try {
      const data = await getAttemptService(req.auth.userId, req.params.attemptId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function saveAnswerController(req, res, next) {
   try {
      const data = await saveAnswerService(
         req.auth.userId,
         req.params.attemptId,
         req.params.attemptQuestionId,
         req.body,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function submitAttemptController(req, res, next) {
   try {
      const data = await submitAttemptService(req.auth.userId, req.params.attemptId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function getAttemptResultController(req, res, next) {
   try {
      const data = await getAttemptResultService(req.auth.userId, req.params.attemptId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function listTestAttemptsController(req, res, next) {
   try {
      const data = await listTestAttemptsService(req.auth.userId, req.params.testId, req.query, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function getTestAttemptController(req, res, next) {
   try {
      const data = await getTestAttemptService(req.auth.userId, req.params.testId, req.params.attemptId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function regradeAttemptController(req, res, next) {
   try {
      const data = await regradeAttemptService(
         req.auth.userId,
         req.params.testId,
         req.params.attemptId,
         req.body,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

export {
   getAssignmentResultController,
   getAttemptController,
   getAttemptResultController,
   getTestAttemptController,
   listMyAssignmentsController,
   listTestAttemptsController,
   regradeAttemptController,
   saveAnswerController,
   startAttemptController,
   submitAttemptController,
}
