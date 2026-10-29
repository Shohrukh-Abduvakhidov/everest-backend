import assert from 'node:assert/strict'
import test from 'node:test'

import pg from 'pg'

import { createApp } from '../../src/app.js'
import env from '../../src/configs/env.js'
import { withTransaction } from '../../src/repositories/transaction-repository.js'
import { initiateAssetUploadService } from '../../src/services/asset-upload-service.js'
import { issueSessionService } from '../../src/services/auth/session-service.js'
import { isoMedia, pdf, webmMedia } from '../helpers/media-fixtures.js'
import { createMemoryStorageProvider } from '../helpers/memory-storage-provider.js'

const { Client } = pg
const mib = 1024 * 1024
const userIds = []
const courseIds = []
const config = {
   ...env,
   jwtAccessSecret: 'asset-upload-integration-secret-longer-than-32-characters',
   authSessionTtlSeconds: 900,
   authRefreshTtlSeconds: 86400,
   authAdminRateLimit: 1000,
}
const storageConfig = {
   ...env.storage,
   partSizeBytes: 5 * mib,
   presignTtlSeconds: 900,
   uploadTtlHours: 24,
}

async function createUser(client, role, name) {
   const user = await client.query(
      `INSERT INTO users (status, onboarding_completed_at)
       VALUES ('active', CURRENT_TIMESTAMP) RETURNING id`,
   )
   const userId = user.rows[0].id
   userIds.push(userId)
   await client.query(
      `INSERT INTO user_profiles (user_id, first_name, last_name) VALUES ($1, $2, 'M07A')`,
      [userId, name],
   )
   await client.query(
      `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2`,
      [userId, role],
   )
   return userId
}

async function createCourse(client, createdBy, status = 'draft') {
   const result = await client.query(
      `INSERT INTO courses (title, status, created_by) VALUES ('M07A course', $1, $2) RETURNING id`,
      [status, createdBy],
   )
   courseIds.push(result.rows[0].id)
   return result.rows[0].id
}

async function issue(userId) {
   return withTransaction((client) => issueSessionService({
      userId,
      requestContext: { userAgent: 'M07A integration', ipAddress: '127.0.0.1' },
      client,
   }, { config }))
}

async function api(port, method, path, session, body) {
   const headers = { 'content-type': 'application/json' }
   if (session) headers.authorization = `Bearer ${session.accessToken}`
   const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
   })
   return { response, body: await response.json() }
}

async function listen(app) {
   return new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
   })
}

async function cleanup(client) {
   if (!userIds.length) return
   const assets = await client.query(
      'SELECT id FROM assets WHERE uploaded_by = ANY($1::bigint[])',
      [userIds],
   )
   const assetIds = assets.rows.map((row) => row.id)
   await client.query(
      "DELETE FROM background_jobs WHERE job_type = 'asset.video.remux' AND (payload->>'assetId') = ANY($1::text[])",
      [assetIds],
   )
   await client.query("DELETE FROM audit_events WHERE event_code LIKE 'asset.%' AND actor_user_id = ANY($1::bigint[])", [userIds])
   await client.query('DELETE FROM asset_uploads WHERE created_by = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM assets WHERE uploaded_by = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM course_teachers WHERE course_id = ANY($1::bigint[])', [courseIds])
   await client.query('DELETE FROM courses WHERE id = ANY($1::bigint[])', [courseIds])
   await client.query('DELETE FROM auth_refresh_tokens WHERE session_id IN (SELECT id FROM auth_sessions WHERE user_id = ANY($1::bigint[]))', [userIds])
   await client.query('DELETE FROM auth_sessions WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM user_roles WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM user_profiles WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [userIds])
}

test('asset multipart uploads integration', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   const storage = createMemoryStorageProvider()
   const app = createApp({
      authProtection: { config },
      telegramAuth: { config },
      assets: { storage, config: storageConfig },
   })
   const server = await listen(app)
   const port = server.address().port
   const uploads = '/api/v1/assets/uploads'

   async function storageUploadId(uploadId) {
      const row = await client.query(
         'SELECT storage_upload_id FROM asset_uploads WHERE id = $1',
         [uploadId],
      )
      return row.rows[0].storage_upload_id
   }

   async function uploadAll(session, uploadId, buffer, partSize = storageConfig.partSizeBytes) {
      const id = await storageUploadId(uploadId)
      const partCount = Math.ceil(buffer.length / partSize)
      const parts = await api(port, 'POST', `${uploads}/${uploadId}/parts`, session, {
         partNumbers: Array.from({ length: partCount }, (_, index) => index + 1),
      })
      assert.equal(parts.response.status, 200, JSON.stringify(parts.body))
      for (const part of parts.body.data.parts) {
         const start = (part.partNumber - 1) * partSize
         storage.putPart(id, part.partNumber, buffer.subarray(start, start + part.sizeBytes))
      }
   }

   async function initiate(session, courseId, kind, fileName, mimeType, buffer) {
      return api(port, 'POST', uploads, session, {
         courseId,
         kind,
         fileName,
         mimeType,
         sizeBytes: buffer.length,
      })
   }

   try {
      const ownerId = await createUser(client, 'owner', 'Owner')
      const adminId = await createUser(client, 'admin', 'Admin')
      const teacherId = await createUser(client, 'teacher', 'Teacher')
      const viewerTeacherId = await createUser(client, 'teacher', 'Viewer')
      const studentId = await createUser(client, 'student', 'Student')
      const courseId = await createCourse(client, ownerId)
      const otherCourseId = await createCourse(client, ownerId)
      const archivedCourseId = await createCourse(client, ownerId, 'archived')
      await client.query(
         `INSERT INTO course_teachers (course_id, user_id, can_manage_lessons, assigned_by)
          VALUES ($1, $2, TRUE, $4), ($1, $3, FALSE, $4)`,
         [courseId, teacherId, viewerTeacherId, ownerId],
      )
      const owner = await issue(ownerId)
      const admin = await issue(adminId)
      const teacher = await issue(teacherId)
      const viewerTeacher = await issue(viewerTeacherId)
      const student = await issue(studentId)
      const video = isoMedia({ mdatBytes: 11 * mib })

      await t.test('validation rejects disallowed types, mismatches and sizes', async () => {
         const cases = [
            [{ kind: 'video', fileName: 'clip.avi', mimeType: 'video/x-msvideo', sizeBytes: 10 }, 'fileName'],
            [{ kind: 'video', fileName: 'clip.mp4', mimeType: 'video/webm', sizeBytes: 10 }, 'mimeType'],
            [{ kind: 'material', fileName: 'clip.mp4', mimeType: 'video/mp4', sizeBytes: 10 }, 'fileName'],
            [{ kind: 'video', fileName: 'clip.mp4', mimeType: 'video/mp4', sizeBytes: 20 * 1024 * mib + 1 }, 'sizeBytes'],
            [{ kind: 'video', fileName: 'clip.mp4', mimeType: 'video/mp4', sizeBytes: 0 }, 'sizeBytes'],
            [{ kind: 'audio', fileName: 'a.mp3', mimeType: 'audio/mpeg', sizeBytes: 10 }, 'kind'],
            [{ kind: 'video', fileName: '.mp4', mimeType: 'video/mp4', sizeBytes: 10 }, 'fileName'],
         ]
         for (const [body, field] of cases) {
            const result = await api(port, 'POST', uploads, admin, { courseId, ...body })
            assert.equal(result.response.status, 400, JSON.stringify(body))
            assert.equal(result.body.error.details[0].field, field)
         }
         const extra = await api(port, 'POST', uploads, admin, {
            courseId, kind: 'video', fileName: 'a.mp4', mimeType: 'video/mp4', sizeBytes: 10, storageKey: 'x',
         })
         assert.equal(extra.response.status, 400)
      })

      await t.test('only owner/admin and lesson-managing course teachers may upload', async () => {
         for (const session of [student, viewerTeacher]) {
            const denied = await initiate(session, courseId, 'material', 'a.pdf', 'application/pdf', pdf)
            assert.equal(denied.response.status, 403)
         }
         const otherCourse = await initiate(teacher, otherCourseId, 'material', 'a.pdf', 'application/pdf', pdf)
         assert.equal(otherCourse.response.status, 403)
         const missing = await initiate(teacher, '999999999', 'material', 'a.pdf', 'application/pdf', pdf)
         assert.equal(missing.response.status, 403)
         const adminMissing = await initiate(admin, '999999999', 'material', 'a.pdf', 'application/pdf', pdf)
         assert.equal(adminMissing.response.status, 404)
         const archived = await initiate(owner, archivedCourseId, 'material', 'a.pdf', 'application/pdf', pdf)
         assert.equal(archived.response.status, 409)
         const unauthenticated = await initiate(null, courseId, 'material', 'a.pdf', 'application/pdf', pdf)
         assert.equal(unauthenticated.response.status, 401)
      })

      await t.test('multipart upload resumes from storage parts and completes idempotently', async () => {
         const created = await initiate(teacher, courseId, 'video', '../../Lesson 1.mp4', 'video/mp4', video)
         assert.equal(created.response.status, 201, JSON.stringify(created.body))
         const upload = created.body.data
         assert.equal(upload.fileName, 'Lesson 1.mp4')
         assert.equal(upload.partSizeBytes, 5 * mib)
         assert.equal(upload.partCount, 3)
         assert.equal(upload.status, 'initiated')
         assert.equal(JSON.stringify(created.body).includes('storage'), false)
         const key = (await client.query(
            'SELECT storage_key FROM assets WHERE id = $1',
            [upload.assetId],
         )).rows[0].storage_key
         assert.match(key, new RegExp(`^courses/${courseId}/videos/[0-9a-f-]{36}\\.mp4$`))

         const id = await storageUploadId(upload.id)
         const presigned = await api(port, 'POST', `${uploads}/${upload.id}/parts`, teacher, {
            partNumbers: [3, 1],
         })
         assert.equal(presigned.response.status, 200)
         assert.deepEqual(presigned.body.data.parts.map((part) => part.partNumber), [1, 3])
         assert.equal(presigned.body.data.parts[1].sizeBytes, video.length - 10 * mib)
         storage.putPart(id, 1, video.subarray(0, 5 * mib))
         storage.putPart(id, 3, video.subarray(10 * mib))

         const status = await api(port, 'GET', `${uploads}/${upload.id}`, teacher)
         assert.deepEqual(status.body.data.uploadedParts.map((part) => part.partNumber), [1, 3])

         const incomplete = await api(port, 'POST', `${uploads}/${upload.id}/complete`, teacher)
         assert.equal(incomplete.response.status, 409)
         assert.equal(incomplete.body.error.code, 'UPLOAD_INCOMPLETE')
         assert.deepEqual(incomplete.body.error.details[0].missingParts, [2])

         storage.putPart(id, 2, video.subarray(5 * mib, 9 * mib))
         const wrongSize = await api(port, 'POST', `${uploads}/${upload.id}/complete`, teacher)
         assert.deepEqual(wrongSize.body.error.details[0].wrongSizeParts, [2])
         storage.putPart(id, 2, video.subarray(5 * mib, 10 * mib))

         const badPart = await api(port, 'POST', `${uploads}/${upload.id}/parts`, teacher, {
            partNumbers: [4],
         })
         assert.equal(badPart.response.status, 400)

         const [first, second] = await Promise.all([
            api(port, 'POST', `${uploads}/${upload.id}/complete`, teacher),
            api(port, 'POST', `${uploads}/${upload.id}/complete`, teacher),
         ])
         assert.equal(first.response.status, 200, JSON.stringify(first.body))
         assert.equal(second.response.status, 200, JSON.stringify(second.body))
         assert.deepEqual(first.body.data, second.body.data)
         const asset = first.body.data.asset
         assert.equal(asset.status, 'ready')
         assert.equal(asset.mimeType, 'video/mp4')
         assert.equal(asset.sizeBytes, video.length)
         assert.equal(asset.durationSeconds, 90)
         assert.equal(asset.widthPx, 1920)
         assert.equal(asset.processingStatus, 'not_required')
         assert.equal(storage.calls.filter((call) => call.name === 'completeMultipartUpload'
            && call.key === key).length, 1)
         assert.equal(storage.objects.get(key).length, video.length)

         const again = await api(port, 'POST', `${uploads}/${upload.id}/complete`, teacher)
         assert.equal(again.response.status, 200)
         const abortCompleted = await api(port, 'POST', `${uploads}/${upload.id}/abort`, teacher)
         assert.equal(abortCompleted.response.status, 409)
         const audit = await client.query(
            "SELECT event_code FROM audit_events WHERE entity_type = 'asset_upload' AND entity_id = $1 ORDER BY id",
            [upload.id],
         )
         assert.deepEqual(audit.rows.map((row) => row.event_code), [
            'asset.upload.initiated',
            'asset.upload.completed',
         ])
      })

      await t.test('upload scope: other teachers get 404, admin can manage', async () => {
         const created = await initiate(teacher, courseId, 'material', 'notes.pdf', 'application/pdf', pdf)
         const uploadId = created.body.data.id
         for (const session of [viewerTeacher, student]) {
            const hidden = await api(port, 'GET', `${uploads}/${uploadId}`, session)
            assert.equal(hidden.response.status, 404)
            const abort = await api(port, 'POST', `${uploads}/${uploadId}/abort`, session)
            assert.equal(abort.response.status, 404)
         }
         const visible = await api(port, 'GET', `${uploads}/${uploadId}`, admin)
         assert.equal(visible.response.status, 200)
         await client.query(
            'UPDATE course_teachers SET can_manage_lessons = FALSE WHERE course_id = $1 AND user_id = $2',
            [courseId, teacherId],
         )
         const revoked = await api(port, 'GET', `${uploads}/${uploadId}`, teacher)
         assert.equal(revoked.response.status, 404)
         await client.query(
            'UPDATE course_teachers SET can_manage_lessons = TRUE WHERE course_id = $1 AND user_id = $2',
            [courseId, teacherId],
         )
         await uploadAll(admin, uploadId, pdf)
         const completed = await api(port, 'POST', `${uploads}/${uploadId}/complete`, admin)
         assert.equal(completed.response.status, 200)
         assert.equal(completed.body.data.asset.mimeType, 'application/pdf')
      })

      await t.test('content not matching the declared type is rejected and deleted', async () => {
         const created = await initiate(admin, courseId, 'video', 'fake.mp4', 'video/mp4', pdf)
         const uploadId = created.body.data.id
         await uploadAll(admin, uploadId, pdf)
         const key = (await client.query('SELECT storage_key FROM assets WHERE id = $1', [created.body.data.assetId])).rows[0].storage_key
         const rejected = await api(port, 'POST', `${uploads}/${uploadId}/complete`, admin)
         assert.equal(rejected.response.status, 422)
         assert.equal(rejected.body.error.code, 'UNSUPPORTED_MEDIA')
         assert.equal(rejected.body.error.details[0].code, 'MEDIA_TYPE_MISMATCH')
         assert.equal(storage.objects.has(key), false)
         const rows = await client.query(
            `SELECT upload.status, upload.rejection_code, asset.status AS asset_status
             FROM asset_uploads AS upload JOIN assets AS asset ON asset.id = upload.asset_id
             WHERE upload.id = $1`,
            [uploadId],
         )
         assert.deepEqual(rows.rows[0], {
            status: 'rejected',
            rejection_code: 'MEDIA_TYPE_MISMATCH',
            asset_status: 'quarantined',
         })
         const retry = await api(port, 'POST', `${uploads}/${uploadId}/complete`, admin)
         assert.equal(retry.response.status, 409)
         assert.equal(retry.body.error.code, 'UPLOAD_REJECTED')
      })

      await t.test('unsupported codec gives a clear error', async () => {
         const prores = isoMedia({ videoCodec: 'apcn' })
         const created = await initiate(admin, courseId, 'video', 'master.mp4', 'video/mp4', prores)
         await uploadAll(admin, created.body.data.id, prores)
         const rejected = await api(port, 'POST', `${uploads}/${created.body.data.id}/complete`, admin)
         assert.equal(rejected.response.status, 422)
         assert.equal(rejected.body.error.details[0].code, 'MEDIA_UNSUPPORTED_CODEC')
         assert.match(rejected.body.error.message, /apcn/)
      })

      await t.test('QuickTime uploads are refused at initiation', async () => {
         const mov = isoMedia({ brand: 'qt  ' })
         const refused = await initiate(admin, courseId, 'video', 'camera.mov', 'video/quicktime', mov)
         assert.equal(refused.response.status, 400)
         assert.equal(refused.body.error.details[0].field, 'fileName')
      })

      await t.test('non-seek-ready video is rejected with VIDEO_NOT_SEEKABLE and deleted', async () => {
         const cases = [
            ['late.mp4', 'video/mp4', isoMedia({ faststart: false })],
            ['nocues.webm', 'video/webm', webmMedia({ cues: 'none' })],
            ['endcues.webm', 'video/webm', webmMedia({ cues: 'end' })],
         ]
         for (const [fileName, mimeType, buffer] of cases) {
            const created = await initiate(admin, courseId, 'video', fileName, mimeType, buffer)
            await uploadAll(admin, created.body.data.id, buffer)
            const key = (await client.query(
               'SELECT storage_key FROM assets WHERE id = $1',
               [created.body.data.assetId],
            )).rows[0].storage_key
            const rejected = await api(port, 'POST', `${uploads}/${created.body.data.id}/complete`, admin)
            assert.equal(rejected.response.status, 422, fileName)
            assert.equal(rejected.body.error.code, 'VIDEO_NOT_SEEKABLE')
            assert.ok(rejected.body.error.message.includes('fast start (web optimized)'))
            assert.equal(storage.objects.has(key), false)
            const asset = await client.query('SELECT status FROM assets WHERE id = $1', [created.body.data.assetId])
            assert.equal(asset.rows[0].status, 'quarantined')
         }
      })

      await t.test('seek-ready videos need no processing and enqueue no jobs', async () => {
         for (const [fileName, mimeType, buffer] of [
            ['lesson.mp4', 'video/mp4', isoMedia()],
            ['screen.webm', 'video/webm', webmMedia()],
         ]) {
            const created = await initiate(admin, courseId, 'video', fileName, mimeType, buffer)
            await uploadAll(admin, created.body.data.id, buffer)
            const done = await api(port, 'POST', `${uploads}/${created.body.data.id}/complete`, admin)
            assert.equal(done.response.status, 200, JSON.stringify(done.body))
            assert.equal(done.body.data.asset.processingStatus, 'not_required')
            const jobs = await client.query(
               "SELECT count(*)::int AS count FROM background_jobs WHERE dedupe_key = $1",
               [`asset.video.remux:${created.body.data.assetId}`],
            )
            assert.equal(jobs.rows[0].count, 0)
         }
      })

      await t.test('abort is idempotent and closes the upload', async () => {
         const created = await initiate(owner, courseId, 'material', 'deck.pdf', 'application/pdf', pdf)
         const uploadId = created.body.data.id
         const first = await api(port, 'POST', `${uploads}/${uploadId}/abort`, owner)
         const second = await api(port, 'POST', `${uploads}/${uploadId}/abort`, owner)
         assert.equal(first.response.status, 200)
         assert.equal(second.response.status, 200)
         assert.equal(second.body.data.upload.status, 'aborted')
         assert.equal(storage.uploads.has(await storageUploadId(uploadId)), false)
         const complete = await api(port, 'POST', `${uploads}/${uploadId}/complete`, owner)
         assert.equal(complete.body.error.code, 'UPLOAD_ABORTED')
         const parts = await api(port, 'POST', `${uploads}/${uploadId}/parts`, owner, { partNumbers: [1] })
         assert.equal(parts.response.status, 409)
         const asset = await client.query('SELECT status FROM assets WHERE id = $1', [created.body.data.assetId])
         assert.equal(asset.rows[0].status, 'archived')
      })

      await t.test('expired uploads cannot be presigned or completed', async () => {
         const created = await initiate(admin, courseId, 'material', 'old.pdf', 'application/pdf', pdf)
         const uploadId = created.body.data.id
         await uploadAll(admin, uploadId, pdf)
         await client.query(
            `UPDATE asset_uploads SET created_at = CURRENT_TIMESTAMP - INTERVAL '2 days',
               expires_at = CURRENT_TIMESTAMP - INTERVAL '1 day' WHERE id = $1`,
            [uploadId],
         )
         const status = await api(port, 'GET', `${uploads}/${uploadId}`, admin)
         assert.equal(status.body.data.upload.status, 'expired')
         const complete = await api(port, 'POST', `${uploads}/${uploadId}/complete`, admin)
         assert.equal(complete.body.error.code, 'UPLOAD_EXPIRED')
         const abort = await api(port, 'POST', `${uploads}/${uploadId}/abort`, admin)
         assert.equal(abort.response.status, 200)
      })

      await t.test('completion retried after a failure past storage assembly succeeds', async () => {
         const created = await initiate(admin, courseId, 'material', 'retry.pdf', 'application/pdf', pdf)
         const uploadId = created.body.data.id
         await uploadAll(admin, uploadId, pdf)
         storage.failNextComplete = true
         const failed = await api(port, 'POST', `${uploads}/${uploadId}/complete`, admin)
         assert.equal(failed.response.status, 500)
         const row = await client.query('SELECT status FROM asset_uploads WHERE id = $1', [uploadId])
         assert.equal(row.rows[0].status, 'initiated')
         const retried = await api(port, 'POST', `${uploads}/${uploadId}/complete`, admin)
         assert.equal(retried.response.status, 200, JSON.stringify(retried.body))
         assert.equal(retried.body.data.asset.status, 'ready')
      })

      await t.test('database failure during initiation rolls back and aborts storage', async () => {
         const before = await client.query('SELECT count(*)::integer AS count FROM asset_uploads')
         const aborted = storage.calls.filter((call) => call.name === 'abortMultipartUpload').length
         await assert.rejects(initiateAssetUploadService(adminId, {
            courseId,
            kind: 'material',
            fileName: 'boom.pdf',
            mimeType: 'application/pdf',
            sizeBytes: pdf.length,
         }, {
            storage,
            config: storageConfig,
            auth: { appendAuditEvent: async () => { throw new Error('audit failed') } },
         }), /audit failed/)
         const after = await client.query('SELECT count(*)::integer AS count FROM asset_uploads')
         assert.equal(after.rows[0].count, before.rows[0].count)
         assert.equal(
            storage.calls.filter((call) => call.name === 'abortMultipartUpload').length,
            aborted + 1,
         )
      })
   } finally {
      await new Promise((resolve) => server.close(resolve))
      await cleanup(client)
      await client.end()
   }
})
