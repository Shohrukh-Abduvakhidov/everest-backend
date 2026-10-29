import { getStorageProvider } from '../providers/storage/index.js'
import * as authRepository from '../repositories/auth-repository.js'
import * as learnerLessonRepository from '../repositories/learner-lesson-repository.js'
import * as lessonRepository from '../repositories/lesson-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import AppError from '../utils/app-error.js'
import { parseCourseId, parseId, parseUserId, validateBody, validationError } from './course-service.js'
import { requireModuleAccessService } from './learner-course-service.js'
import {
   issueMaterialUrl,
   issueVideoUrl,
   parseLessonId,
   parseNonNegativeSeconds,
   safeChapter,
   videoPlayable,
} from './lesson-service.js'

const maximumNoteLength = 10000
const maximumNotesPerLesson = 500
const completionRatio = 0.9

function dependencies(overrides = {}) {
   return {
      learner: overrides.learner || learnerLessonRepository,
      lessons: overrides.repository || lessonRepository,
      auth: overrides.auth || authRepository,
      transaction: overrides.transaction || withTransaction,
      storage: () => overrides.storage || getStorageProvider(),
      clock: overrides.clock || (() => new Date()),
      requireAccess: overrides.requireAccess || requireModuleAccessService,
   }
}

function iso(value) {
   return value === null || value === undefined ? null : new Date(value).toISOString()
}

function lessonNotFound() {
   return new AppError(404, 'LESSON_NOT_FOUND', 'Lesson was not found')
}

function parseModuleId(value) {
   return parseId(value, 'INVALID_MODULE_ID', 'Module identifier is invalid')
}

function parseNoteId(value) {
   return parseId(value, 'INVALID_NOTE_ID', 'Note identifier is invalid')
}

async function requireLearnerLesson(deps, actorId, courseId, lessonId) {
   const lesson = await deps.learner.findLearnerLesson(actorId, courseId, lessonId)
   if (!lesson) throw lessonNotFound()
   return lesson
}

// Denied content requests are audited; successful playback issuance is not.
async function requireLessonAccess(deps, actorId, lesson, action) {
   try {
      await deps.requireAccess(actorId, lesson.module_id)
   } catch (error) {
      if (error.code === 'MODULE_ACCESS_DENIED' && action) {
         await deps.transaction((client) => deps.auth.appendAuditEvent({
            actorUserId: actorId,
            subjectUserId: actorId,
            code: `lesson.${action}.denied`,
            entityType: 'lesson',
            entityId: lesson.id,
            metadata: { courseId: lesson.course_id, moduleId: lesson.module_id },
         }, client))
      }
      throw error
   }
}

async function requirePlayableVideo(deps, lesson) {
   const asset = lesson.video_asset_id && await deps.lessons.findAsset(lesson.video_asset_id)
   if (!videoPlayable(asset)) {
      throw new AppError(409, 'VIDEO_NOT_PLAYABLE', 'This lesson has no playable video')
   }
   return asset
}

function safeLearnerLessonSummary(row) {
   return {
      id: row.id,
      moduleId: row.module_id,
      title: row.title,
      position: row.position,
      lessonType: row.lesson_type,
      translations: row.translations,
      access: { granted: row.granted === true },
   }
}

function safeLearnerResource(row) {
   return {
      id: row.resource_id,
      title: row.resource_title,
      position: row.position,
      fileName: row.file_name,
      mimeType: row.mime_type,
      sizeBytes: Number(row.size_bytes),
   }
}

function safeProgress(row) {
   if (!row) {
      return {
         status: 'not_started',
         playbackSeconds: 0,
         watchedSeconds: 0,
         completedAt: null,
         revision: 0,
      }
   }
   return {
      status: row.status,
      playbackSeconds: row.playback_seconds,
      watchedSeconds: row.watched_seconds,
      completedAt: iso(row.completed_at),
      revision: Number(row.revision),
      updatedAt: iso(row.updated_at),
   }
}

function safeNote(row) {
   return {
      id: row.id,
      lessonId: row.lesson_id,
      body: row.body,
      playbackSeconds: row.playback_seconds,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
   }
}

async function listLearnerLessonsService(userId, courseIdValue, moduleIdValue, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const moduleId = parseModuleId(moduleIdValue)
   if (!await deps.learner.hasLearnerCourse(actorId, courseId)) {
      throw new AppError(404, 'COURSE_NOT_FOUND', 'Course was not found')
   }
   const lessons = await deps.learner.listLearnerModuleLessons(actorId, courseId, moduleId)
   return { lessons: lessons.map(safeLearnerLessonSummary) }
}

// Locked lessons return metadata only. Content, chapters, materials, playback
// availability and progress appear only after the module access guard passes.
async function getLearnerLessonService(userId, courseIdValue, lessonIdValue, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const lessonId = parseLessonId(lessonIdValue)
   const lesson = await requireLearnerLesson(deps, actorId, courseId, lessonId)
   if (!lesson.granted) return { lesson: safeLearnerLessonSummary(lesson) }
   await deps.requireAccess(actorId, lesson.module_id)
   const [asset, chapters, resources, progress] = await Promise.all([
      lesson.video_asset_id ? deps.lessons.findAsset(lesson.video_asset_id) : null,
      deps.lessons.listChapters([lesson.id]),
      deps.lessons.listResources([lesson.id]),
      deps.learner.findProgress(actorId, lesson.id),
   ])
   return {
      lesson: {
         ...safeLearnerLessonSummary(lesson),
         content: lesson.content,
         allowOffline: lesson.allow_offline,
         video: asset ? { durationSeconds: asset.duration_seconds, playable: videoPlayable(asset) } : null,
         chapters: chapters.map(safeChapter),
         resources: resources.filter((row) => row.status === 'ready').map(safeLearnerResource),
         progress: safeProgress(progress),
      },
   }
}

async function getLessonPlaybackService(userId, courseIdValue, lessonIdValue, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const lessonId = parseLessonId(lessonIdValue)
   const lesson = await requireLearnerLesson(deps, actorId, courseId, lessonId)
   await requireLessonAccess(deps, actorId, lesson, 'playback')
   const asset = await requirePlayableVideo(deps, lesson)
   const chapters = await deps.lessons.listChapters([lesson.id])
   return {
      playback: await issueVideoUrl(deps.storage(), asset, deps.clock),
      chapters: chapters.map(safeChapter),
   }
}

async function getLessonMaterialDownloadService(
   userId,
   courseIdValue,
   lessonIdValue,
   resourceIdValue,
   overrides,
) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const lessonId = parseLessonId(lessonIdValue)
   const resourceId = parseId(resourceIdValue, 'INVALID_RESOURCE_ID', 'Resource identifier is invalid')
   const lesson = await requireLearnerLesson(deps, actorId, courseId, lessonId)
   await requireLessonAccess(deps, actorId, lesson, 'material')
   const resource = (await deps.lessons.listResources([lesson.id]))
      .find((row) => row.resource_id === resourceId)
   if (!resource || resource.status !== 'ready') {
      throw new AppError(404, 'RESOURCE_NOT_FOUND', 'Lesson material was not found')
   }
   return { download: await issueMaterialUrl(deps.storage(), resource, deps.clock) }
}

async function videoDuration(deps, lesson) {
   if (!lesson.video_asset_id) return null
   const asset = await deps.lessons.findAsset(lesson.video_asset_id)
   return asset ? asset.duration_seconds : null
}

function parseNotePlayback(value, duration) {
   if (value === null) return null
   const seconds = parseNonNegativeSeconds(value, 'playbackSeconds')
   if (duration !== null && seconds > duration) {
      throw validationError('playbackSeconds', 'playbackSeconds is beyond the end of the video')
   }
   return seconds
}

function parseNoteBody(value) {
   if (typeof value !== 'string' || !value.trim() || value.length > maximumNoteLength) {
      throw validationError('body')
   }
   return value
}

async function accessibleLesson(deps, actorId, courseIdValue, lessonIdValue) {
   const courseId = parseCourseId(courseIdValue)
   const lessonId = parseLessonId(lessonIdValue)
   const lesson = await requireLearnerLesson(deps, actorId, courseId, lessonId)
   await deps.requireAccess(actorId, lesson.module_id)
   return lesson
}

async function listLessonNotesService(userId, courseIdValue, lessonIdValue, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const lesson = await accessibleLesson(deps, actorId, courseIdValue, lessonIdValue)
   const notes = await deps.learner.listNotes(actorId, lesson.id)
   return { notes: notes.map(safeNote) }
}

async function createLessonNoteService(userId, courseIdValue, lessonIdValue, body, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   validateBody(body, ['body', 'playbackSeconds'])
   const lesson = await accessibleLesson(deps, actorId, courseIdValue, lessonIdValue)
   const duration = await videoDuration(deps, lesson)
   const values = {
      userId: actorId,
      lessonId: lesson.id,
      body: parseNoteBody(body.body),
      playbackSeconds: body.playbackSeconds === undefined
         ? null
         : parseNotePlayback(body.playbackSeconds, duration),
   }
   const note = await deps.transaction(async (client) => {
      await deps.learner.lockUser(actorId, client)
      if (await deps.learner.countNotes(actorId, lesson.id, client) >= maximumNotesPerLesson) {
         throw new AppError(409, 'NOTE_LIMIT_REACHED', 'Too many notes for this lesson')
      }
      return deps.learner.createNote(values, client)
   })
   return { note: safeNote(note) }
}

async function updateLessonNoteService(userId, courseIdValue, lessonIdValue, noteIdValue, body, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const noteId = parseNoteId(noteIdValue)
   validateBody(body, ['body', 'playbackSeconds'])
   if (!Object.keys(body).length) throw validationError('body')
   const lesson = await accessibleLesson(deps, actorId, courseIdValue, lessonIdValue)
   const duration = await videoDuration(deps, lesson)
   const note = await deps.learner.updateNote(actorId, lesson.id, noteId, {
      body: body.body === undefined ? null : parseNoteBody(body.body),
      hasPlaybackSeconds: body.playbackSeconds !== undefined,
      playbackSeconds: body.playbackSeconds === undefined
         ? null
         : parseNotePlayback(body.playbackSeconds, duration),
   })
   if (!note) throw new AppError(404, 'NOTE_NOT_FOUND', 'Note was not found')
   return { note: safeNote(note) }
}

async function deleteLessonNoteService(userId, courseIdValue, lessonIdValue, noteIdValue, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const noteId = parseNoteId(noteIdValue)
   const lesson = await accessibleLesson(deps, actorId, courseIdValue, lessonIdValue)
   if (!await deps.learner.deleteNote(actorId, lesson.id, noteId)) {
      throw new AppError(404, 'NOTE_NOT_FOUND', 'Note was not found')
   }
   return { id: noteId, status: 'deleted' }
}

async function getLessonProgressService(userId, courseIdValue, lessonIdValue, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const lesson = await accessibleLesson(deps, actorId, courseIdValue, lessonIdValue)
   return { progress: safeProgress(await deps.learner.findProgress(actorId, lesson.id)) }
}

function clamp(value, duration) {
   return duration === null ? value : Math.min(value, duration)
}

// Video lessons report positions; completion is derived (90% watched of a known
// duration). Lessons without a video are completed explicitly with completed: true.
async function saveLessonProgressService(userId, courseIdValue, lessonIdValue, body, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   validateBody(body, ['revision', 'playbackSeconds', 'watchedSeconds', 'completed'])
   if (!Number.isSafeInteger(body.revision) || body.revision < 0) throw validationError('revision')
   const lesson = await accessibleLesson(deps, actorId, courseIdValue, lessonIdValue)
   const current = await deps.learner.findProgress(actorId, lesson.id)
   const currentRevision = current ? Number(current.revision) : 0
   const hasVideo = Boolean(lesson.video_asset_id)
   let playbackSeconds = current ? current.playback_seconds : 0
   let watchedSeconds = current ? current.watched_seconds : 0
   let completed = current?.status === 'completed'
   if (hasVideo) {
      if (body.completed !== undefined) {
         throw validationError('completed', 'Video lesson completion is derived from watched time')
      }
      const duration = await videoDuration(deps, lesson)
      playbackSeconds = clamp(parseNonNegativeSeconds(body.playbackSeconds, 'playbackSeconds'), duration)
      watchedSeconds = Math.max(
         watchedSeconds,
         clamp(parseNonNegativeSeconds(body.watchedSeconds, 'watchedSeconds'), duration),
      )
      if (duration && watchedSeconds >= Math.ceil(duration * completionRatio)) completed = true
   } else {
      if (body.playbackSeconds !== undefined || body.watchedSeconds !== undefined
         || body.completed !== true) {
         throw validationError('completed', 'Lessons without a video accept only completed: true')
      }
      completed = true
   }
   const conflictError = new AppError(
      409,
      'PROGRESS_REVISION_CONFLICT',
      'Progress was updated elsewhere; reload and retry',
      [{ revision: currentRevision }],
   )
   if (body.revision !== currentRevision) throw conflictError
   const written = await deps.learner.writeProgress({
      userId: actorId,
      lessonId: lesson.id,
      status: completed ? 'completed' : 'in_progress',
      playbackSeconds,
      watchedSeconds,
      completed,
      revision: body.revision,
   })
   if (!written) throw conflictError
   return { progress: safeProgress(written) }
}

async function requireVisibleCourse(deps, actorId, courseIdValue) {
   const courseId = parseCourseId(courseIdValue)
   if (!await deps.learner.hasLearnerCourse(actorId, courseId)) {
      throw new AppError(404, 'COURSE_NOT_FOUND', 'Course was not found')
   }
   return courseId
}

async function listCourseFavoritesService(userId, overrides) {
   const deps = dependencies(overrides)
   const rows = await deps.learner.listFavorites(parseUserId(userId))
   return {
      favorites: rows.map((row) => ({
         courseId: row.id,
         title: row.title,
         translations: row.translations,
         coverAssetId: row.cover_asset_id,
         createdAt: iso(row.created_at),
      })),
   }
}

async function addCourseFavoriteService(userId, courseIdValue, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = await requireVisibleCourse(deps, actorId, courseIdValue)
   await deps.learner.addFavorite(actorId, courseId)
   return { courseId, favorite: true }
}

async function removeCourseFavoriteService(userId, courseIdValue, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   await deps.learner.removeFavorite(actorId, courseId)
   return { courseId, favorite: false }
}

export {
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
}
