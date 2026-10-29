import {
   archiveLessonService,
   createLessonService,
   deleteLessonService,
   getLessonService,
   listModuleLessonsService,
   previewLessonPlaybackService,
   previewLessonResourceService,
   publishLessonService,
   reorderLessonsService,
   replaceLessonChaptersService,
   replaceLessonResourcesService,
   restoreLessonService,
   updateLessonService,
} from '../services/lesson-service.js'

function overrides(req) {
   return req.app.locals.serviceDependencies.lessons
}

async function listModuleLessonsController(req, res, next) {
   try {
      const data = await listModuleLessonsService(
         req.auth.userId,
         req.params.courseId,
         req.params.moduleId,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function createLessonController(req, res, next) {
   try {
      const data = await createLessonService(
         req.auth.userId,
         req.params.courseId,
         req.params.moduleId,
         req.body,
         overrides(req),
      )
      res.status(201).json({ data })
   } catch (error) {
      next(error)
   }
}

async function reorderLessonsController(req, res, next) {
   try {
      const data = await reorderLessonsService(
         req.auth.userId,
         req.params.courseId,
         req.params.moduleId,
         req.body,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function getLessonController(req, res, next) {
   try {
      const data = await getLessonService(
         req.auth.userId,
         req.params.courseId,
         req.params.lessonId,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function updateLessonController(req, res, next) {
   try {
      const data = await updateLessonService(
         req.auth.userId,
         req.params.courseId,
         req.params.lessonId,
         req.body,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function publishLessonController(req, res, next) {
   try {
      const data = await publishLessonService(
         req.auth.userId,
         req.params.courseId,
         req.params.lessonId,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function archiveLessonController(req, res, next) {
   try {
      const data = await archiveLessonService(
         req.auth.userId,
         req.params.courseId,
         req.params.lessonId,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function restoreLessonController(req, res, next) {
   try {
      const data = await restoreLessonService(
         req.auth.userId,
         req.params.courseId,
         req.params.lessonId,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function deleteLessonController(req, res, next) {
   try {
      const data = await deleteLessonService(
         req.auth.userId,
         req.params.courseId,
         req.params.lessonId,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function replaceLessonChaptersController(req, res, next) {
   try {
      const data = await replaceLessonChaptersService(
         req.auth.userId,
         req.params.courseId,
         req.params.lessonId,
         req.body,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function replaceLessonResourcesController(req, res, next) {
   try {
      const data = await replaceLessonResourcesService(
         req.auth.userId,
         req.params.courseId,
         req.params.lessonId,
         req.body,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function previewLessonPlaybackController(req, res, next) {
   try {
      const data = await previewLessonPlaybackService(
         req.auth.userId,
         req.params.courseId,
         req.params.lessonId,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function previewLessonResourceController(req, res, next) {
   try {
      const data = await previewLessonResourceService(
         req.auth.userId,
         req.params.courseId,
         req.params.lessonId,
         req.params.resourceId,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

export {
   archiveLessonController,
   createLessonController,
   deleteLessonController,
   getLessonController,
   listModuleLessonsController,
   previewLessonPlaybackController,
   previewLessonResourceController,
   publishLessonController,
   reorderLessonsController,
   replaceLessonChaptersController,
   replaceLessonResourcesController,
   restoreLessonController,
   updateLessonController,
}
