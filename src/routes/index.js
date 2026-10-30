import express from 'express'

import { getLivenessController, getReadinessController } from '../controllers/health-controller.js'
import adminRouter from './admin.js'
import assetsRouter from './assets.js'
import authRouter from './auth.js'
import coursesRouter from './courses.js'
import groupsRouter from './groups.js'
import offlineLicensesRouter from './offline-licenses.js'
import profileRouter from './profile.js'

const router = express.Router()

router.get('/health', getLivenessController)
router.get('/ready', getReadinessController)
// One mount table shared by the router and the OpenAPI coverage test.
const routeMounts = Object.freeze([
   ['/auth', authRouter],
   ['/admin', adminRouter],
   ['/assets', assetsRouter],
   ['/courses', coursesRouter],
   ['/groups', groupsRouter],
   ['/offline-licenses', offlineLicensesRouter],
   ['/profile', profileRouter],
])

for (const [mountPath, mountedRouter] of routeMounts) router.use(mountPath, mountedRouter)

export { routeMounts }
export default router
