import express from 'express'

import {
   archiveGroupAnnouncementController,
   createGroupAnnouncementController,
   getGroupController,
   listGroupMembersController,
   listGroupsController,
   listGroupTeachersController,
   listGroupAnnouncementsController,
   updateGroupAnnouncementController,
} from '../controllers/group-controller.js'
import { authMiddleware } from '../middleware/auth-middleware.js'
import { authenticatedCsrfMiddleware } from '../middleware/auth-protection-middleware.js'
import { manageGroupAnnouncementsAuthorizationMiddleware } from '../middleware/group-admin-middleware.js'

const groupsRouter = express.Router()

groupsRouter.use(authMiddleware)
groupsRouter.get('/', listGroupsController)
groupsRouter.get('/:groupId', getGroupController)
groupsRouter.get('/:groupId/members', listGroupMembersController)
groupsRouter.get('/:groupId/teachers', listGroupTeachersController)
groupsRouter.get('/:groupId/announcements', listGroupAnnouncementsController)
groupsRouter.post(
   '/:groupId/announcements',
   manageGroupAnnouncementsAuthorizationMiddleware,
   authenticatedCsrfMiddleware,
   createGroupAnnouncementController,
)
groupsRouter.patch(
   '/:groupId/announcements/:announcementId',
   manageGroupAnnouncementsAuthorizationMiddleware,
   authenticatedCsrfMiddleware,
   updateGroupAnnouncementController,
)
groupsRouter.delete(
   '/:groupId/announcements/:announcementId',
   manageGroupAnnouncementsAuthorizationMiddleware,
   authenticatedCsrfMiddleware,
   archiveGroupAnnouncementController,
)

export default groupsRouter
