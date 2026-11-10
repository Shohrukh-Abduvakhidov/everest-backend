import express from 'express'

import {
   createMockExamController,
   getMockExamController,
   getMockExamResultController,
   listMockExamBlueprintsController,
   listMockExamHistoryController,
   saveMockExamAnswerController,
   setMockExamFlagController,
   submitMockExamController,
} from '../controllers/mock-exam-controller.js'
import {
   createTrainerAttemptController,
   getTrainerCatalogController,
   getTrainerOverviewController,
   listTrainerHistoryController,
} from '../controllers/trainer-controller.js'
import { authMiddleware } from '../middleware/auth-middleware.js'
import { authenticatedCsrfMiddleware } from '../middleware/auth-protection-middleware.js'

// Generated practice tests; answering, submitting and results use the /tests attempt routes.
// The mock NCT exam (/exams) is a separate mode with its own answer, flag and result routes.
const trainerRouter = express.Router()

trainerRouter.use(authMiddleware)
trainerRouter.get('/catalog', getTrainerCatalogController)
trainerRouter.get('/overview', getTrainerOverviewController)
trainerRouter.get('/attempts', listTrainerHistoryController)
trainerRouter.post('/attempts', authenticatedCsrfMiddleware, createTrainerAttemptController)

trainerRouter.get('/exams/blueprints', listMockExamBlueprintsController)
trainerRouter.get('/exams', listMockExamHistoryController)
trainerRouter.post('/exams', authenticatedCsrfMiddleware, createMockExamController)
trainerRouter.get('/exams/:attemptId', getMockExamController)
trainerRouter.put(
   '/exams/:attemptId/answers/:attemptQuestionId',
   authenticatedCsrfMiddleware,
   saveMockExamAnswerController,
)
trainerRouter.put(
   '/exams/:attemptId/questions/:attemptQuestionId/flag',
   authenticatedCsrfMiddleware,
   setMockExamFlagController,
)
trainerRouter.post('/exams/:attemptId/submit', authenticatedCsrfMiddleware, submitMockExamController)
trainerRouter.get('/exams/:attemptId/result', getMockExamResultController)

export default trainerRouter
