import {
   addGroupMemberService,
   addGroupTeacherService,
   archiveGroupAnnouncementService,
   createGroupAnnouncementService,
   createGroupService,
   getGroupService,
   listGroupMembersService,
   listGroupsService,
   listGroupTeachersService,
   listGroupAnnouncementsService,
   removeGroupMemberService,
   removeGroupTeacherService,
   updateGroupAnnouncementService,
   updateGroupMemberService,
   updateGroupService,
   updateGroupTeacherService,
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

async function createGroupController(req, res, next) {
   try {
      const data = await createGroupService(
         req.auth.userId,
         req.body,
         req.app.locals.serviceDependencies.groups,
      )
      res.status(201).json({ data })
   } catch (error) {
      next(error)
   }
}

async function updateGroupController(req, res, next) {
   try {
      const data = await updateGroupService(
         req.auth.userId,
         req.params.groupId,
         req.body,
         req.app.locals.serviceDependencies.groups,
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function addGroupMemberController(req, res, next) {
   try {
      const data = await addGroupMemberService(
         req.auth.userId,
         req.params.groupId,
         req.body,
         req.app.locals.serviceDependencies.groups,
      )
      res.status(201).json({ data })
   } catch (error) {
      next(error)
   }
}

async function removeGroupMemberController(req, res, next) {
   try {
      const data = await removeGroupMemberService(
         req.auth.userId,
         req.params.groupId,
         req.params.userId,
         req.app.locals.serviceDependencies.groups,
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function addGroupTeacherController(req, res, next) {
   try {
      const data = await addGroupTeacherService(
         req.auth.userId,
         req.params.groupId,
         req.body,
         req.app.locals.serviceDependencies.groups,
      )
      res.status(201).json({ data })
   } catch (error) {
      next(error)
   }
}

async function removeGroupTeacherController(req, res, next) {
   try {
      const data = await removeGroupTeacherService(
         req.auth.userId,
         req.params.groupId,
         req.params.userId,
         req.app.locals.serviceDependencies.groups,
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function updateGroupMemberController(req, res, next) {
   try {
      const data = await updateGroupMemberService(
         req.auth.userId,
         req.params.groupId,
         req.params.userId,
         req.body,
         req.app.locals.serviceDependencies.groups,
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function updateGroupTeacherController(req, res, next) {
   try {
      const data = await updateGroupTeacherService(
         req.auth.userId,
         req.params.groupId,
         req.params.userId,
         req.body,
         req.app.locals.serviceDependencies.groups,
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function listGroupAnnouncementsController(req, res, next) {
   try {
      const data = await listGroupAnnouncementsService(
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

async function createGroupAnnouncementController(req, res, next) {
   try {
      const data = await createGroupAnnouncementService(
         req.auth.userId,
         req.params.groupId,
         req.body,
         req.app.locals.serviceDependencies.groups,
      )
      res.status(201).json({ data })
   } catch (error) {
      next(error)
   }
}

async function updateGroupAnnouncementController(req, res, next) {
   try {
      const data = await updateGroupAnnouncementService(
         req.auth.userId,
         req.params.groupId,
         req.params.announcementId,
         req.body,
         req.app.locals.serviceDependencies.groups,
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function archiveGroupAnnouncementController(req, res, next) {
   try {
      const data = await archiveGroupAnnouncementService(
         req.auth.userId,
         req.params.groupId,
         req.params.announcementId,
         req.app.locals.serviceDependencies.groups,
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

export {
   addGroupMemberController,
   addGroupTeacherController,
   archiveGroupAnnouncementController,
   createGroupAnnouncementController,
   createGroupController,
   getGroupController,
   listGroupMembersController,
   listGroupsController,
   listGroupTeachersController,
   listGroupAnnouncementsController,
   removeGroupMemberController,
   removeGroupTeacherController,
   updateGroupAnnouncementController,
   updateGroupMemberController,
   updateGroupController,
   updateGroupTeacherController,
}
