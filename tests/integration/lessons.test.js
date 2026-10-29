import assert from 'node:assert/strict'
import test from 'node:test'

import pg from 'pg'

import { createApp } from '../../src/app.js'
import env from '../../src/configs/env.js'
import { withTransaction } from '../../src/repositories/transaction-repository.js'
import { issueSessionService } from '../../src/services/auth/session-service.js'
import { isoMedia, pdf } from '../helpers/media-fixtures.js'
import { createMemoryStorageProvider } from '../helpers/memory-storage-provider.js'

const { Client } = pg
const userIds = []
const day = 24 * 60 * 60 * 1000
const config = {
   ...env,
   jwtAccessSecret: 'lesson-integration-secret-longer-than-32-characters-x',
   authSessionTtlSeconds: 900,
   authRefreshTtlSeconds: 86400,
   authAdminRateLimit: 1000,
   playbackRateLimit: 1000,
}
const storageConfig = { ...env.storage, partSizeBytes: 5 * 1024 * 1024, presignTtlSeconds: 900, uploadTtlHours: 24 }

async function createUser(client, role, name) {
   const user = await client.query(
      `INSERT INTO users (status, onboarding_completed_at)
       VALUES ('active', CURRENT_TIMESTAMP) RETURNING id`,
   )
   const userId = user.rows[0].id
   userIds.push(userId)
   await client.query(
      `INSERT INTO user_profiles (user_id, first_name, last_name) VALUES ($1, $2, 'M07B')`,
      [userId, name],
   )
   await client.query(
      'INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2',
      [userId, role],
   )
   return userId
}

async function issue(userId) {
   return withTransaction((client) => issueSessionService({
      userId,
      requestContext: { userAgent: 'M07B integration', ipAddress: '127.0.0.1' },
      client,
   }, { config }))
}

async function listen(app) {
   return new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
   })
}

async function cleanup(client) {
   if (!userIds.length) return
   const courses = await client.query('SELECT id FROM courses WHERE created_by = ANY($1::bigint[])', [userIds])
   const courseIds = courses.rows.map((row) => row.id)
   const lessonFilter = 'lesson_id IN (SELECT id FROM lessons WHERE course_id = ANY($1::bigint[]))'
   await client.query(`DELETE FROM offline_downloads WHERE ${lessonFilter}`, [courseIds])
   await client.query(`DELETE FROM lesson_progress WHERE ${lessonFilter}`, [courseIds])
   await client.query(`DELETE FROM lesson_notes WHERE ${lessonFilter}`, [courseIds])
   await client.query(`DELETE FROM lesson_video_chapters WHERE ${lessonFilter}`, [courseIds])
   await client.query(`DELETE FROM lesson_resources WHERE ${lessonFilter}`, [courseIds])
   await client.query('DELETE FROM lessons WHERE course_id = ANY($1::bigint[])', [courseIds])
   await client.query('DELETE FROM module_access_grants WHERE course_id = ANY($1::bigint[])', [courseIds])
   await client.query('DELETE FROM course_enrollments WHERE course_id = ANY($1::bigint[])', [courseIds])
   await client.query('DELETE FROM course_favorites WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM course_modules WHERE course_id = ANY($1::bigint[])', [courseIds])
   await client.query('DELETE FROM audit_events WHERE actor_user_id = ANY($1::bigint[]) OR subject_user_id = ANY($1::bigint[])', [userIds])
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

test('lessons, playback, notes, progress and offline licenses integration', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   const storage = createMemoryStorageProvider()
   const dependencies = {
      authProtection: { config },
      telegramAuth: { config },
      assets: { storage, config: storageConfig },
      lessons: { storage },
   }
   const server = await listen(createApp(dependencies))
   const port = server.address().port

   async function api(method, path, session, body) {
      const headers = { 'content-type': 'application/json' }
      if (session) headers.authorization = `Bearer ${session.accessToken}`
      const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
         method,
         headers,
         ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      return { status: response.status, body: await response.json() }
   }

   async function upload(session, courseId, kind, fileName, mimeType, buffer) {
      const created = await api('POST', '/assets/uploads', session, {
         courseId, kind, fileName, mimeType, sizeBytes: buffer.length,
      })
      assert.equal(created.status, 201, JSON.stringify(created.body))
      const { id } = created.body.data
      const storageUploadId = (await client.query(
         'SELECT storage_upload_id FROM asset_uploads WHERE id = $1',
         [id],
      )).rows[0].storage_upload_id
      storage.putPart(storageUploadId, 1, buffer)
      const done = await api('POST', `/assets/uploads/${id}/complete`, session)
      assert.equal(done.status, 200, JSON.stringify(done.body))
      return done.body.data.asset.id
   }

   async function createCourse(ownerId, modules = 2) {
      const course = await client.query(
         `INSERT INTO courses (title, status, created_by) VALUES ('M07B course', 'published', $1) RETURNING id`,
         [ownerId],
      )
      const courseId = course.rows[0].id
      const moduleIds = []
      for (let index = 1; index <= modules; index += 1) {
         const module = await client.query(
            `INSERT INTO course_modules (course_id, title, position, status)
             VALUES ($1, $2, $3, 'published') RETURNING id`,
            [courseId, `Module ${index}`, index],
         )
         moduleIds.push(module.rows[0].id)
      }
      return { courseId, moduleIds }
   }

   async function grant(adminId, userId, courseId, moduleIds, { enrollmentDays = 30, grantDays = 30 } = {}) {
      await client.query(
         `INSERT INTO course_enrollments (user_id, course_id, granted_by, begins_at, expires_at)
          VALUES ($1, $2, $3, CURRENT_TIMESTAMP - INTERVAL '1 hour', $4)`,
         [userId, courseId, adminId, new Date(Date.now() + enrollmentDays * day)],
      )
      for (const moduleId of moduleIds) {
         await client.query(
            `INSERT INTO module_access_grants (user_id, course_id, module_id, granted_by, begins_at, expires_at)
             VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP - INTERVAL '1 hour', $5)`,
            [userId, courseId, moduleId, adminId, new Date(Date.now() + grantDays * day)],
         )
      }
   }

   try {
      const ownerId = await createUser(client, 'owner', 'Owner')
      const adminId = await createUser(client, 'admin', 'Admin')
      const managerId = await createUser(client, 'teacher', 'Manager')
      const viewerId = await createUser(client, 'teacher', 'Viewer')
      const studentId = await createUser(client, 'student', 'Student')
      const lockedId = await createUser(client, 'student', 'Locked')
      const outsiderId = await createUser(client, 'student', 'Outsider')
      const peerId = await createUser(client, 'student', 'Peer')
      const watcherId = await createUser(client, 'student', 'Watcher')
      const { courseId, moduleIds } = await createCourse(ownerId)
      const { courseId: otherCourseId } = await createCourse(ownerId, 1)
      await client.query(
         `INSERT INTO course_teachers (course_id, user_id, can_manage_lessons, assigned_by)
          VALUES ($1, $2, TRUE, $4), ($1, $3, FALSE, $4)`,
         [courseId, managerId, viewerId, ownerId],
      )
      await grant(adminId, studentId, courseId, [moduleIds[0]], { grantDays: 1 })
      await grant(adminId, lockedId, courseId, [])
      await grant(adminId, peerId, courseId, [moduleIds[0]])
      await grant(adminId, watcherId, courseId, [moduleIds[0]])
      const admin = await issue(adminId)
      const manager = await issue(managerId)
      const viewer = await issue(viewerId)
      const student = await issue(studentId)
      const locked = await issue(lockedId)
      const outsider = await issue(outsiderId)
      const peer = await issue(peerId)
      const watcher = await issue(watcherId)
      const videoId = await upload(admin, courseId, 'video', 'intro.mp4', 'video/mp4', isoMedia({ seconds: 90 }))
      const pdfId = await upload(admin, courseId, 'material', 'notes.pdf', 'application/pdf', pdf)
      const foreignVideoId = await upload(admin, otherCourseId, 'video', 'other.mp4', 'video/mp4', isoMedia())
      const adminLessons = `/admin/courses/${courseId}/modules/${moduleIds[0]}/lessons`
      const lessonPath = (lessonId) => `/admin/courses/${courseId}/lessons/${lessonId}`
      let videoLessonId
      let textLessonId

      await t.test('authoring scope: manager authors, viewer reads, student is forbidden', async () => {
         const denied = await api('GET', adminLessons, student)
         assert.equal(denied.status, 403)
         const viewerCreate = await api('POST', adminLessons, viewer, { title: 'x', lessonType: 'text' })
         assert.equal(viewerCreate.status, 404)
         assert.equal(viewerCreate.body.error.code, 'COURSE_NOT_FOUND')
         const foreign = await api('POST', `/admin/courses/${otherCourseId}/modules/${moduleIds[0]}/lessons`, manager, {
            title: 'x', lessonType: 'text',
         })
         assert.equal(foreign.status, 404)
         const created = await api('POST', adminLessons, manager, {
            title: 'Intro',
            lessonType: 'video',
            videoAssetId: videoId,
            allowOffline: true,
            content: { blocks: [{ type: 'heading', text: 'Welcome', level: 1 }, { type: 'paragraph', text: 'Hi' }] },
            translations: { ru: { title: 'Введение' } },
         })
         assert.equal(created.status, 201, JSON.stringify(created.body))
         videoLessonId = created.body.data.id
         assert.equal(created.body.data.position, 1)
         assert.equal(created.body.data.status, 'draft')
         assert.equal(created.body.data.video.durationSeconds, 90)
         assert.equal(created.body.data.video.playable, true)
         const viewerRead = await api('GET', lessonPath(videoLessonId), viewer)
         assert.equal(viewerRead.status, 200)
         assert.equal(viewerRead.body.data.relationship.canManage, false)
         const viewerPreview = await api('GET', `${lessonPath(videoLessonId)}/playback`, viewer)
         assert.equal(viewerPreview.status, 200)
      })

      await t.test('lesson validation', async () => {
         const cases = [
            [{ title: 'x', lessonType: 'text', content: { blocks: [{ type: 'script', text: 'x' }] } }, 'content'],
            [{ title: 'x', lessonType: 'text', content: { blocks: [], html: '<b>' } }, 'content'],
            [{ title: 'x', lessonType: 'text', videoAssetId: videoId }, 'videoAssetId'],
            [{ title: 'x', lessonType: 'video', videoAssetId: foreignVideoId }, 'videoAssetId'],
            [{ title: 'x', lessonType: 'video', videoAssetId: pdfId }, 'videoAssetId'],
            [{ title: 'x', lessonType: 'quiz' }, 'lessonType'],
            [{ title: 'x', lessonType: 'text', translations: { de: { title: 'x' } } }, 'translations'],
         ]
         for (const [body, field] of cases) {
            const result = await api('POST', adminLessons, admin, body)
            assert.equal(result.status, 400, JSON.stringify(body))
            assert.equal(result.body.error.details[0].field, field)
         }
      })

      await t.test('chapters and materials are replaced atomically', async () => {
         const bad = await api('PUT', `${lessonPath(videoLessonId)}/chapters`, manager, {
            chapters: [{ startSeconds: 30, title: 'B' }, { startSeconds: 10, title: 'A' }],
         })
         assert.equal(bad.status, 400)
         const beyond = await api('PUT', `${lessonPath(videoLessonId)}/chapters`, manager, {
            chapters: [{ startSeconds: 0, title: 'A' }, { startSeconds: 90, title: 'End' }],
         })
         assert.equal(beyond.status, 400)
         const chapters = await api('PUT', `${lessonPath(videoLessonId)}/chapters`, manager, {
            chapters: [
               { startSeconds: 0, title: 'Start' },
               { startSeconds: 45, title: 'Middle', translations: { tg: { title: 'Миёна' } } },
            ],
         })
         assert.equal(chapters.status, 200, JSON.stringify(chapters.body))
         assert.deepEqual(chapters.body.data.chapters.map((chapter) => [chapter.startSeconds, chapter.position]), [[0, 1], [45, 2]])
         const videoAsMaterial = await api('PUT', `${lessonPath(videoLessonId)}/resources`, manager, {
            resources: [{ assetId: videoId }],
         })
         assert.equal(videoAsMaterial.status, 400)
         const resources = await api('PUT', `${lessonPath(videoLessonId)}/resources`, manager, {
            resources: [{ assetId: pdfId, title: 'Handout' }],
         })
         assert.equal(resources.status, 200, JSON.stringify(resources.body))
         assert.equal(resources.body.data.resources[0].mimeType, 'application/pdf')
         const removeVideo = await api('PATCH', lessonPath(videoLessonId), manager, { videoAssetId: null })
         assert.equal(removeVideo.body.error.code, 'LESSON_HAS_CHAPTERS')
      })

      await t.test('lifecycle, publish rules, ordering and deletion', async () => {
         const text = await api('POST', adminLessons, manager, { title: 'Reading', lessonType: 'text' })
         textLessonId = text.body.data.id
         const empty = await api('POST', adminLessons, manager, { title: 'Video soon', lessonType: 'video' })
         const quiz = await api('POST', adminLessons, manager, { title: 'Quiz', lessonType: 'test' })
         assert.equal((await api('POST', `${lessonPath(empty.body.data.id)}/publish`, manager)).body.error.code, 'LESSON_VIDEO_REQUIRED')
         assert.equal((await api('POST', `${lessonPath(quiz.body.data.id)}/publish`, manager)).body.error.code, 'LESSON_TYPE_NOT_PUBLISHABLE')
         for (const id of [videoLessonId, textLessonId]) {
            const published = await api('POST', `${lessonPath(id)}/publish`, manager)
            assert.equal(published.status, 200, JSON.stringify(published.body))
         }
         const twice = await api('POST', `${lessonPath(videoLessonId)}/publish`, manager)
         assert.equal(twice.body.error.code, 'INVALID_LESSON_TRANSITION')

         const mismatch = await api('PUT', `${adminLessons}/order`, manager, { lessonIds: [videoLessonId] })
         assert.equal(mismatch.body.error.code, 'LESSON_ORDER_MISMATCH')
         const order = [quiz.body.data.id, textLessonId, empty.body.data.id, videoLessonId]
         const reordered = await api('PUT', `${adminLessons}/order`, manager, { lessonIds: order })
         assert.equal(reordered.status, 200, JSON.stringify(reordered.body))
         assert.deepEqual(reordered.body.data.lessons.map((lesson) => lesson.id), order)
         assert.deepEqual(reordered.body.data.lessons.map((lesson) => lesson.position), [1, 2, 3, 4])

         assert.equal((await api('DELETE', lessonPath(videoLessonId), manager)).body.error.code, 'LESSON_NOT_DELETABLE')
         const deleted = await api('DELETE', lessonPath(quiz.body.data.id), manager)
         assert.equal(deleted.status, 200)
         assert.equal((await api('GET', lessonPath(quiz.body.data.id), admin)).status, 404)
      })

      await t.test('learner reads: granted content, locked metadata, hidden from outsiders', async () => {
         const listed = await api('GET', `/courses/${courseId}/modules/${moduleIds[0]}/lessons`, student)
         assert.equal(listed.status, 200)
         assert.deepEqual(listed.body.data.lessons.map((lesson) => lesson.id), [textLessonId, videoLessonId])
         assert.ok(listed.body.data.lessons.every((lesson) => lesson.access.granted))
         const detail = await api('GET', `/courses/${courseId}/lessons/${videoLessonId}`, student)
         assert.equal(detail.status, 200)
         assert.equal(detail.body.data.lesson.chapters.length, 2)
         assert.equal(detail.body.data.lesson.resources[0].title, 'Handout')
         assert.equal(detail.body.data.lesson.video.playable, true)
         assert.equal(detail.body.data.lesson.content.blocks[0].text, 'Welcome')
         const serialized = JSON.stringify(detail.body)
         assert.equal(/storage|bucket|courses\/\d+\/videos/i.test(serialized), false)
         const lockedDetail = await api('GET', `/courses/${courseId}/lessons/${videoLessonId}`, locked)
         assert.equal(lockedDetail.status, 200)
         assert.equal(lockedDetail.body.data.lesson.access.granted, false)
         assert.equal(lockedDetail.body.data.lesson.content, undefined)
         assert.equal(lockedDetail.body.data.lesson.chapters, undefined)
         assert.equal((await api('GET', `/courses/${courseId}/lessons/${videoLessonId}`, outsider)).status, 404)
         const draft = await client.query("SELECT id FROM lessons WHERE course_id = $1 AND status = 'draft' LIMIT 1", [courseId])
         assert.equal((await api('GET', `/courses/${courseId}/lessons/${draft.rows[0].id}`, student)).status, 404)
      })

      await t.test('signed playback and material URLs re-check access each time', async () => {
         const playback = await api('GET', `/courses/${courseId}/lessons/${videoLessonId}/playback`, student)
         assert.equal(playback.status, 200, JSON.stringify(playback.body))
         const expiresIn = new Date(playback.body.data.playback.expiresAt).getTime() - Date.now()
         assert.ok(expiresIn > 29 * 60 * 1000 && expiresIn <= 30 * 60 * 1000)
         assert.equal(playback.body.data.playback.mimeType, 'video/mp4')
         assert.equal(playback.body.data.chapters[1].startSeconds, 45)
         assert.equal(Object.hasOwn(playback.body.data.playback, 'storageKey'), false)
         const call = storage.calls.filter((entry) => entry.name === 'presignDownload').at(-1)
         assert.deepEqual([call.expiresIn, call.disposition, call.contentType], [1800, 'inline', 'video/mp4'])
         assert.equal(playback.body.data.playback.url.includes(env.storage.endpoint || 'minio:9000'), false)

         const denied = await api('GET', `/courses/${courseId}/lessons/${videoLessonId}/playback`, locked)
         assert.equal(denied.status, 403)
         assert.equal(denied.body.error.code, 'MODULE_ACCESS_DENIED')
         const audit = await client.query(
            "SELECT count(*)::int AS count FROM audit_events WHERE event_code = 'lesson.playback.denied' AND actor_user_id = $1",
            [lockedId],
         )
         assert.equal(audit.rows[0].count, 1)
         const issued = await client.query(
            "SELECT count(*)::int AS count FROM audit_events WHERE event_code LIKE 'lesson.playback%' AND actor_user_id = $1",
            [studentId],
         )
         assert.equal(issued.rows[0].count, 0)

         await client.query("UPDATE assets SET processing_status = 'pending' WHERE id = $1", [videoId])
         const unplayable = await api('GET', `/courses/${courseId}/lessons/${videoLessonId}/playback`, student)
         assert.equal(unplayable.body.error.code, 'VIDEO_NOT_PLAYABLE')
         await client.query("UPDATE assets SET processing_status = 'not_required' WHERE id = $1", [videoId])

         const resourceId = (await api('GET', `/courses/${courseId}/lessons/${videoLessonId}`, student)).body.data.lesson.resources[0].id
         const material = await api('GET', `/courses/${courseId}/lessons/${videoLessonId}/resources/${resourceId}/download`, student)
         assert.equal(material.status, 200)
         assert.equal(material.body.data.download.fileName, 'notes.pdf')
         const materialCall = storage.calls.filter((entry) => entry.name === 'presignDownload').at(-1)
         assert.deepEqual([materialCall.expiresIn, materialCall.disposition], [300, 'attachment'])
         const lockedMaterial = await api('GET', `/courses/${courseId}/lessons/${videoLessonId}/resources/${resourceId}/download`, locked)
         assert.equal(lockedMaterial.status, 403)
      })

      await t.test('notes are private to their owner', async () => {
         const base = `/courses/${courseId}/lessons/${videoLessonId}/notes`
         const created = await api('POST', base, student, { body: 'Remember this', playbackSeconds: 30 })
         assert.equal(created.status, 201, JSON.stringify(created.body))
         const beyond = await api('POST', base, student, { body: 'x', playbackSeconds: 91 })
         assert.equal(beyond.status, 400)
         assert.equal((await api('GET', base, peer)).body.data.notes.length, 0)
         const foreignEdit = await api('PATCH', `${base}/${created.body.data.note.id}`, peer, { body: 'hijack' })
         assert.equal(foreignEdit.status, 404)
         assert.equal((await api('GET', base, locked)).status, 403)
         const updated = await api('PATCH', `${base}/${created.body.data.note.id}`, student, { playbackSeconds: null })
         assert.equal(updated.body.data.note.playbackSeconds, null)
         const own = await api('GET', base, student)
         assert.equal(own.body.data.notes.length, 1)
      })

      await t.test('progress uses revisions, clamps to duration and completes at 90%', async () => {
         const base = `/courses/${courseId}/lessons/${videoLessonId}/progress`
         const initial = await api('GET', base, student)
         assert.equal(initial.body.data.progress.revision, 0)
         const first = await api('PUT', base, student, { revision: 0, playbackSeconds: 500, watchedSeconds: 20 })
         assert.equal(first.status, 200, JSON.stringify(first.body))
         assert.equal(first.body.data.progress.playbackSeconds, 90)
         assert.equal(first.body.data.progress.status, 'in_progress')
         const stale = await api('PUT', base, student, { revision: 0, playbackSeconds: 10, watchedSeconds: 10 })
         assert.equal(stale.status, 409)
         assert.equal(stale.body.error.code, 'PROGRESS_REVISION_CONFLICT')
         assert.equal(stale.body.error.details[0].revision, 1)
         const [a, b] = await Promise.all([
            api('PUT', base, student, { revision: 1, playbackSeconds: 40, watchedSeconds: 40 }),
            api('PUT', base, student, { revision: 1, playbackSeconds: 41, watchedSeconds: 41 }),
         ])
         assert.deepEqual([a.status, b.status].sort(), [200, 409])
         const lower = await api('PUT', base, student, { revision: 2, playbackSeconds: 5, watchedSeconds: 5 })
         assert.ok(lower.body.data.progress.watchedSeconds >= 40)
         const done = await api('PUT', base, student, { revision: 3, playbackSeconds: 85, watchedSeconds: 81 })
         assert.equal(done.body.data.progress.status, 'completed')
         assert.ok(done.body.data.progress.completedAt)
         const mixed = await api('PUT', base, student, { revision: 4, completed: true })
         assert.equal(mixed.status, 400)
         const text = await api('PUT', `/courses/${courseId}/lessons/${textLessonId}/progress`, student, {
            revision: 0, completed: true,
         })
         assert.equal(text.body.data.progress.status, 'completed')
      })

      await t.test('offline licenses: lease bounds, device limit, renewal, revocation', async () => {
         const base = `/courses/${courseId}/lessons/${videoLessonId}/offline-license`
         const notAllowed = await api('POST', `/courses/${courseId}/lessons/${textLessonId}/offline-license`, student)
         assert.equal(notAllowed.status, 403)
         assert.equal(notAllowed.body.error.details[0].reason, 'offline_not_allowed')
         const lockedLicense = await api('POST', base, locked)
         assert.equal(lockedLicense.body.error.details[0].reason, 'module_access')

         const first = await api('POST', base, student, { deviceLabel: 'Phone' })
         assert.equal(first.status, 200, JSON.stringify(first.body))
         const lease = new Date(first.body.data.license.leaseExpiresAt).getTime()
         assert.ok(lease <= Date.now() + day + 1000, 'lease is bounded by the 1-day module grant')
         assert.equal(first.body.data.license.deviceLabel, 'Phone')
         const downloadCall = storage.calls.filter((entry) => entry.name === 'presignDownload').at(-1)
         assert.deepEqual([downloadCall.expiresIn, downloadCall.disposition], [900, 'attachment'])

         const renewed = await api('POST', base, student)
         assert.equal(renewed.status, 200)
         assert.ok(renewed.body.data.license.renewedAt)
         assert.equal(renewed.body.data.license.id, first.body.data.license.id)

         const second = await issue(studentId)
         const third = await issue(studentId)
         assert.equal((await api('POST', base, second)).status, 200)
         const limited = await api('POST', base, third)
         assert.equal(limited.status, 409)
         assert.equal(limited.body.error.code, 'OFFLINE_DEVICE_LIMIT')

         const listed = await api('GET', '/offline-licenses', student)
         assert.equal(listed.body.data.licenses.length, 1)
         assert.equal((await api('GET', '/offline-licenses', third)).body.data.licenses.length, 0)
         const otherSessionDelete = await api('DELETE', `/offline-licenses/${first.body.data.license.id}`, second)
         assert.equal(otherSessionDelete.status, 404)
         const removed = await api('DELETE', `/offline-licenses/${first.body.data.license.id}`, student)
         assert.equal(removed.body.data.license.status, 'revoked')
         assert.equal((await api('DELETE', `/offline-licenses/${first.body.data.license.id}`, student)).status, 200)
         const thirdLicense = await api('POST', base, third)
         assert.equal(thirdLicense.status, 200, JSON.stringify(thirdLicense.body))

         const thirdId = thirdLicense.body.data.license.id
         const download = await api('GET', `/offline-licenses/${thirdId}/download`, third)
         assert.equal(download.status, 200)
         const adminList = await api('GET', `/admin/users/${studentId}/offline-licenses`, admin)
         assert.ok(adminList.body.data.licenses.length >= 3)
         assert.equal((await api('GET', `/admin/users/${studentId}/offline-licenses`, manager)).status, 403)
         const revoked = await api('POST', `/admin/offline-licenses/${thirdId}/revoke`, admin)
         assert.equal(revoked.body.data.license.revokeReason, 'admin_revoked')
         const renewAfterRevoke = await api('POST', base, third)
         assert.equal(renewAfterRevoke.status, 403)
         assert.equal(renewAfterRevoke.body.error.details[0].reason, 'license_revoked')

         const secondLicenses = await api('GET', '/offline-licenses', second)
         const secondId = secondLicenses.body.data.licenses[0].id
         await client.query(
            'UPDATE module_access_grants SET revoked_at = CURRENT_TIMESTAMP, revoked_by = $3 WHERE user_id = $1 AND module_id = $2',
            [studentId, moduleIds[0], adminId],
         )
         const lost = await api('GET', `/offline-licenses/${secondId}/download`, second)
         assert.equal(lost.status, 403)
         assert.equal(lost.body.error.details[0].reason, 'module_access')
         const row = await client.query('SELECT revoke_reason FROM offline_downloads WHERE id = $1', [secondId])
         assert.equal(row.rows[0].revoke_reason, 'access_lost')
         const events = await client.query(
            "SELECT DISTINCT event_code FROM audit_events WHERE event_code LIKE 'lesson.offline.%' AND subject_user_id = $1",
            [studentId],
         )
         assert.deepEqual(events.rows.map((event) => event.event_code).sort(), [
            'lesson.offline.deleted',
            'lesson.offline.denied',
            'lesson.offline.granted',
            'lesson.offline.renewed',
            'lesson.offline.revoked',
         ])
      })

      await t.test('published lessons are edited directly and stay publishable', async () => {
         const learnerPath = `/courses/${courseId}/lessons/${videoLessonId}`
         const renamed = await api('PATCH', lessonPath(videoLessonId), manager, {
            title: 'Intro (updated)',
            content: { blocks: [{ type: 'paragraph', text: 'Fresh text' }] },
         })
         assert.equal(renamed.status, 200, JSON.stringify(renamed.body))
         assert.equal(renamed.body.data.status, 'published')
         const seen = await api('GET', learnerPath, watcher)
         assert.equal(seen.body.data.lesson.title, 'Intro (updated)')
         assert.equal(seen.body.data.lesson.content.blocks[0].text, 'Fresh text')

         const chapters = await api('PUT', `${lessonPath(videoLessonId)}/chapters`, manager, {
            chapters: [{ startSeconds: 0, title: 'Start' }, { startSeconds: 45, title: 'Middle' }, { startSeconds: 60, title: 'Late' }],
         })
         assert.equal(chapters.status, 200, JSON.stringify(chapters.body))
         assert.equal((await api('GET', learnerPath, watcher)).body.data.lesson.chapters.length, 3)
         const resources = await api('PUT', `${lessonPath(videoLessonId)}/resources`, manager, {
            resources: [{ assetId: pdfId, title: 'Handout v2' }],
         })
         assert.equal(resources.status, 200)
         assert.equal((await api('GET', learnerPath, watcher)).body.data.lesson.resources[0].title, 'Handout v2')

         const removeVideo = await api('PATCH', lessonPath(videoLessonId), manager, { videoAssetId: null })
         assert.equal(removeVideo.status, 409)
         assert.equal(removeVideo.body.error.code, 'LESSON_VIDEO_REQUIRED')
         const toTest = await api('PATCH', lessonPath(videoLessonId), manager, { lessonType: 'test', videoAssetId: null })
         assert.equal(toTest.body.error.code, 'LESSON_TYPE_NOT_PUBLISHABLE')
         const foreign = await api('PATCH', lessonPath(videoLessonId), manager, { videoAssetId: foreignVideoId })
         assert.equal(foreign.status, 400)

         const shortVideoId = await upload(admin, courseId, 'video', 'short.mp4', 'video/mp4', isoMedia({ seconds: 50 }))
         const tooShort = await api('PATCH', lessonPath(videoLessonId), manager, { videoAssetId: shortVideoId, title: 'Not applied' })
         assert.equal(tooShort.status, 409)
         assert.equal(tooShort.body.error.code, 'CHAPTERS_EXCEED_VIDEO_DURATION')
         const unchanged = await api('GET', lessonPath(videoLessonId), admin)
         assert.equal(unchanged.body.data.videoAssetId, videoId)
         assert.equal(unchanged.body.data.title, 'Intro (updated)')

         const license = await api('POST', `${learnerPath}/offline-license`, watcher)
         assert.equal(license.status, 200, JSON.stringify(license.body))
         const licenseId = license.body.data.license.id
         const progressBefore = await client.query(
            'SELECT count(*)::int AS count FROM lesson_progress WHERE lesson_id = $1',
            [videoLessonId],
         )
         const longVideoId = await upload(admin, courseId, 'video', 'long.mp4', 'video/mp4', isoMedia({ seconds: 120 }))
         const replaced = await api('PATCH', lessonPath(videoLessonId), manager, { videoAssetId: longVideoId, title: 'Intro' })
         assert.equal(replaced.status, 200, JSON.stringify(replaced.body))
         assert.equal(replaced.body.data.video.durationSeconds, 120)
         const revoked = await client.query('SELECT revoke_reason FROM offline_downloads WHERE id = $1', [licenseId])
         assert.equal(revoked.rows[0].revoke_reason, 'access_lost')
         const stale = await api('GET', `/offline-licenses/${licenseId}/download`, watcher)
         assert.equal(stale.status, 403)
         assert.equal(stale.body.error.code, 'OFFLINE_ACCESS_DENIED')
         assert.equal(stale.body.error.details[0].reason, 'video_unavailable')
         const progressAfter = await client.query(
            'SELECT count(*)::int AS count FROM lesson_progress WHERE lesson_id = $1',
            [videoLessonId],
         )
         assert.equal(progressAfter.rows[0].count, progressBefore.rows[0].count)
         const playback = await api('GET', `${learnerPath}/playback`, watcher)
         assert.equal(playback.body.data.playback.durationSeconds, 120)
         const audit = await client.query(
            "SELECT metadata FROM audit_events WHERE event_code = 'lesson.updated' AND entity_id = $1 ORDER BY id DESC LIMIT 1",
            [videoLessonId],
         )
         assert.equal(audit.rows[0].metadata.revokedLicenses, 1)
         await api('PATCH', lessonPath(videoLessonId), manager, { videoAssetId: videoId })
         await api('PUT', `${lessonPath(videoLessonId)}/chapters`, manager, {
            chapters: [{ startSeconds: 0, title: 'Start' }, { startSeconds: 45, title: 'Middle' }],
         })
      })

      await t.test('progress survives revocation and expiry', async () => {
         const rows = await client.query(
            'SELECT status FROM lesson_progress WHERE user_id = $1 AND lesson_id = $2',
            [studentId, videoLessonId],
         )
         assert.equal(rows.rows[0].status, 'completed')
         const denied = await api('GET', `/courses/${courseId}/lessons/${videoLessonId}/progress`, student)
         assert.equal(denied.status, 403)
      })

      await t.test('course favorites', async () => {
         assert.equal((await api('PUT', `/courses/${courseId}/favorite`, peer)).status, 200)
         assert.equal((await api('PUT', `/courses/${courseId}/favorite`, peer)).status, 200)
         assert.equal((await api('PUT', `/courses/${courseId}/favorite`, outsider)).status, 404)
         const favorites = await api('GET', '/courses/favorites', peer)
         assert.deepEqual(favorites.body.data.favorites.map((favorite) => favorite.courseId), [courseId])
         await api('DELETE', `/courses/${courseId}/favorite`, peer)
         assert.equal((await api('GET', '/courses/favorites', peer)).body.data.favorites.length, 0)
      })

      await t.test('course copy brings lessons, chapters and materials but no learner data', async () => {
         const copied = await api('POST', `/admin/courses/${courseId}/copy`, admin, {})
         assert.equal(copied.status, 201, JSON.stringify(copied.body))
         const { copied: counts, course } = copied.body.data
         assert.equal(counts.lessons, 3)
         assert.equal(counts.chapters, 2)
         assert.equal(counts.resources, 1)
         const lessons = await client.query(
            'SELECT id, status, video_asset_id, title FROM lessons WHERE course_id = $1 ORDER BY module_id, position',
            [course.id],
         )
         assert.ok(lessons.rows.every((lesson) => lesson.status === 'draft'))
         const video = lessons.rows.find((lesson) => lesson.title === 'Intro')
         assert.equal(video.video_asset_id, videoId)
         const learnerRows = await client.query(
            `SELECT (SELECT count(*) FROM lesson_progress WHERE lesson_id = ANY($1::bigint[]))
                + (SELECT count(*) FROM lesson_notes WHERE lesson_id = ANY($1::bigint[]))
                + (SELECT count(*) FROM offline_downloads WHERE lesson_id = ANY($1::bigint[]))
                + (SELECT count(*) FROM course_favorites WHERE course_id = $2) AS total`,
            [lessons.rows.map((lesson) => lesson.id), course.id],
         )
         assert.equal(Number(learnerRows.rows[0].total), 0)
         const copiedDetail = await api('GET', `/admin/courses/${course.id}/lessons/${video.id}`, admin)
         assert.equal(copiedDetail.body.data.chapters.length, 2)
         const publishCopy = await api('POST', `/admin/courses/${course.id}/lessons/${video.id}/publish`, admin)
         assert.equal(publishCopy.status, 200, JSON.stringify(publishCopy.body))
      })

      await t.test('signed media issuance is rate limited per user', async () => {
         const limitedServer = await listen(createApp({
            ...dependencies,
            authProtection: { config: { ...config, playbackRateLimit: 2 } },
         }))
         try {
            const limitedPort = limitedServer.address().port
            const statuses = []
            for (let index = 0; index < 3; index += 1) {
               const response = await fetch(
                  `http://127.0.0.1:${limitedPort}/api/v1/courses/${courseId}/lessons/${videoLessonId}/playback`,
                  { headers: { authorization: `Bearer ${peer.accessToken}` } },
               )
               statuses.push(response.status)
            }
            assert.deepEqual(statuses, [200, 200, 429])
         } finally {
            await new Promise((resolve) => limitedServer.close(resolve))
         }
      })
   } finally {
      await new Promise((resolve) => server.close(resolve))
      await cleanup(client)
      await client.end()
   }
})
