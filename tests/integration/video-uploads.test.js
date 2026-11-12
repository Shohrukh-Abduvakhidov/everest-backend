import assert from 'node:assert/strict'
import test from 'node:test'

import pg from 'pg'

import env from '../../src/configs/env.js'
import {
   abortAssetUploadService,
   completeAssetUploadService,
   expireNextAbandonedUploadService,
   getAssetUploadService,
   initiateAssetUploadService,
   presignAssetUploadPartsService,
} from '../../src/services/asset-upload-service.js'
import { createLessonService, updateLessonService } from '../../src/services/lesson-service.js'
import { isoMedia, webmMedia } from '../helpers/media-fixtures.js'
import { createMemoryStorageProvider } from '../helpers/memory-storage-provider.js'

const { Client } = pg
const mib = 1024 * 1024

// Lesson videos through the existing asset upload flow, called at the service layer with the
// in-memory storage double (no live S3, so nothing can hang on the network).
test('lesson video uploads integration', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   t.after(() => client.end())
   const storage = createMemoryStorageProvider()
   const baseConfig = {
      ...env.storage,
      partSizeBytes: 5 * mib,
      presignTtlSeconds: 3600,
      uploadTtlHours: 24,
      videoMaxBytes: 64 * mib,
      videoTotalQuotaBytes: Number.MAX_SAFE_INTEGER,
      maxActiveVideoUploads: 3,
   }
   const deps = (config = {}, clock) => ({
      storage,
      config: { ...baseConfig, ...config },
      ...(clock ? { clock } : {}),
   })

   async function createUser(role) {
      const { rows } = await client.query(
         `INSERT INTO users (status, onboarding_completed_at) VALUES ('active', CURRENT_TIMESTAMP) RETURNING id`,
      )
      await client.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2', [rows[0].id, role])
      return String(rows[0].id)
   }

   const ownerId = await createUser('owner')
   const teacherId = await createUser('teacher')
   const viewerTeacherId = await createUser('teacher')
   const studentId = await createUser('student')
   const { rows: [course] } = await client.query(
      `INSERT INTO courses (title, status, created_by) VALUES ('Video course', 'draft', $1) RETURNING id`,
      [ownerId],
   )
   const courseId = String(course.id)
   const { rows: [module] } = await client.query(
      `INSERT INTO course_modules (course_id, title, position, status) VALUES ($1, 'M1', 1, 'draft') RETURNING id`,
      [courseId],
   )
   await client.query(
      `INSERT INTO course_teachers (course_id, user_id, can_manage_lessons, assigned_by)
       VALUES ($1, $2, TRUE, $4), ($1, $3, FALSE, $4)`,
      [courseId, teacherId, viewerTeacherId, ownerId],
   )
   const lesson = await createLessonService(ownerId, courseId, module.id, { title: 'Intro', lessonType: 'video' })
   const textLesson = await createLessonService(ownerId, courseId, module.id, { title: 'Read', lessonType: 'text' })

   const video = isoMedia({ mdatBytes: 11 * mib, seconds: 60 })
   const request = (overrides = {}) => ({
      courseId,
      lessonId: lesson.id,
      kind: 'video',
      fileName: 'Lesson 1.mp4',
      mimeType: 'video/mp4',
      sizeBytes: video.length,
      ...overrides,
   })
   async function storageUploadId(uploadId) {
      const { rows } = await client.query('SELECT storage_upload_id FROM asset_uploads WHERE id = $1', [uploadId])
      return rows[0].storage_upload_id
   }
   async function putParts(uploadId, buffer, numbers) {
      const id = await storageUploadId(uploadId)
      for (const number of numbers) {
         const start = (number - 1) * 5 * mib
         storage.putPart(id, number, buffer.subarray(start, Math.min(start + 5 * mib, buffer.length)))
      }
   }

   let uploadId
   await t.test('creation returns server-chosen parts and a server-built key, bound to the lesson', async () => {
      const upload = await initiateAssetUploadService(teacherId, request(), deps())
      uploadId = upload.id
      assert.deepEqual(
         [upload.status, upload.partSizeBytes, upload.partCount, upload.lessonId],
         ['initiated', 5 * mib, 3, String(lesson.id)],
      )
      assert.ok(upload.expiresAt)
      const { rows } = await client.query('SELECT storage_key FROM assets WHERE id = $1', [upload.assetId])
      assert.match(rows[0].storage_key, new RegExp(`^courses/${courseId}/videos/[0-9a-f-]{36}\\.mp4$`))
   })

   await t.test('state after a partial upload lists arrived and missing parts', async () => {
      const presigned = await presignAssetUploadPartsService(teacherId, uploadId, { partNumbers: [1, 2, 3] }, deps())
      assert.equal(presigned.parts.length, 3)
      await putParts(uploadId, video, [1, 3])
      // A cut-off part 2 (half sent) does not count as done.
      storage.putPart(await storageUploadId(uploadId), 2, video.subarray(5 * mib, 7 * mib))
      const state = await getAssetUploadService(teacherId, uploadId, deps())
      assert.equal(state.upload.status, 'uploading')
      assert.deepEqual(state.missingParts, [2])
      assert.equal(state.uploadedBytes, 5 * mib + (video.length - 10 * mib))
      await assert.rejects(completeAssetUploadService(teacherId, uploadId, deps()), { code: 'UPLOAD_INCOMPLETE' })
   })

   await t.test('completion attaches the video to the lesson; a repeat is safe', async () => {
      await putParts(uploadId, video, [2])
      const done = await completeAssetUploadService(teacherId, uploadId, deps())
      assert.equal(done.asset.status, 'ready')
      assert.deepEqual(done.lesson, { lessonId: String(lesson.id), attached: true, errorCode: null })
      const { rows } = await client.query('SELECT video_asset_id FROM lessons WHERE id = $1', [lesson.id])
      assert.equal(String(rows[0].video_asset_id), String(done.asset.id))
      const again = await completeAssetUploadService(teacherId, uploadId, deps())
      assert.equal(again.asset.id, done.asset.id)
      assert.equal(again.lesson.attached, true)
      assert.equal(storage.calls.filter((call) => call.name === 'completeMultipartUpload').length, 1)
   })

   await t.test('replacing the lesson video deletes the old object', async () => {
      const second = await initiateAssetUploadService(teacherId, request({ fileName: 'v2.webm', mimeType: 'video/webm', sizeBytes: webmMedia().length }), deps())
      await presignAssetUploadPartsService(teacherId, second.id, { partNumbers: [1] }, deps())
      await putParts(second.id, webmMedia(), [1])
      const { rows: [old] } = await client.query(
         'SELECT asset.id, asset.storage_key FROM lessons JOIN assets AS asset ON asset.id = lessons.video_asset_id WHERE lessons.id = $1',
         [lesson.id],
      )
      const done = await completeAssetUploadService(teacherId, second.id, deps())
      assert.equal(done.lesson.attached, true)
      assert.equal(storage.objects.has(old.storage_key), false)
      const { rows } = await client.query('SELECT status FROM assets WHERE id = $1', [old.id])
      assert.equal(rows[0].status, 'archived')
      // Removing the video from the lesson (type text) deletes the object too.
      const { rows: [current] } = await client.query('SELECT storage_key FROM assets WHERE id = $1', [done.asset.id])
      await updateLessonService(ownerId, courseId, lesson.id, { videoAssetId: null }, { storage })
      assert.equal(storage.objects.has(current.storage_key), false)
   })

   await t.test('only course editors may upload; students and read-only teachers may not', async () => {
      for (const userId of [studentId, viewerTeacherId]) {
         await assert.rejects(initiateAssetUploadService(userId, request(), deps()), { code: 'ACTION_FORBIDDEN' })
      }
   })

   await t.test('limits: size, type, lesson kind, extension/type match', async () => {
      await assert.rejects(
         initiateAssetUploadService(teacherId, request({ sizeBytes: 65 * mib }), deps()),
         { code: 'VIDEO_TOO_LARGE' },
      )
      await assert.rejects(
         initiateAssetUploadService(teacherId, request({ fileName: 'a.mov', mimeType: 'video/quicktime' }), deps()),
         { code: 'VALIDATION_ERROR' },
      )
      await assert.rejects(
         initiateAssetUploadService(teacherId, request({ fileName: 'a.webm' }), deps()),
         { code: 'VALIDATION_ERROR' },
      )
      await assert.rejects(
         initiateAssetUploadService(teacherId, request({ lessonId: textLesson.id }), deps()),
         { code: 'VALIDATION_ERROR' },
      )
      await assert.rejects(
         initiateAssetUploadService(teacherId, request({ lessonId: '999999999' }), deps()),
         { code: 'LESSON_NOT_FOUND' },
      )
   })

   await t.test('at most 3 open video uploads per user', async () => {
      const open = []
      for (let index = 0; index < 3; index += 1) open.push(await initiateAssetUploadService(teacherId, request(), deps()))
      await assert.rejects(initiateAssetUploadService(teacherId, request(), deps()), { code: 'VIDEO_UPLOAD_LIMIT_REACHED' })
      await abortAssetUploadService(teacherId, open[0].id, deps())
      await abortAssetUploadService(teacherId, open[0].id, deps())
      const next = await initiateAssetUploadService(teacherId, request(), deps())
      for (const upload of [...open.slice(1), next]) await abortAssetUploadService(teacherId, upload.id, deps())
   })

   await t.test('the library quota counts ready videos and open uploads', async () => {
      const { rows } = await client.query(
         `SELECT (COALESCE((SELECT sum(size_bytes) FROM assets WHERE kind = 'video' AND status = 'ready'), 0)
            + COALESCE((SELECT sum(upload.size_bytes) FROM asset_uploads AS upload JOIN assets AS asset ON asset.id = upload.asset_id
                WHERE asset.kind = 'video' AND upload.status IN ('initiated', 'uploading')
                   AND upload.expires_at > CURRENT_TIMESTAMP), 0))::text AS used`,
      )
      const quota = { videoTotalQuotaBytes: Number(rows[0].used) + video.length + 1 }
      const first = await initiateAssetUploadService(ownerId, request(), deps(quota))
      const refused = await initiateAssetUploadService(ownerId, request(), deps(quota)).catch((error) => error)
      assert.equal(refused.code, 'VIDEO_QUOTA_EXCEEDED')
      assert.equal(refused.status, 409)
      await abortAssetUploadService(ownerId, first.id, deps())
      await initiateAssetUploadService(ownerId, request(), deps(quota))
         .then((upload) => abortAssetUploadService(ownerId, upload.id, deps()))
   })

   await t.test('an expired upload is refused, then the sweep aborts it in storage', async () => {
      const upload = await initiateAssetUploadService(teacherId, request(), deps())
      await client.query(
         `UPDATE asset_uploads SET created_at = CURRENT_TIMESTAMP - interval '2 days',
             expires_at = CURRENT_TIMESTAMP - interval '1 minute' WHERE id = $1`,
         [upload.id],
      )
      const state = await getAssetUploadService(teacherId, upload.id, deps())
      assert.equal(state.upload.status, 'expired')
      assert.deepEqual(state.missingParts, [])
      await assert.rejects(presignAssetUploadPartsService(teacherId, upload.id, { partNumbers: [1] }, deps()), { code: 'UPLOAD_EXPIRED' })
      await assert.rejects(completeAssetUploadService(teacherId, upload.id, deps()), { code: 'UPLOAD_EXPIRED' })
      const id = await storageUploadId(upload.id)
      while (await expireNextAbandonedUploadService(deps()));
      assert.equal(storage.uploads.has(id), false)
      const { rows } = await client.query(
         `SELECT upload.status, upload.expired_at IS NOT NULL AS stamped, asset.status AS asset_status
          FROM asset_uploads AS upload JOIN assets AS asset ON asset.id = upload.asset_id WHERE upload.id = $1`,
         [upload.id],
      )
      assert.deepEqual(rows[0], { status: 'expired', stamped: true, asset_status: 'archived' })
      assert.equal((await getAssetUploadService(teacherId, upload.id, deps())).upload.status, 'expired')
      // Expired uploads no longer count against the per-user limit.
      for (let index = 0; index < 3; index += 1) {
         const open = await initiateAssetUploadService(teacherId, request(), deps())
         await abortAssetUploadService(teacherId, open.id, deps())
      }
   })
})
