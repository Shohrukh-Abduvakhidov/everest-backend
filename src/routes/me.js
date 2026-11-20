import express from 'express'

import { getStaffCapabilitiesController } from '../controllers/staff-capabilities-controller.js'
import {
   getStudentAnalyticsController,
   getStudentHomeController,
   listStudentAttemptsController,
} from '../controllers/student-home-controller.js'
import { authMiddleware } from '../middleware/auth-middleware.js'

// Read-only views of the signed-in user's own data: home page, finished attempts, analytics, and
// the staff rights the frontend uses to decide which staff screens to open.
const meRouter = express.Router()

meRouter.use(authMiddleware)
meRouter.get('/home', getStudentHomeController)
meRouter.get('/attempts', listStudentAttemptsController)
meRouter.get('/analytics', getStudentAnalyticsController)
meRouter.get('/staff-capabilities', getStaffCapabilitiesController)

export default meRouter
