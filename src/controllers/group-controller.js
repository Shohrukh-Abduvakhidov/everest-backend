import {
   getGroupService,
   listGroupMembersService,
   listGroupsService,
   listGroupTeachersService,
} from '../services/group-service.js'

async function listGroupsController(req, res, next) {
   try {
      const data = await listGroupsService(
         req.auth.userId,
         req.query,
         req.app.locals.serviceDependencies.groups,
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function getGroupController(req, res, next) {
   try {
      const data = await getGroupService(
         req.auth.userId,
         req.params.groupId,
         req.app.locals.serviceDependencies.groups,
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function listGroupMembersController(req, res, next) {
   try {
      const data = await listGroupMembersService(
         req.auth.userId,
         req.params.groupId,
         req.query,
         req.app.locals.serviceDependencies.groups,
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function listGroupTeachersController(req, res, next) {
   try {
      const data = await listGroupTeachersService(
         req.auth.userId,
         req.params.groupId,
         req.query,
         req.app.locals.serviceDependencies.groups,
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

export {
   getGroupController,
   listGroupMembersController,
   listGroupsController,
   listGroupTeachersController,
}
