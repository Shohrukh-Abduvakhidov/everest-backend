import {
   createMockExamService,
   getMockExamResultService,
   getMockExamService,
   listMockExamBlueprintsService,
   listMockExamHistoryService,
   saveMockExamAnswerService,
   setMockExamFlagService,
   submitMockExamService,
} from '../services/mock-exam-service.js'

function overrides(req) {
   return req.app.locals.serviceDependencies.testAttempts
}

async function listMockExamBlueprintsController(req, res, next) {
   try {
      const data = await listMockExamBlueprintsService(req.auth.userId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function createMockExamController(req, res, next) {
   try {
      const data = await createMockExamService(req.auth.userId, req.body, overrides(req))
      res.status(data.resumed ? 200 : 201).json({ data })
   } catch (error) {
      next(error)
   }
}

async function listMockExamHistoryController(req, res, next) {
   try {
      const data = await listMockExamHistoryService(req.auth.userId, req.query, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function getMockExamController(req, res, next) {
   try {
      const data = await getMockExamService(req.auth.userId, req.params.attemptId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function saveMockExamAnswerController(req, res, next) {
   try {
      const data = await saveMockExamAnswerService(
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

async function setMockExamFlagController(req, res, next) {
   try {
      const data = await setMockExamFlagService(
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

async function submitMockExamController(req, res, next) {
   try {
      const data = await submitMockExamService(req.auth.userId, req.params.attemptId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function getMockExamResultController(req, res, next) {
   try {
      const data = await getMockExamResultService(req.auth.userId, req.params.attemptId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

export {
   createMockExamController,
   getMockExamController,
   getMockExamResultController,
   listMockExamBlueprintsController,
   listMockExamHistoryController,
   saveMockExamAnswerController,
   setMockExamFlagController,
   submitMockExamController,
}
