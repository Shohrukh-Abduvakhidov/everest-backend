import express from 'express'

import {
  approve,
  block,
  listPending,
  reject,
  unblock,
} from '../controllers/account-admin-controller.js'
import { createAdminMiddleware } from '../middleware/admin-middleware.js'
import { createAuthMiddleware } from '../middleware/auth-middleware.js'
import { accountAdminService } from '../services/account-admin-service.js'
import { telegramAuthService } from '../services/telegram-auth-service.js'

function createAdminRouter(authService = telegramAuthService, service = accountAdminService) {
  const router = express.Router()

  router.use(createAuthMiddleware(authService), createAdminMiddleware(service))

  router.get('/users/pending', listPending)
  router.post('/users/:userId/approve', approve)
  router.post('/users/:userId/reject', reject)
  router.post('/users/:userId/block', block)
  router.post('/users/:userId/unblock', unblock)

  return router
}

const adminRouter = createAdminRouter()

export { createAdminRouter }
export default adminRouter
