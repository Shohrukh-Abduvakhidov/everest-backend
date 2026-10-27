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
   createGroupAuthorizationMiddleware,
   manageGroupMembersAuthorizationMiddleware,
   manageGroupTeachersAuthorizationMiddleware,
   updateGroupAuthorizationMiddleware,
} from '../middleware/group-admin-middleware.js'
import {
   addGroupMemberController,
   addGroupTeacherController,
   createGroupController,
   removeGroupMemberController,
   removeGroupTeacherController,
   updateGroupController,
} from '../controllers/group-controller.js'
import {
   adminMutationRateMiddleware,
   authenticatedCsrfMiddleware,
} from '../middleware/auth-protection-middleware.js'

const adminRouter = express.Router()

adminRouter.use(authMiddleware)
adminRouter.post(
   '/groups',
   createGroupAuthorizationMiddleware,
   authenticatedCsrfMiddleware,
   adminMutationRateMiddleware,
   createGroupController,
)
adminRouter.patch(
   '/groups/:groupId',
   updateGroupAuthorizationMiddleware,
   authenticatedCsrfMiddleware,
   adminMutationRateMiddleware,
   updateGroupController,
)
adminRouter.post(
   '/groups/:groupId/members',
   manageGroupMembersAuthorizationMiddleware,
   authenticatedCsrfMiddleware,
   adminMutationRateMiddleware,
   addGroupMemberController,
)
adminRouter.delete(
   '/groups/:groupId/members/:userId',
   manageGroupMembersAuthorizationMiddleware,
   authenticatedCsrfMiddleware,
   adminMutationRateMiddleware,
   removeGroupMemberController,
)
adminRouter.post(
   '/groups/:groupId/teachers',
   manageGroupTeachersAuthorizationMiddleware,
   authenticatedCsrfMiddleware,
   adminMutationRateMiddleware,
   addGroupTeacherController,
)
adminRouter.delete(
   '/groups/:groupId/teachers/:userId',
   manageGroupTeachersAuthorizationMiddleware,
   authenticatedCsrfMiddleware,
   adminMutationRateMiddleware,
   removeGroupTeacherController,
)
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
