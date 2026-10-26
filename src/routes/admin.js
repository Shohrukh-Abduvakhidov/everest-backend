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
import {
   adminMutationRateMiddleware,
   authenticatedCsrfMiddleware,
} from '../middleware/auth-protection-middleware.js'

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
   authenticatedCsrfMiddleware,
   adminMutationRateMiddleware,
   approveUserController,
)
adminRouter.post(
   '/users/:userId/reject',
   rejectUserAuthorizationMiddleware,
   authenticatedCsrfMiddleware,
   adminMutationRateMiddleware,
   rejectUserController,
)
adminRouter.post(
   '/users/:userId/block',
   blockUserAuthorizationMiddleware,
   authenticatedCsrfMiddleware,
   adminMutationRateMiddleware,
   blockUserController,
)
adminRouter.post(
   '/users/:userId/unblock',
   unblockUserAuthorizationMiddleware,
   authenticatedCsrfMiddleware,
   adminMutationRateMiddleware,
   unblockUserController,
)

export default adminRouter
