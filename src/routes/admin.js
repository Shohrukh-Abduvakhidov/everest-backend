import express from 'express'

import {
   approveUserController,
   blockUserController,
   listPendingUsersController,
   rejectUserController,
   unblockUserController,
} from '../controllers/account-admin-controller.js'
import {
   approveUserAuthorizationMiddleware,
   blockUserAuthorizationMiddleware,
   listPendingUsersAuthorizationMiddleware,
   rejectUserAuthorizationMiddleware,
   unblockUserAuthorizationMiddleware,
} from '../middleware/admin-middleware.js'
import { authMiddleware } from '../middleware/auth-middleware.js'

const adminRouter = express.Router()

adminRouter.use(authMiddleware)
adminRouter.get(
   '/users/pending',
   listPendingUsersAuthorizationMiddleware,
   listPendingUsersController,
)
adminRouter.post(
   '/users/:userId/approve',
   approveUserAuthorizationMiddleware,
   approveUserController,
)
adminRouter.post(
   '/users/:userId/reject',
   rejectUserAuthorizationMiddleware,
   rejectUserController,
)
adminRouter.post(
   '/users/:userId/block',
   blockUserAuthorizationMiddleware,
   blockUserController,
)
adminRouter.post(
   '/users/:userId/unblock',
   unblockUserAuthorizationMiddleware,
   unblockUserController,
)

export default adminRouter
