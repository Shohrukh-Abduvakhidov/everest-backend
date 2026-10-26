import express from 'express'

import {
   approveUserController,
   blockUserController,
   listPendingUsersController,
   rejectUserController,
   unblockUserController,
} from '../controllers/account-admin-controller.js'
import { createAdminMiddleware } from '../middleware/admin-middleware.js'
import { createAuthMiddleware } from '../middleware/auth-middleware.js'
import { accountAdminService } from '../services/account-admin-service.js'
import { telegramAuthService } from '../services/telegram-auth-service.js'

function createAdminRouter(authService = telegramAuthService, service = accountAdminService) {
   const router = express.Router()

   router.use(createAuthMiddleware(authService), createAdminMiddleware(service))

   router.get('/users/pending', listPendingUsersController)
   router.post('/users/:userId/approve', approveUserController)
   router.post('/users/:userId/reject', rejectUserController)
   router.post('/users/:userId/block', blockUserController)
   router.post('/users/:userId/unblock', unblockUserController)

   return router
}

const adminRouter = createAdminRouter()

export { createAdminRouter }
export default adminRouter
