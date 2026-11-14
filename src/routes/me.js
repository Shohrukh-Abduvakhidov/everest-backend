import express from 'express'

import { getStudentHomeController, listStudentAttemptsController } from '../controllers/student-home-controller.js'
import { authMiddleware } from '../middleware/auth-middleware.js'

// Read-only views of the signed-in student's own learning: home page and finished attempts.
const meRouter = express.Router()

meRouter.use(authMiddleware)
meRouter.get('/home', getStudentHomeController)
meRouter.get('/attempts', listStudentAttemptsController)

export default meRouter
