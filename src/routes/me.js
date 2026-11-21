import express from 'express'

import {
   countUnreadNotificationsController,
   listNotificationsController,
   markAllNotificationsReadController,
   markNotificationReadController,
} from '../controllers/notification-controller.js'
import { getStaffCapabilitiesController } from '../controllers/staff-capabilities-controller.js'
import {
   getStudentAnalyticsController,
   getStudentHomeController,
   listStudentAttemptsController,
} from '../controllers/student-home-controller.js'
import { authMiddleware } from '../middleware/auth-middleware.js'
import { authenticatedCsrfMiddleware } from '../middleware/auth-protection-middleware.js'

// The signed-in user's own data: home page, finished attempts, analytics, the staff rights the
// frontend uses to decide which staff screens to open, and the in-app notification inbox.
const meRouter = express.Router()

meRouter.use(authMiddleware)
meRouter.get('/home', getStudentHomeController)
meRouter.get('/attempts', listStudentAttemptsController)
meRouter.get('/analytics', getStudentAnalyticsController)
meRouter.get('/staff-capabilities', getStaffCapabilitiesController)
meRouter.get('/notifications', listNotificationsController)
meRouter.get('/notifications/unread-count', countUnreadNotificationsController)
meRouter.post('/notifications/read-all', authenticatedCsrfMiddleware, markAllNotificationsReadController)
meRouter.post('/notifications/:notificationId/read', authenticatedCsrfMiddleware, markNotificationReadController)

export default meRouter
