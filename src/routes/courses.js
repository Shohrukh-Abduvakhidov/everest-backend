import express from 'express'

import {
   listLearnerCourseModulesController,
   listLearnerCoursesController,
} from '../controllers/learner-course-controller.js'
import {
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
} from '../controllers/learner-lesson-controller.js'
import { issueOfflineLicenseController } from '../controllers/offline-license-controller.js'
import { authMiddleware } from '../middleware/auth-middleware.js'
import {
   authenticatedCsrfMiddleware,
   learnerMediaRateMiddleware,
} from '../middleware/auth-protection-middleware.js'

const coursesRouter = express.Router()
const lessonPath = '/:courseId/lessons/:lessonId'

coursesRouter.use(authMiddleware)
coursesRouter.get('/', listLearnerCoursesController)
coursesRouter.get('/favorites', listCourseFavoritesController)
coursesRouter.put('/:courseId/favorite', authenticatedCsrfMiddleware, addCourseFavoriteController)
coursesRouter.delete('/:courseId/favorite', authenticatedCsrfMiddleware, removeCourseFavoriteController)
coursesRouter.get('/:courseId/modules', listLearnerCourseModulesController)
coursesRouter.get('/:courseId/modules/:moduleId/lessons', listLearnerLessonsController)
coursesRouter.get(lessonPath, getLearnerLessonController)
coursesRouter.get(`${lessonPath}/playback`, learnerMediaRateMiddleware, getLessonPlaybackController)
coursesRouter.get(
   `${lessonPath}/resources/:resourceId/download`,
   learnerMediaRateMiddleware,
   getLessonMaterialDownloadController,
)
coursesRouter.post(
   `${lessonPath}/offline-license`,
   authenticatedCsrfMiddleware,
   learnerMediaRateMiddleware,
   issueOfflineLicenseController,
)
coursesRouter.get(`${lessonPath}/notes`, listLessonNotesController)
coursesRouter.post(`${lessonPath}/notes`, authenticatedCsrfMiddleware, createLessonNoteController)
coursesRouter.patch(
   `${lessonPath}/notes/:noteId`,
   authenticatedCsrfMiddleware,
   updateLessonNoteController,
)
coursesRouter.delete(
   `${lessonPath}/notes/:noteId`,
   authenticatedCsrfMiddleware,
   deleteLessonNoteController,
)
coursesRouter.get(`${lessonPath}/progress`, getLessonProgressController)
coursesRouter.put(`${lessonPath}/progress`, authenticatedCsrfMiddleware, saveLessonProgressController)

export default coursesRouter
