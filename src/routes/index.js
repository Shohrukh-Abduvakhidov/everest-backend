import express from 'express'

import { getLivenessController, getReadinessController } from '../controllers/health-controller.js'
import adminRouter from './admin.js'
import authRouter from './auth.js'

const router = express.Router()

router.get('/health', getLivenessController)
router.get('/ready', getReadinessController)
router.use('/auth', authRouter)
router.use('/admin', adminRouter)

export default router
