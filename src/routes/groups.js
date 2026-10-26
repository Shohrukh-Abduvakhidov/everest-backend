import express from 'express'

import {
   getGroupController,
   listGroupMembersController,
   listGroupsController,
   listGroupTeachersController,
} from '../controllers/group-controller.js'
import { authMiddleware } from '../middleware/auth-middleware.js'

const groupsRouter = express.Router()

groupsRouter.use(authMiddleware)
groupsRouter.get('/', listGroupsController)
groupsRouter.get('/:groupId', getGroupController)
groupsRouter.get('/:groupId/members', listGroupMembersController)
groupsRouter.get('/:groupId/teachers', listGroupTeachersController)

export default groupsRouter
