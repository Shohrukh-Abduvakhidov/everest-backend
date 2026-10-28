import express from 'express'

import {
   listLearnerCourseModulesController,
   listLearnerCoursesController,
} from '../controllers/learner-course-controller.js'
import { authMiddleware } from '../middleware/auth-middleware.js'

const coursesRouter = express.Router()

coursesRouter.use(authMiddleware)
coursesRouter.get('/', listLearnerCoursesController)
coursesRouter.get('/:courseId/modules', listLearnerCourseModulesController)

export default coursesRouter
