import { randomUUID } from 'node:crypto'

import env from '../configs/env.js'
import { getStorageProvider } from '../providers/storage/index.js'
import * as assetUploadRepository from '../repositories/asset-upload-repository.js'
import * as authRepository from '../repositories/auth-repository.js'
import * as authorizationRepository from '../repositories/authorization-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import AppError from '../utils/app-error.js'
import { inspectMedia, MediaRejection, mimeTypes } from '../utils/media-inspection.js'
import { parseCourseId, parseId, parseUserId, validateBody, validationError } from './course-service.js'
import { updateLessonService } from './lesson-service.js'

const mib = 1024 * 1024
const maxFileBytes = 20 * 1024 * mib
const maxParts = 10000
const maxPresignBatch = 100

// Extension allowlists per kind. QuickTime (.mov) is not accepted: only seek-ready MP4
// (moov before mdat) and WebM (Cues before clusters) are stored, so no server-side remux
// is ever needed. The declared type only selects the expected format;
// completion re-identifies the stored bytes and rejects any mismatch.
const allowedTypes = Object.freeze({
   video: { mp4: mimeTypes.mp4, webm: mimeTypes.webm },
   material: {
      pdf: mimeTypes.pdf,
      docx: mimeTypes.docx,
      pptx: mimeTypes.pptx,
      jpg: mimeTypes.jpg,
      jpeg: mimeTypes.jpg,
      png: mimeTypes.png,
   },
})

function dependencies(overrides = {}) {
   return {
      repository: overrides.repository || assetUploadRepository,
      auth: overrides.auth || authRepository,
      authorization: overrides.authorization || authorizationRepository,
      transaction: overrides.transaction || withTransaction,
      storage: overrides.storage || getStorageProvider(),
      clock: overrides.clock || (() => new Date()),
      config: overrides.config || env.storage,
   }
}

function iso(value) {
   return value === null || value === undefined ? null : new Date(value).toISOString()
}

function parseUploadId(value) {
   return parseId(value, 'INVALID_UPLOAD_ID', 'Upload identifier is invalid')
}

function parseFileName(value) {
   if (typeof value !== 'string') throw validationError('fileName')
   const baseName = value.split(/[\\/]/).pop().replace(/[\p{Cc}\p{Cf}]/gu, '').trim()
   if (!baseName || baseName.length > 255 || baseName.startsWith('.')) {
      throw validationError('fileName')
   }
   return baseName
}

function parseUploadRequest(body, config) {
   validateBody(body, ['courseId', 'kind', 'fileName', 'mimeType', 'sizeBytes', 'lessonId'])
   let courseId
   try {
      courseId = parseCourseId(body.courseId)
   } catch {
      throw validationError('courseId')
   }
   if (!Object.hasOwn(allowedTypes, body.kind)) throw validationError('kind')
   const fileName = parseFileName(body.fileName)
   const extension = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : ''
   const expectedType = allowedTypes[body.kind][extension]
   if (!expectedType) {
      throw validationError('fileName', `File extension is not allowed for ${body.kind}`)
   }
   if (body.mimeType !== expectedType) {
      throw validationError('mimeType', 'mimeType must match the file extension')
   }
   if (!Number.isSafeInteger(body.sizeBytes) || body.sizeBytes <= 0
      || body.sizeBytes > maxFileBytes) {
      throw validationError('sizeBytes', 'sizeBytes must be between 1 byte and 20 GiB')
   }
   if (body.kind === 'video' && body.sizeBytes > config.videoMaxBytes) {
      throw new AppError(413, 'VIDEO_TOO_LARGE', 'Video is larger than the allowed size', [
         { field: 'sizeBytes', message: String(config.videoMaxBytes) },
      ])
   }
   let lessonId = null
   if (body.lessonId !== undefined && body.lessonId !== null) {
      if (body.kind !== 'video') throw validationError('lessonId', 'Only a video upload can target a lesson')
      lessonId = parseId(body.lessonId, 'VALIDATION_ERROR', 'Request validation failed')
   }
   return {
      courseId,
      lessonId,
      kind: body.kind,
      fileName,
      extension: extension === 'jpeg' ? 'jpg' : extension,
      mimeType: expectedType,
      sizeBytes: body.sizeBytes,
   }
}

// Server-chosen part size: the configured default, raised in whole MiB when needed so
// that no upload exceeds the S3 limit of 10,000 parts.
function choosePartSize(sizeBytes, configuredPartSize) {
   const minimum = Math.ceil(sizeBytes / maxParts / mib) * mib
   const partSizeBytes = Math.max(configuredPartSize, minimum)
   return { partSizeBytes, partCount: Math.max(1, Math.ceil(sizeBytes / partSizeBytes)) }
}

function expectedPartSize(upload, partNumber) {
   const size = Number(upload.size_bytes)
   const partSize = Number(upload.part_size_bytes)
   return partNumber < upload.part_count ? partSize : size - partSize * (upload.part_count - 1)
}

function safeUpload(row) {
   return {
      id: row.id,
      assetId: row.asset_id,
      courseId: row.course_id,
      lessonId: row.lesson_id ?? null,
      kind: row.kind,
      fileName: row.file_name,
      mimeType: row.declared_mime_type,
      sizeBytes: Number(row.size_bytes),
      partSizeBytes: Number(row.part_size_bytes),
      partCount: row.part_count,
      status: row.is_expired ? 'expired' : row.status,
      rejectionCode: row.rejection_code,
      createdAt: iso(row.created_at),
      expiresAt: iso(row.expires_at),
      completedAt: iso(row.completed_at),
      abortedAt: iso(row.aborted_at),
      expiredAt: iso(row.expired_at),
   }
}

function isOpen(upload) {
   return (upload.status === 'initiated' || upload.status === 'uploading') && !upload.is_expired
}

function safeAsset(row) {
   return {
      id: row.id,
      kind: row.kind,
      mimeType: row.mime_type,
      fileName: row.file_name,
      sizeBytes: Number(row.size_bytes),
      widthPx: row.width_px,
      heightPx: row.height_px,
      durationSeconds: row.duration_seconds,
      status: row.status,
      processingStatus: row.processing_status,
      processingError: row.processing_error,
      createdAt: iso(row.created_at),
   }
}

function uploadNotFound() {
   return new AppError(404, 'UPLOAD_NOT_FOUND', 'Upload was not found')
}

function conflict(code, message, details) {
   return new AppError(409, code, message, details)
}

async function canUploadToCourse(deps, actorId, courseId) {
   if (await deps.authorization.hasPermission(actorId, 'assets.upload')) return true
   return deps.repository.isCourseLessonManager(actorId, courseId)
}

// Owner/admin reach every upload through assets.manage; a course teacher reaches only
// uploads they created, and only while they still manage that course's lessons.
// Everyone else receives the same 404 as for a missing upload.
async function requireUploadAccess(deps, actorId, upload) {
   if (!upload) throw uploadNotFound()
   if (await deps.authorization.hasPermission(actorId, 'assets.manage')) return upload
   if (upload.created_by === actorId
      && await canUploadToCourse(deps, actorId, upload.course_id)) {
      return upload
   }
   throw uploadNotFound()
}

function requireOpenUpload(upload) {
   if (upload.status === 'completed') {
      throw conflict('UPLOAD_ALREADY_COMPLETED', 'Upload is already completed')
   }
   if (upload.status === 'aborted') throw conflict('UPLOAD_ABORTED', 'Upload was aborted')
   if (upload.status === 'rejected') {
      throw conflict('UPLOAD_REJECTED', 'Upload was rejected', [{ code: upload.rejection_code }])
   }
   if (upload.is_expired || upload.status === 'expired') throw conflict('UPLOAD_EXPIRED', 'Upload has expired')
}

// Lesson videos: per-user open uploads and the library quota. Run without a lock before the
// storage call (fast refusal) and again under lockVideoQuota inside the transaction.
async function requireVideoCapacity(deps, actorId, sizeBytes, client) {
   const open = await deps.repository.countOpenVideoUploads(actorId, client)
   if (open >= deps.config.maxActiveVideoUploads) {
      throw conflict('VIDEO_UPLOAD_LIMIT_REACHED', 'Finish or abort an open video upload first', [
         { field: 'activeUploads', message: String(deps.config.maxActiveVideoUploads) },
      ])
   }
   const used = await deps.repository.sumVideoLibraryBytes(client)
   if (used + sizeBytes > deps.config.videoTotalQuotaBytes) {
      throw conflict('VIDEO_QUOTA_EXCEEDED', 'The video library has no room for this file', [
         { field: 'usedBytes', message: String(used) },
         { field: 'quotaBytes', message: String(deps.config.videoTotalQuotaBytes) },
      ])
   }
}

async function requireTargetLesson(deps, courseId, lessonId) {
   if (!lessonId) return
   const lesson = await deps.repository.findLesson(courseId, lessonId)
   if (!lesson) throw new AppError(404, 'LESSON_NOT_FOUND', 'Lesson was not found')
   if (!['video', 'mixed'].includes(lesson.lesson_type)) {
      throw validationError('lessonId', 'Only video and mixed lessons can have a video')
   }
}

async function initiateAssetUploadService(userId, body, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const request = parseUploadRequest(body, deps.config)
   if (!await canUploadToCourse(deps, actorId, request.courseId)) {
      throw new AppError(403, 'ACTION_FORBIDDEN', 'You are not authorized to perform this action')
   }
   const course = await deps.repository.findCourse(request.courseId)
   if (!course) throw new AppError(404, 'COURSE_NOT_FOUND', 'Course was not found')
   if (course.status === 'archived') {
      throw conflict('COURSE_ARCHIVED', 'Files cannot be uploaded to an archived course')
   }
   const isVideo = request.kind === 'video'
   await requireTargetLesson(deps, request.courseId, request.lessonId)
   if (isVideo) await requireVideoCapacity(deps, actorId, request.sizeBytes)
   const { partSizeBytes, partCount } = choosePartSize(request.sizeBytes, deps.config.partSizeBytes)
   const storageKey = `courses/${request.courseId}/${request.kind}s/${randomUUID()}.${request.extension}`
   const expiresAt = new Date(deps.clock().getTime() + deps.config.uploadTtlHours * 3600 * 1000)
   const { uploadId: storageUploadId } = await deps.storage.createMultipartUpload({
      key: storageKey,
      contentType: request.mimeType,
   })
   try {
      const uploadId = await deps.transaction(async (client) => {
         if (isVideo) {
            await deps.repository.lockVideoQuota(client)
            await requireVideoCapacity(deps, actorId, request.sizeBytes, client)
         }
         const asset = await deps.repository.insertPendingAsset({
            storageKey,
            mimeType: request.mimeType,
            fileName: request.fileName,
            sizeBytes: request.sizeBytes,
            kind: request.kind,
            uploadedBy: actorId,
            courseId: request.courseId,
         }, client)
         const upload = await deps.repository.insertUpload({
            assetId: asset.id,
            courseId: request.courseId,
            lessonId: request.lessonId,
            storageUploadId,
            declaredMimeType: request.mimeType,
            sizeBytes: request.sizeBytes,
            partSizeBytes,
            partCount,
            createdBy: actorId,
            expiresAt: expiresAt.toISOString(),
         }, client)
         await deps.auth.appendAuditEvent({
            actorUserId: actorId,
            subjectUserId: null,
            code: 'asset.upload.initiated',
            entityType: 'asset_upload',
            entityId: upload.id,
            metadata: {
               courseId: request.courseId,
               lessonId: request.lessonId,
               assetId: asset.id,
               kind: request.kind,
               sizeBytes: request.sizeBytes,
            },
         }, client)
         return upload.id
      })
      return safeUpload(await deps.repository.findUpload(uploadId))
   } catch (error) {
      await deps.storage.abortMultipartUpload({ key: storageKey, uploadId: storageUploadId })
         .catch(() => {})
      throw error
   }
}

async function getAssetUploadService(userId, uploadIdValue, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const uploadId = parseUploadId(uploadIdValue)
   const upload = await requireUploadAccess(deps, actorId, await deps.repository.findUpload(uploadId))
   let uploadedParts = []
   if (isOpen(upload)) {
      const parts = await deps.storage.listParts({
         key: upload.storage_key,
         uploadId: upload.storage_upload_id,
      })
      // A part counts only with its full expected size; a cut-off part is sent again.
      uploadedParts = (parts || [])
         .filter((part) => part.partNumber <= upload.part_count)
         .map((part) => ({ partNumber: part.partNumber, size: part.size }))
   }
   const done = new Set(uploadedParts
      .filter((part) => part.size === expectedPartSize(upload, part.partNumber))
      .map((part) => part.partNumber))
   const missingParts = []
   if (isOpen(upload)) {
      for (let number = 1; number <= upload.part_count; number += 1) {
         if (!done.has(number)) missingParts.push(number)
      }
   }
   return {
      upload: safeUpload(upload),
      uploadedParts,
      missingParts,
      uploadedBytes: uploadedParts
         .filter((part) => done.has(part.partNumber))
         .reduce((sum, part) => sum + part.size, 0),
   }
}

async function presignAssetUploadPartsService(userId, uploadIdValue, body, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const uploadId = parseUploadId(uploadIdValue)
   validateBody(body, ['partNumbers'])
   const upload = await requireUploadAccess(deps, actorId, await deps.repository.findUpload(uploadId))
   requireOpenUpload(upload)
   const { partNumbers } = body
   if (!Array.isArray(partNumbers) || !partNumbers.length || partNumbers.length > maxPresignBatch
      || new Set(partNumbers).size !== partNumbers.length
      || partNumbers.some((number) => !Number.isSafeInteger(number) || number < 1
         || number > upload.part_count)) {
      throw validationError('partNumbers', `Provide 1 to ${maxPresignBatch} unique part numbers within the upload`)
   }
   const ttl = deps.config.presignTtlSeconds
   const expiresAt = new Date(deps.clock().getTime() + ttl * 1000).toISOString()
   const parts = []
   for (const partNumber of [...partNumbers].sort((left, right) => left - right)) {
      parts.push({
         partNumber,
         sizeBytes: expectedPartSize(upload, partNumber),
         url: await deps.storage.presignUploadPart({
            key: upload.storage_key,
            uploadId: upload.storage_upload_id,
            partNumber,
            expiresIn: ttl,
         }),
         expiresAt,
      })
   }
   await deps.repository.markUploadUploading(upload.id)
   return { parts }
}

// The storage server's part list is the source of truth: the client never submits ETags.
function verifyStoredParts(upload, parts) {
   const byNumber = new Map(parts.map((part) => [part.partNumber, part]))
   const missing = []
   const wrongSize = []
   for (let number = 1; number <= upload.part_count; number += 1) {
      const part = byNumber.get(number)
      if (!part) missing.push(number)
      else if (part.size !== expectedPartSize(upload, number)) wrongSize.push(number)
   }
   const extra = parts.filter((part) => part.partNumber > upload.part_count)
      .map((part) => part.partNumber)
   if (missing.length || wrongSize.length || extra.length) {
      throw conflict('UPLOAD_INCOMPLETE', 'Upload parts are missing or have unexpected sizes', [
         { missingParts: missing.slice(0, 100), wrongSizeParts: wrongSize, extraParts: extra },
      ])
   }
   return [...byNumber.values()].sort((left, right) => left.partNumber - right.partNumber)
}

async function assembleStoredObject(deps, upload) {
   const parts = await deps.storage.listParts({
      key: upload.storage_key,
      uploadId: upload.storage_upload_id,
   })
   if (parts) {
      await deps.storage.completeMultipartUpload({
         key: upload.storage_key,
         uploadId: upload.storage_upload_id,
         parts: verifyStoredParts(upload, parts),
      })
   }
   // A missing multipart upload is accepted only when an earlier completion already
   // assembled the object (for example, the database commit failed afterwards).
   const object = await deps.storage.headObject(upload.storage_key)
   if (!object) {
      throw conflict('UPLOAD_PARTS_MISSING', 'Upload no longer exists in storage; abort and retry')
   }
   return object
}

async function rejectUpload(deps, actorId, upload, rejection, client) {
   await deps.repository.markUploadRejected(upload.id, rejection.code, client)
   await deps.repository.markAssetUnusable(upload.asset_id, 'quarantined', rejection.code, client)
   await deps.auth.appendAuditEvent({
      actorUserId: actorId,
      subjectUserId: null,
      code: 'asset.upload.rejected',
      entityType: 'asset_upload',
      entityId: upload.id,
      metadata: { assetId: upload.asset_id, reason: rejection.code },
   }, client)
   return { rejected: rejection, storageKey: upload.storage_key }
}

async function completeAssetUploadService(userId, uploadIdValue, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const uploadId = parseUploadId(uploadIdValue)
   await requireUploadAccess(deps, actorId, await deps.repository.findUpload(uploadId))
   const outcome = await deps.transaction(async (client) => {
      const upload = await deps.repository.findUploadForUpdate(uploadId, client)
      if (!upload) throw uploadNotFound()
      if (upload.status === 'completed') {
         return { assetId: upload.asset_id, courseId: upload.course_id, lessonId: upload.lesson_id }
      }
      requireOpenUpload(upload)
      const object = await assembleStoredObject(deps, upload)
      let media
      try {
         if (object.size !== Number(upload.size_bytes)) {
            throw new MediaRejection('MEDIA_SIZE_MISMATCH', 'Stored file size does not match')
         }
         media = await inspectMedia({
            read: (start, end) => deps.storage.readRange(upload.storage_key, start, end),
            size: object.size,
            kind: upload.kind,
            declaredMimeType: upload.declared_mime_type,
         })
      } catch (error) {
         if (!(error instanceof MediaRejection)) throw error
         return rejectUpload(deps, actorId, upload, { code: error.code, message: error.message }, client)
      }
      await deps.repository.markAssetReady(upload.asset_id, {
         mimeType: media.mimeType,
         sizeBytes: object.size,
         widthPx: media.widthPx,
         heightPx: media.heightPx,
         durationSeconds: media.durationSeconds,
         processingStatus: upload.kind === 'video' ? 'not_required' : 'none',
         media: upload.kind === 'video' ? {
            container: media.container,
            videoCodec: media.videoCodec,
            audioCodec: media.audioCodec,
         } : {},
      }, client)
      await deps.repository.markUploadCompleted(upload.id, client)
      await deps.auth.appendAuditEvent({
         actorUserId: actorId,
         subjectUserId: null,
         code: 'asset.upload.completed',
         entityType: 'asset_upload',
         entityId: upload.id,
         metadata: { assetId: upload.asset_id, sizeBytes: object.size },
      }, client)
      return {
         assetId: upload.asset_id,
         courseId: upload.course_id,
         lessonId: upload.lesson_id,
         justCompleted: true,
      }
   })
   if (outcome.rejected) {
      await deps.storage.deleteObject(outcome.storageKey).catch(() => {
         console.error('Rejected upload object could not be deleted', { uploadId })
      })
      const code = outcome.rejected.code === 'VIDEO_NOT_SEEKABLE'
         ? 'VIDEO_NOT_SEEKABLE'
         : 'UNSUPPORTED_MEDIA'
      throw new AppError(422, code, outcome.rejected.message, [
         { code: outcome.rejected.code },
      ])
   }
   const asset = safeAsset(await deps.repository.findAsset(outcome.assetId))
   if (!outcome.lessonId) return { asset }
   return { asset, lesson: await attachToLesson(deps, actorId, outcome, overrides) }
}

// The lesson named at initiation gets the video through the ordinary lesson update, so its
// rules apply (lesson type, chapters, offline licenses, removal of the replaced video). Only
// the call that completed the upload attaches; a repeated completion reports the state, so it
// cannot undo a later change of the lesson's video. A refused attach keeps the ready asset.
async function attachToLesson(deps, actorId, outcome, overrides = {}) {
   const lessonId = String(outcome.lessonId)
   if (!outcome.justCompleted) {
      const lesson = await deps.repository.findLesson(outcome.courseId, lessonId)
      return {
         lessonId,
         attached: String(lesson?.video_asset_id ?? '') === String(outcome.assetId),
         errorCode: null,
      }
   }
   try {
      await updateLessonService(actorId, outcome.courseId, lessonId, { videoAssetId: outcome.assetId }, {
         storage: overrides.storage,
         clock: overrides.clock,
      })
      return { lessonId, attached: true, errorCode: null }
   } catch (error) {
      if (!(error instanceof AppError)) throw error
      return { lessonId, attached: false, errorCode: error.code }
   }
}

async function abortAssetUploadService(userId, uploadIdValue, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const uploadId = parseUploadId(uploadIdValue)
   await requireUploadAccess(deps, actorId, await deps.repository.findUpload(uploadId))
   await deps.transaction(async (client) => {
      const upload = await deps.repository.findUploadForUpdate(uploadId, client)
      if (!upload) throw uploadNotFound()
      if (['aborted', 'rejected', 'expired'].includes(upload.status)) return
      if (upload.status === 'completed') {
         throw conflict('UPLOAD_ALREADY_COMPLETED', 'A completed upload cannot be aborted')
      }
      await deps.storage.abortMultipartUpload({
         key: upload.storage_key,
         uploadId: upload.storage_upload_id,
      })
      await deps.repository.markUploadAborted(upload.id, client)
      await deps.repository.markAssetUnusable(upload.asset_id, 'archived', null, client)
      await deps.auth.appendAuditEvent({
         actorUserId: actorId,
         subjectUserId: null,
         code: 'asset.upload.aborted',
         entityType: 'asset_upload',
         entityId: upload.id,
         metadata: { assetId: upload.asset_id },
      }, client)
   })
   return { upload: safeUpload(await deps.repository.findUpload(uploadId)) }
}

// Worker step: one upload past expires_at is aborted in storage and marked expired; its
// pending asset is archived. Returns false when none is left. SKIP LOCKED lets several
// worker processes run it. The bucket's 3-day abort rule is the backstop.
async function expireNextAbandonedUploadService(overrides) {
   const deps = dependencies(overrides)
   return deps.transaction(async (client) => {
      const upload = await deps.repository.claimExpiredUpload(client)
      if (!upload) return false
      await deps.storage.abortMultipartUpload({
         key: upload.storage_key,
         uploadId: upload.storage_upload_id,
      })
      await deps.repository.markUploadExpired(upload.id, client)
      await deps.repository.markAssetUnusable(upload.asset_id, 'archived', null, client)
      await deps.auth.appendAuditEvent({
         actorUserId: null,
         subjectUserId: null,
         code: 'asset.upload.expired',
         entityType: 'asset_upload',
         entityId: upload.id,
         metadata: { assetId: upload.asset_id },
      }, client)
      return true
   })
}

export {
   expireNextAbandonedUploadService,
   abortAssetUploadService,
   choosePartSize,
   completeAssetUploadService,
   getAssetUploadService,
   initiateAssetUploadService,
   presignAssetUploadPartsService,
}
