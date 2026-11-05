import express from 'express'

import {
   getAssignmentResultController,
   getAttemptController,
   getAttemptResultController,
   saveAnswerController,
   startAttemptController,
   submitAttemptController,
} from '../controllers/test-attempt-controller.js'
import { authMiddleware } from '../middleware/auth-middleware.js'
import { authenticatedCsrfMiddleware } from '../middleware/auth-protection-middleware.js'

const testsRouter = express.Router()

testsRouter.use(authMiddleware)
testsRouter.post('/assignments/:assignmentId/start', authenticatedCsrfMiddleware, startAttemptController)
testsRouter.get('/assignments/:assignmentId/result', getAssignmentResultController)
testsRouter.get('/attempts/:attemptId', getAttemptController)
testsRouter.put(
   '/attempts/:attemptId/answers/:attemptQuestionId',
   authenticatedCsrfMiddleware,
   saveAnswerController,
)
testsRouter.post('/attempts/:attemptId/submit', authenticatedCsrfMiddleware, submitAttemptController)
testsRouter.get('/attempts/:attemptId/result', getAttemptResultController)

export default testsRouter
