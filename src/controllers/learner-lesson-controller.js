import {
   addCourseFavoriteService,
   createLessonNoteService,
   deleteLessonNoteService,
   getLearnerLessonService,
   getLessonMaterialDownloadService,
   getLessonPlaybackService,
   getLessonProgressService,
   listCourseFavoritesService,
   listLearnerLessonsService,
   listLessonNotesService,
   removeCourseFavoriteService,
   saveLessonProgressService,
   updateLessonNoteService,
} from '../services/learner-lesson-service.js'

function overrides(req) {
   return req.app.locals.serviceDependencies.lessons
}

async function listLearnerLessonsController(req, res, next) {
   try {
      const data = await listLearnerLessonsService(
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

async function getLearnerLessonController(req, res, next) {
   try {
      const data = await getLearnerLessonService(
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

async function getLessonPlaybackController(req, res, next) {
   try {
      const data = await getLessonPlaybackService(
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

async function getLessonMaterialDownloadController(req, res, next) {
   try {
      const data = await getLessonMaterialDownloadService(
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

async function listLessonNotesController(req, res, next) {
   try {
      const data = await listLessonNotesService(
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

async function createLessonNoteController(req, res, next) {
   try {
      const data = await createLessonNoteService(
         req.auth.userId,
         req.params.courseId,
         req.params.lessonId,
         req.body,
         overrides(req),
      )
      res.status(201).json({ data })
   } catch (error) {
      next(error)
   }
}

async function updateLessonNoteController(req, res, next) {
   try {
      const data = await updateLessonNoteService(
         req.auth.userId,
         req.params.courseId,
         req.params.lessonId,
         req.params.noteId,
         req.body,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function deleteLessonNoteController(req, res, next) {
   try {
      const data = await deleteLessonNoteService(
         req.auth.userId,
         req.params.courseId,
         req.params.lessonId,
         req.params.noteId,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function getLessonProgressController(req, res, next) {
   try {
      const data = await getLessonProgressService(
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

async function saveLessonProgressController(req, res, next) {
   try {
      const data = await saveLessonProgressService(
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

async function listCourseFavoritesController(req, res, next) {
   try {
      const data = await listCourseFavoritesService(req.auth.userId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function addCourseFavoriteController(req, res, next) {
   try {
      const data = await addCourseFavoriteService(
         req.auth.userId,
         req.params.courseId,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function removeCourseFavoriteController(req, res, next) {
   try {
      const data = await removeCourseFavoriteService(
         req.auth.userId,
         req.params.courseId,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

export {
   addCourseFavoriteController,
   createLessonNoteController,
   deleteLessonNoteController,
   getLearnerLessonController,
   getLessonMaterialDownloadController,
   getLessonPlaybackController,
   getLessonProgressController,
   listCourseFavoritesController,
   listLearnerLessonsController,
   listLessonNotesController,
   removeCourseFavoriteController,
   saveLessonProgressController,
   updateLessonNoteController,
}
