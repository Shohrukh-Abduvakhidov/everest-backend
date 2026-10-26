import express from 'express'

import {
   approveUserController,
   blockUserController,
   listPendingUsersController,
   rejectUserController,
   unblockUserController,
} from '../controllers/account-admin-controller.js'
import { adminMiddleware } from '../middleware/admin-middleware.js'
import { authMiddleware } from '../middleware/auth-middleware.js'

const adminRouter = express.Router()

adminRouter.use(authMiddleware, adminMiddleware)
adminRouter.get('/users/pending', listPendingUsersController)
adminRouter.post('/users/:userId/approve', approveUserController)
adminRouter.post('/users/:userId/reject', rejectUserController)
adminRouter.post('/users/:userId/block', blockUserController)
adminRouter.post('/users/:userId/unblock', unblockUserController)

export default adminRouter
