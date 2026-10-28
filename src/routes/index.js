import express from 'express'

import { getLivenessController, getReadinessController } from '../controllers/health-controller.js'
import adminRouter from './admin.js'
import authRouter from './auth.js'
import coursesRouter from './courses.js'
import groupsRouter from './groups.js'
import profileRouter from './profile.js'

const router = express.Router()

router.get('/health', getLivenessController)
router.get('/ready', getReadinessController)
router.use('/auth', authRouter)
router.use('/admin', adminRouter)
router.use('/courses', coursesRouter)
router.use('/groups', groupsRouter)
router.use('/profile', profileRouter)

export default router
