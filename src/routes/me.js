import express from 'express'

import {
   getStudentAnalyticsController,
   getStudentHomeController,
   listStudentAttemptsController,
} from '../controllers/student-home-controller.js'
import { authMiddleware } from '../middleware/auth-middleware.js'

// Read-only views of the signed-in student's own learning: home page, finished attempts, analytics.
const meRouter = express.Router()

meRouter.use(authMiddleware)
meRouter.get('/home', getStudentHomeController)
meRouter.get('/attempts', listStudentAttemptsController)
meRouter.get('/analytics', getStudentAnalyticsController)

export default meRouter
