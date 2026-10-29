import { getStorageProvider } from '../providers/storage/index.js'
import * as authRepository from '../repositories/auth-repository.js'
import * as lessonRepository from '../repositories/lesson-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import AppError from '../utils/app-error.js'
import {
   parseCourseId,
   parseId,
   parseText,
   parseUserId,
   validateBody,
   validationError,
} from './course-service.js'

const languages = ['tg', 'ru', 'en']
const lessonTypes = ['video', 'text', 'test', 'mixed']
const videoLessonTypes = ['video', 'mixed']
const lessonFields = ['title', 'lessonType', 'content', 'translations', 'videoAssetId', 'allowOffline']
const maximumTitleLength = 200
const maximumLessonsPerOrder = 1000
const maximumBlocks = 200
const maximumContentBytes = 256 * 1024
const maximumChapters = 100
const maximumResources = 50
const playbackUrlTtlSeconds = 30 * 60
const materialUrlTtlSeconds = 5 * 60

// Allowed content block shapes. Blocks are plain text structures; no HTML, scripts or
// embedded asset references are accepted (images belong to materials).
const blockFields = Object.freeze({
   heading: ['text', 'level'],
   paragraph: ['text'],
   list: ['items', 'ordered'],
   quote: ['text'],
   code: ['text', 'language'],
   callout: ['text', 'tone'],
   divider: [],
})

function dependencies(overrides = {}) {
   return {
      repository: overrides.repository || lessonRepository,
      auth: overrides.auth || authRepository,
      transaction: overrides.transaction || withTransaction,
      storage: () => overrides.storage || getStorageProvider(),
      clock: overrides.clock || (() => new Date()),
   }
}

function iso(value) {
   return value === null || value === undefined ? null : new Date(value).toISOString()
}

function parseLessonId(value) {
   return parseId(value, 'INVALID_LESSON_ID', 'Lesson identifier is invalid')
}

function parseModuleId(value) {
   return parseId(value, 'INVALID_MODULE_ID', 'Module identifier is invalid')
}

function parseBodyId(value, field) {
   try {
      return parseId(value, 'INVALID_ID', 'Identifier is invalid')
   } catch {
      throw validationError(field)
   }
}

function courseNotFound() {
   return new AppError(404, 'COURSE_NOT_FOUND', 'Course was not found')
}

function lessonNotFound() {
   return new AppError(404, 'LESSON_NOT_FOUND', 'Lesson was not found')
}

function conflict(code, message, details) {
   return new AppError(409, code, message, details)
}

function isPlainObject(value) {
   return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseTitleTranslations(value, field) {
   if (!isPlainObject(value)) throw validationError(field)
   const normalized = {}
   for (const [language, translation] of Object.entries(value)) {
      if (!languages.includes(language) || !isPlainObject(translation)
         || Object.keys(translation).some((key) => key !== 'title')
         || translation.title === undefined) {
         throw validationError(field)
      }
      normalized[language] = { title: parseText(translation.title, field, maximumTitleLength) }
   }
   return normalized
}

function parseBlockText(value, maximum = 20000) {
   if (typeof value !== 'string' || value.length > maximum) throw validationError('content')
   return value
}

function parseBlock(block) {
   if (!isPlainObject(block) || !Object.hasOwn(blockFields, block.type)) {
      throw validationError('content', 'Unsupported content block')
   }
   const allowed = blockFields[block.type]
   if (Object.keys(block).some((key) => key !== 'type' && !allowed.includes(key))) {
      throw validationError('content', 'Unsupported content block field')
   }
   const parsed = { type: block.type }
   if (allowed.includes('text')) parsed.text = parseBlockText(block.text)
   if (block.type === 'heading') {
      if (![1, 2, 3].includes(block.level ?? 2)) throw validationError('content')
      parsed.level = block.level ?? 2
   }
   if (block.type === 'list') {
      if (!Array.isArray(block.items) || !block.items.length || block.items.length > 100) {
         throw validationError('content')
      }
      parsed.items = block.items.map((item) => parseBlockText(item, 2000))
      if (block.ordered !== undefined && typeof block.ordered !== 'boolean') {
         throw validationError('content')
      }
      parsed.ordered = block.ordered === true
   }
   if (block.type === 'code') {
      if (block.language !== undefined
         && (typeof block.language !== 'string' || !/^[a-z0-9+#-]{0,32}$/.test(block.language))) {
         throw validationError('content')
      }
      parsed.language = block.language || null
   }
   if (block.type === 'callout') {
      if (!['info', 'warning', 'success'].includes(block.tone ?? 'info')) {
         throw validationError('content')
      }
      parsed.tone = block.tone ?? 'info'
   }
   return parsed
}

function parseContent(value) {
   if (!isPlainObject(value) || Object.keys(value).some((key) => key !== 'blocks')
      || !Array.isArray(value.blocks) || value.blocks.length > maximumBlocks) {
      throw validationError('content')
   }
   const content = { blocks: value.blocks.map(parseBlock) }
   if (Buffer.byteLength(JSON.stringify(content)) > maximumContentBytes) {
      throw validationError('content', 'Lesson content is too large')
   }
   return content
}

function parseLessonBody(body, partial = false) {
   validateBody(body, lessonFields)
   if (partial && !Object.keys(body).length) throw validationError('body')
   if (!partial && body.lessonType === undefined) throw validationError('lessonType')
   if (body.lessonType !== undefined && !lessonTypes.includes(body.lessonType)) {
      throw validationError('lessonType')
   }
   if (body.allowOffline !== undefined && typeof body.allowOffline !== 'boolean') {
      throw validationError('allowOffline')
   }
   return {
      title: body.title === undefined && partial
         ? null
         : parseText(body.title, 'title', maximumTitleLength),
      lessonType: body.lessonType ?? null,
      hasContent: body.content !== undefined,
      content: body.content === undefined ? { blocks: [] } : parseContent(body.content),
      hasTranslations: body.translations !== undefined,
      translations: body.translations === undefined
         ? {}
         : parseTitleTranslations(body.translations, 'translations'),
      hasVideoAssetId: body.videoAssetId !== undefined,
      videoAssetId: body.videoAssetId === undefined || body.videoAssetId === null
         ? null
         : parseBodyId(body.videoAssetId, 'videoAssetId'),
      allowOffline: body.allowOffline ?? null,
   }
}

function parseLessonOrder(body) {
   validateBody(body, ['lessonIds'])
   const { lessonIds } = body
   if (!Array.isArray(lessonIds) || !lessonIds.length || lessonIds.length > maximumLessonsPerOrder) {
      throw validationError('lessonIds')
   }
   const normalized = lessonIds.map((value) => parseBodyId(value, 'lessonIds'))
   if (new Set(normalized).size !== normalized.length) {
      throw validationError('lessonIds', 'lessonIds must not contain duplicates')
   }
   return normalized
}

function parseNonNegativeSeconds(value, field) {
   if (!Number.isSafeInteger(value) || value < 0 || value > 1000000) throw validationError(field)
   return value
}

// Chapters must be listed in strictly increasing start order; positions follow that order.
function parseChapters(body) {
   validateBody(body, ['chapters'])
   if (!Array.isArray(body.chapters) || body.chapters.length > maximumChapters) {
      throw validationError('chapters')
   }
   let previous = -1
   return body.chapters.map((chapter) => {
      if (!isPlainObject(chapter)
         || Object.keys(chapter).some((key) => !['startSeconds', 'title', 'translations'].includes(key))) {
         throw validationError('chapters')
      }
      const startSeconds = parseNonNegativeSeconds(chapter.startSeconds, 'chapters')
      if (startSeconds <= previous) {
         throw validationError('chapters', 'Chapter start times must be unique and increasing')
      }
      previous = startSeconds
      return {
         startSeconds,
         title: parseText(chapter.title, 'chapters', maximumTitleLength),
         translations: chapter.translations === undefined
            ? {}
            : parseTitleTranslations(chapter.translations, 'chapters'),
      }
   })
}

function parseResources(body) {
   validateBody(body, ['resources'])
   if (!Array.isArray(body.resources) || body.resources.length > maximumResources) {
      throw validationError('resources')
   }
   const resources = body.resources.map((resource) => {
      if (!isPlainObject(resource)
         || Object.keys(resource).some((key) => !['assetId', 'title'].includes(key))) {
         throw validationError('resources')
      }
      return {
         assetId: parseBodyId(resource.assetId, 'resources'),
         title: resource.title === undefined || resource.title === null
            ? null
            : parseText(resource.title, 'resources', maximumTitleLength),
      }
   })
   if (new Set(resources.map((resource) => resource.assetId)).size !== resources.length) {
      throw validationError('resources', 'An asset can be attached only once')
   }
   return resources
}

function videoPlayable(asset) {
   return Boolean(asset) && asset.kind === 'video' && asset.status === 'ready'
      && asset.processing_status === 'not_required'
}

function safeVideo(asset) {
   if (!asset) return null
   return {
      assetId: asset.id,
      mimeType: asset.mime_type,
      durationSeconds: asset.duration_seconds,
      widthPx: asset.width_px,
      heightPx: asset.height_px,
      sizeBytes: Number(asset.size_bytes),
      playable: videoPlayable(asset),
   }
}

function safeChapter(row) {
   return {
      id: row.id,
      startSeconds: row.start_seconds,
      title: row.title,
      translations: row.translations,
      position: row.position,
   }
}

function safeResource(row) {
   return {
      id: row.resource_id,
      assetId: row.id,
      title: row.resource_title,
      position: row.position,
      fileName: row.file_name,
      mimeType: row.mime_type,
      sizeBytes: Number(row.size_bytes),
   }
}

function safeLessonSummary(row) {
   return {
      id: row.id,
      moduleId: row.module_id,
      courseId: row.course_id,
      title: row.title,
      position: row.position,
      lessonType: row.lesson_type,
      translations: row.translations,
      videoAssetId: row.video_asset_id,
      allowOffline: row.allow_offline,
      status: row.status,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
   }
}

async function loadLessonDetail(repository, lesson, db) {
   const [chapters, resources, video] = await Promise.all([
      repository.listChapters([lesson.id], db),
      repository.listResources([lesson.id], db),
      lesson.video_asset_id ? repository.findAsset(lesson.video_asset_id, db) : null,
   ])
   return {
      ...safeLessonSummary(lesson),
      content: lesson.content,
      video: safeVideo(video),
      chapters: chapters.map(safeChapter),
      resources: resources.map(safeResource),
   }
}

async function issueVideoUrl(storage, asset, clock) {
   const url = await storage.presignDownload({
      key: asset.storage_key,
      expiresIn: playbackUrlTtlSeconds,
      contentType: asset.mime_type,
      disposition: 'inline',
   })
   return {
      url,
      expiresAt: new Date(clock().getTime() + playbackUrlTtlSeconds * 1000).toISOString(),
      mimeType: asset.mime_type,
      durationSeconds: asset.duration_seconds,
   }
}

async function issueMaterialUrl(storage, resource, clock) {
   const url = await storage.presignDownload({
      key: resource.storage_key,
      expiresIn: materialUrlTtlSeconds,
      contentType: resource.mime_type,
      fileName: resource.file_name,
      disposition: 'attachment',
   })
   return {
      url,
      expiresAt: new Date(clock().getTime() + materialUrlTtlSeconds * 1000).toISOString(),
      fileName: resource.file_name,
      mimeType: resource.mime_type,
   }
}

async function requireReadableCourse(repository, actorId, courseId) {
   const scope = await repository.findCourseScope(actorId, courseId)
   if (!scope) throw courseNotFound()
   return scope
}

async function requireManageableCourse(repository, actorId, courseId, client) {
   const course = await repository.findManageableCourseForUpdate(actorId, courseId, client)
   if (!course) throw courseNotFound()
   return course
}

async function requireDraftLesson(repository, courseId, lessonId, client) {
   const lesson = await repository.findLessonForUpdate(courseId, lessonId, client)
   if (!lesson) throw lessonNotFound()
   if (lesson.status !== 'draft') {
      throw conflict('LESSON_NOT_EDITABLE', 'Only draft lessons can be edited; restore it to draft first')
   }
   return lesson
}

// The video must be a ready, seek-ready video of this course (or already on this lesson).
async function validateVideoAsset(repository, courseId, lessonId, assetId, client) {
   const asset = await repository.findCourseAsset(assetId, courseId, lessonId, client)
   if (!asset || !asset.in_course || asset.kind !== 'video') {
      throw validationError('videoAssetId', 'videoAssetId must be a video asset of this course')
   }
   if (!videoPlayable(asset)) {
      throw conflict('VIDEO_NOT_PLAYABLE', 'Video asset is not ready for playback')
   }
   return asset
}

async function audit(auth, actorId, code, entityId, metadata, client) {
   await auth.appendAuditEvent({
      actorUserId: actorId,
      subjectUserId: null,
      code,
      entityType: 'lesson',
      entityId,
      metadata,
   }, client)
}

async function listModuleLessonsService(userId, courseIdValue, moduleIdValue, overrides) {
   const { repository } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const moduleId = parseModuleId(moduleIdValue)
   await requireReadableCourse(repository, actorId, courseId)
   if (!await repository.findModule(courseId, moduleId)) {
      throw new AppError(404, 'COURSE_MODULE_NOT_FOUND', 'Course module was not found')
   }
   const lessons = await repository.listModuleLessons(moduleId)
   return { lessons: lessons.map(safeLessonSummary) }
}

async function getLessonService(userId, courseIdValue, lessonIdValue, overrides) {
   const { repository } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const lessonId = parseLessonId(lessonIdValue)
   const scope = await requireReadableCourse(repository, actorId, courseId)
   const lesson = await repository.findLesson(courseId, lessonId)
   if (!lesson) throw lessonNotFound()
   return {
      ...await loadLessonDetail(repository, lesson),
      relationship: { canManage: scope.administrator || scope.can_manage_lessons },
   }
}

async function createLessonService(userId, courseIdValue, moduleIdValue, body, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const moduleId = parseModuleId(moduleIdValue)
   const values = parseLessonBody(body)
   if (values.videoAssetId && !videoLessonTypes.includes(values.lessonType)) {
      throw validationError('videoAssetId', 'Only video and mixed lessons can have a video')
   }
   return transaction(async (client) => {
      await requireManageableCourse(repository, actorId, courseId, client)
      if (!await repository.findModuleForUpdate(courseId, moduleId, client)) {
         throw new AppError(404, 'COURSE_MODULE_NOT_FOUND', 'Course module was not found')
      }
      if (values.videoAssetId) {
         await validateVideoAsset(repository, courseId, null, values.videoAssetId, client)
      }
      const position = await repository.findNextLessonPosition(moduleId, client)
      const lesson = await repository.createLesson({
         ...values,
         allowOffline: values.allowOffline ?? false,
         moduleId,
         courseId,
         position,
         actorId,
      }, client)
      await audit(auth, actorId, 'lesson.created', lesson.id, { courseId, moduleId, position }, client)
      return loadLessonDetail(repository, lesson, client)
   })
}

async function updateLessonService(userId, courseIdValue, lessonIdValue, body, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const lessonId = parseLessonId(lessonIdValue)
   const values = parseLessonBody(body, true)
   return transaction(async (client) => {
      await requireManageableCourse(repository, actorId, courseId, client)
      const current = await requireDraftLesson(repository, courseId, lessonId, client)
      const lessonType = values.lessonType || current.lesson_type
      const videoAssetId = values.hasVideoAssetId ? values.videoAssetId : current.video_asset_id
      if (videoAssetId && !videoLessonTypes.includes(lessonType)) {
         throw validationError('videoAssetId', 'Only video and mixed lessons can have a video')
      }
      const chapters = await repository.listChapters([lessonId], client)
      if (values.hasVideoAssetId && videoAssetId !== current.video_asset_id) {
         if (!videoAssetId && chapters.length) {
            throw conflict('LESSON_HAS_CHAPTERS', 'Remove the chapters before removing the video')
         }
         if (videoAssetId) {
            const asset = await validateVideoAsset(repository, courseId, lessonId, videoAssetId, client)
            if (asset.duration_seconds !== null
               && chapters.some((chapter) => chapter.start_seconds >= asset.duration_seconds)) {
               throw conflict('CHAPTERS_OUT_OF_RANGE', 'Existing chapters start after the end of this video')
            }
         }
      }
      const lesson = await repository.updateLesson(lessonId, values, client)
      await audit(auth, actorId, 'lesson.updated', lessonId, { courseId, fields: Object.keys(body) }, client)
      return loadLessonDetail(repository, lesson, client)
   })
}

async function changeLessonStatus(userId, courseIdValue, lessonIdValue, from, to, code, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const lessonId = parseLessonId(lessonIdValue)
   return transaction(async (client) => {
      await requireManageableCourse(repository, actorId, courseId, client)
      const current = await repository.findLessonForUpdate(courseId, lessonId, client)
      if (!current) throw lessonNotFound()
      if (current.status !== from) {
         throw conflict('INVALID_LESSON_TRANSITION', 'Lesson lifecycle transition is not allowed')
      }
      if (to === 'published') {
         if (current.lesson_type === 'test') {
            throw conflict('LESSON_TYPE_NOT_PUBLISHABLE', 'Test lessons cannot be published yet')
         }
         if (current.lesson_type === 'video' && !current.video_asset_id) {
            throw conflict('LESSON_VIDEO_REQUIRED', 'A video lesson needs a video before publication')
         }
         if (current.video_asset_id
            && !videoPlayable(await repository.findAsset(current.video_asset_id, client))) {
            throw conflict('VIDEO_NOT_PLAYABLE', 'Video asset is not ready for playback')
         }
      }
      const lesson = await repository.updateLessonStatus(lessonId, to, client)
      await audit(auth, actorId, code, lessonId, { courseId, fromStatus: from, toStatus: to }, client)
      return loadLessonDetail(repository, lesson, client)
   })
}

async function publishLessonService(userId, courseId, lessonId, overrides) {
   return changeLessonStatus(userId, courseId, lessonId, 'draft', 'published', 'lesson.published', overrides)
}

async function archiveLessonService(userId, courseId, lessonId, overrides) {
   return changeLessonStatus(userId, courseId, lessonId, 'published', 'archived', 'lesson.archived', overrides)
}

async function restoreLessonService(userId, courseId, lessonId, overrides) {
   return changeLessonStatus(userId, courseId, lessonId, 'archived', 'draft', 'lesson.restored', overrides)
}

async function deleteLessonService(userId, courseIdValue, lessonIdValue, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const lessonId = parseLessonId(lessonIdValue)
   return transaction(async (client) => {
      await requireManageableCourse(repository, actorId, courseId, client)
      const current = await repository.findLessonForUpdate(courseId, lessonId, client)
      if (!current) throw lessonNotFound()
      if (current.status !== 'draft' || !await repository.lessonIsEmpty(lessonId, client)) {
         throw conflict('LESSON_NOT_DELETABLE', 'Only an empty draft lesson can be deleted')
      }
      await repository.deleteLesson(lessonId, client)
      await audit(auth, actorId, 'lesson.deleted', lessonId, {
         courseId,
         moduleId: current.module_id,
         title: current.title,
         position: current.position,
      }, client)
      return { id: lessonId, status: 'deleted' }
   })
}

async function reorderLessonsService(userId, courseIdValue, moduleIdValue, body, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const moduleId = parseModuleId(moduleIdValue)
   const lessonIds = parseLessonOrder(body)
   return transaction(async (client) => {
      await requireManageableCourse(repository, actorId, courseId, client)
      if (!await repository.findModuleForUpdate(courseId, moduleId, client)) {
         throw new AppError(404, 'COURSE_MODULE_NOT_FOUND', 'Course module was not found')
      }
      const currentIds = await repository.listLessonIdsForUpdate(moduleId, client)
      const current = new Set(currentIds)
      if (currentIds.length !== lessonIds.length || lessonIds.some((id) => !current.has(id))) {
         throw conflict(
            'LESSON_ORDER_MISMATCH',
            'Lesson order must list every lesson of the module exactly once',
         )
      }
      await repository.applyLessonOrder(moduleId, lessonIds, client)
      await auth.appendAuditEvent({
         actorUserId: actorId,
         subjectUserId: null,
         code: 'lessons.reordered',
         entityType: 'course_module',
         entityId: moduleId,
         metadata: { courseId, previousOrder: currentIds, newOrder: lessonIds },
      }, client)
      const lessons = await repository.listModuleLessons(moduleId, client)
      return { lessons: lessons.map(safeLessonSummary) }
   })
}

async function replaceLessonChaptersService(userId, courseIdValue, lessonIdValue, body, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const lessonId = parseLessonId(lessonIdValue)
   const chapters = parseChapters(body)
   return transaction(async (client) => {
      await requireManageableCourse(repository, actorId, courseId, client)
      const lesson = await requireDraftLesson(repository, courseId, lessonId, client)
      if (chapters.length) {
         if (!lesson.video_asset_id) {
            throw conflict('LESSON_HAS_NO_VIDEO', 'Chapters need a lesson video')
         }
         const asset = await repository.findAsset(lesson.video_asset_id, client)
         if (asset.duration_seconds !== null
            && chapters.some((chapter) => chapter.startSeconds >= asset.duration_seconds)) {
            throw validationError('chapters', 'Chapters must start before the end of the video')
         }
      }
      await repository.replaceChapters(lessonId, chapters, client)
      await audit(auth, actorId, 'lesson.chapters.replaced', lessonId, {
         courseId,
         chapters: chapters.length,
      }, client)
      const rows = await repository.listChapters([lessonId], client)
      return { chapters: rows.map(safeChapter) }
   })
}

async function replaceLessonResourcesService(userId, courseIdValue, lessonIdValue, body, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const lessonId = parseLessonId(lessonIdValue)
   const resources = parseResources(body)
   return transaction(async (client) => {
      await requireManageableCourse(repository, actorId, courseId, client)
      await requireDraftLesson(repository, courseId, lessonId, client)
      for (const resource of resources) {
         const asset = await repository.findCourseAsset(resource.assetId, courseId, lessonId, client)
         if (!asset || !asset.in_course || asset.kind !== 'material') {
            throw validationError('resources', 'Materials must be non-video assets of this course')
         }
         if (asset.status !== 'ready') {
            throw conflict('ASSET_NOT_READY', 'Material asset is not ready')
         }
      }
      await repository.replaceResources(lessonId, resources, client)
      await audit(auth, actorId, 'lesson.resources.replaced', lessonId, {
         courseId,
         assetIds: resources.map((resource) => resource.assetId),
      }, client)
      const rows = await repository.listResources([lessonId], client)
      return { resources: rows.map(safeResource) }
   })
}

// Staff preview of any lesson status within the actor's read scope.
async function previewLessonPlaybackService(userId, courseIdValue, lessonIdValue, overrides) {
   const { repository, storage, clock } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const lessonId = parseLessonId(lessonIdValue)
   await requireReadableCourse(repository, actorId, courseId)
   const lesson = await repository.findLesson(courseId, lessonId)
   if (!lesson) throw lessonNotFound()
   const asset = lesson.video_asset_id && await repository.findAsset(lesson.video_asset_id)
   if (!videoPlayable(asset)) {
      throw conflict('VIDEO_NOT_PLAYABLE', 'This lesson has no playable video')
   }
   const chapters = await repository.listChapters([lessonId])
   return {
      playback: await issueVideoUrl(storage(), asset, clock),
      chapters: chapters.map(safeChapter),
   }
}

async function previewLessonResourceService(userId, courseIdValue, lessonIdValue, resourceIdValue, overrides) {
   const { repository, storage, clock } = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const lessonId = parseLessonId(lessonIdValue)
   const resourceId = parseId(resourceIdValue, 'INVALID_RESOURCE_ID', 'Resource identifier is invalid')
   await requireReadableCourse(repository, actorId, courseId)
   if (!await repository.findLesson(courseId, lessonId)) throw lessonNotFound()
   const resource = (await repository.listResources([lessonId]))
      .find((row) => row.resource_id === resourceId)
   if (!resource || resource.status !== 'ready') {
      throw new AppError(404, 'RESOURCE_NOT_FOUND', 'Lesson material was not found')
   }
   return { download: await issueMaterialUrl(storage(), resource, clock) }
}

// Copy steps appended to course copying: lessons as drafts attached through moduleIdMap,
// then their chapters and materials. Assets are referenced, never duplicated; progress,
// notes, offline licenses and favorites are never copied.
const lessonCopySteps = [
   async function copyLessonsStep(context) {
      const rows = await context.lessons.copyLessons(
         context.moduleIdMap,
         context.targetCourseId,
         context.actorId,
         context.client,
      )
      context.lessonIdMap = new Map(rows.map((row) => [row.source_id, row.target_id]))
      return { lessons: rows.length }
   },
   async function copyChaptersStep(context) {
      return { chapters: await context.lessons.copyChapters(context.lessonIdMap, context.client) }
   },
   async function copyResourcesStep(context) {
      return { resources: await context.lessons.copyResources(context.lessonIdMap, context.client) }
   },
]

export {
   archiveLessonService,
   createLessonService,
   deleteLessonService,
   getLessonService,
   issueMaterialUrl,
   issueVideoUrl,
   lessonCopySteps,
   listModuleLessonsService,
   parseLessonId,
   parseNonNegativeSeconds,
   previewLessonPlaybackService,
   previewLessonResourceService,
   publishLessonService,
   reorderLessonsService,
   replaceLessonChaptersService,
   replaceLessonResourcesService,
   restoreLessonService,
   safeChapter,
   safeLessonSummary,
   safeResource,
   safeVideo,
   updateLessonService,
   videoPlayable,
}
