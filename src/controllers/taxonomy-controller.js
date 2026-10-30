import {
   createSectionService,
   createSubjectService,
   createTopicService,
   deleteSectionService,
   deleteSubjectService,
   deleteTopicService,
   listSectionsService,
   listSubjectsService,
   listTopicsService,
   updateSectionService,
   updateSubjectService,
   updateTopicService,
} from '../services/taxonomy-service.js'

function overrides(req) {
   return req.app.locals.serviceDependencies.taxonomy
}

async function listSubjectsController(req, res, next) {
   try {
      const data = await listSubjectsService(overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function createSubjectController(req, res, next) {
   try {
      const data = await createSubjectService(req.auth.userId, req.body, overrides(req))
      res.status(201).json({ data })
   } catch (error) {
      next(error)
   }
}

async function updateSubjectController(req, res, next) {
   try {
      const data = await updateSubjectService(
         req.auth.userId,
         req.params.subjectId,
         req.body,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function deleteSubjectController(req, res, next) {
   try {
      const data = await deleteSubjectService(req.auth.userId, req.params.subjectId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function listSectionsController(req, res, next) {
   try {
      const data = await listSectionsService(req.params.subjectId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function createSectionController(req, res, next) {
   try {
      const data = await createSectionService(
         req.auth.userId,
         req.params.subjectId,
         req.body,
         overrides(req),
      )
      res.status(201).json({ data })
   } catch (error) {
      next(error)
   }
}

async function updateSectionController(req, res, next) {
   try {
      const data = await updateSectionService(
         req.auth.userId,
         req.params.sectionId,
         req.body,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function deleteSectionController(req, res, next) {
   try {
      const data = await deleteSectionService(req.auth.userId, req.params.sectionId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function listTopicsController(req, res, next) {
   try {
      const data = await listTopicsService(req.params.subjectId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function createTopicController(req, res, next) {
   try {
      const data = await createTopicService(
         req.auth.userId,
         req.params.subjectId,
         req.body,
         overrides(req),
      )
      res.status(201).json({ data })
   } catch (error) {
      next(error)
   }
}

async function updateTopicController(req, res, next) {
   try {
      const data = await updateTopicService(
         req.auth.userId,
         req.params.topicId,
         req.body,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function deleteTopicController(req, res, next) {
   try {
      const data = await deleteTopicService(req.auth.userId, req.params.topicId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

export {
   createSectionController,
   createSubjectController,
   createTopicController,
   deleteSectionController,
   deleteSubjectController,
   deleteTopicController,
   listSectionsController,
   listSubjectsController,
   listTopicsController,
   updateSectionController,
   updateSubjectController,
   updateTopicController,
}
