import express from 'express'

import {
   createTrainerAttemptController,
   getTrainerCatalogController,
   getTrainerOverviewController,
   listTrainerHistoryController,
} from '../controllers/trainer-controller.js'
import { authMiddleware } from '../middleware/auth-middleware.js'
import { authenticatedCsrfMiddleware } from '../middleware/auth-protection-middleware.js'

// Generated practice tests; answering, submitting and results use the /tests attempt routes.
const trainerRouter = express.Router()

trainerRouter.use(authMiddleware)
trainerRouter.get('/catalog', getTrainerCatalogController)
trainerRouter.get('/overview', getTrainerOverviewController)
trainerRouter.get('/attempts', listTrainerHistoryController)
trainerRouter.post('/attempts', authenticatedCsrfMiddleware, createTrainerAttemptController)

export default trainerRouter
