import {
   addTestQuestionsService,
   archiveTestService,
   copyTestService,
   createAssignmentService,
   createTestService,
   deleteTestService,
   getTestService,
   listAssignmentsService,
   listTestsService,
   publishTestService,
   removeTestQuestionService,
   reorderTestQuestionsService,
   revokeAssignmentService,
   updateAssignmentService,
   updateTestQuestionPointsService,
   updateTestService,
} from '../services/test-service.js'

function overrides(req) {
   return req.app.locals.serviceDependencies.tests
}

async function listTestsController(req, res, next) {
   try {
      const data = await listTestsService(req.auth.userId, req.query, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function getTestController(req, res, next) {
   try {
      const data = await getTestService(req.auth.userId, req.params.testId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function createTestController(req, res, next) {
   try {
      const data = await createTestService(req.auth.userId, req.body, overrides(req))
      res.status(201).json({ data })
   } catch (error) {
      next(error)
   }
}

async function updateTestController(req, res, next) {
   try {
      const data = await updateTestService(req.auth.userId, req.params.testId, req.body, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function deleteTestController(req, res, next) {
   try {
      const data = await deleteTestService(req.auth.userId, req.params.testId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function addTestQuestionsController(req, res, next) {
   try {
      const data = await addTestQuestionsService(req.auth.userId, req.params.testId, req.body, overrides(req))
      res.status(201).json({ data })
   } catch (error) {
      next(error)
   }
}

async function removeTestQuestionController(req, res, next) {
   try {
      const data = await removeTestQuestionService(req.auth.userId, req.params.testId, req.params.questionId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function reorderTestQuestionsController(req, res, next) {
   try {
      const data = await reorderTestQuestionsService(req.auth.userId, req.params.testId, req.body, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function updateTestQuestionPointsController(req, res, next) {
   try {
      const data = await updateTestQuestionPointsService(req.auth.userId, req.params.testId, req.params.questionId, req.body, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function publishTestController(req, res, next) {
   try {
      const data = await publishTestService(req.auth.userId, req.params.testId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function archiveTestController(req, res, next) {
   try {
      const data = await archiveTestService(req.auth.userId, req.params.testId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function copyTestController(req, res, next) {
   try {
      const data = await copyTestService(req.auth.userId, req.params.testId, overrides(req))
      res.status(201).json({ data })
   } catch (error) {
      next(error)
   }
}

async function listAssignmentsController(req, res, next) {
   try {
      const data = await listAssignmentsService(req.auth.userId, req.params.testId, req.query, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function createAssignmentController(req, res, next) {
   try {
      const data = await createAssignmentService(req.auth.userId, req.params.testId, req.body, overrides(req))
      res.status(201).json({ data })
   } catch (error) {
      next(error)
   }
}

async function updateAssignmentController(req, res, next) {
   try {
      const data = await updateAssignmentService(req.auth.userId, req.params.testId, req.params.assignmentId, req.body, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function revokeAssignmentController(req, res, next) {
   try {
      const data = await revokeAssignmentService(req.auth.userId, req.params.testId, req.params.assignmentId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

export {
   addTestQuestionsController,
   archiveTestController,
   copyTestController,
   createAssignmentController,
   createTestController,
   deleteTestController,
   getTestController,
   listAssignmentsController,
   listTestsController,
   publishTestController,
   removeTestQuestionController,
   reorderTestQuestionsController,
   revokeAssignmentController,
   updateAssignmentController,
   updateTestController,
   updateTestQuestionPointsController,
}
