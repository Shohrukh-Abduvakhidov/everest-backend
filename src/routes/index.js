import express from 'express'

import {
   getLivenessController,
   getReadinessController,
} from '../controllers/health-controller.js'
import { passwordAuthService } from '../services/password-auth-service.js'
import { telegramAuthService } from '../services/telegram-auth-service.js'
import { createAdminRouter } from './admin.js'
import { createAuthRouter } from './auth.js'

function createRoutes(
   service = telegramAuthService,
   passwordService = passwordAuthService,
   adminService,
   lifecycleService,
   recoveryService,
) {
   const router = express.Router()

   router.get('/health', getLivenessController)
   router.get('/ready', getReadinessController)
   router.use(
      '/auth',
      createAuthRouter(service, passwordService, lifecycleService, recoveryService),
   )
   router.use('/admin', createAdminRouter(service, adminService))
   return router
}

export { createRoutes }
export default createRoutes()
