import assert from 'node:assert/strict'
import test from 'node:test'

import pg from 'pg'

import { createApp } from '../../src/app.js'
import env from '../../src/configs/env.js'
import { withTransaction } from '../../src/repositories/transaction-repository.js'
import { issueSessionService } from '../../src/services/auth/session-service.js'

const { Client } = pg
const userIds = []
const courseIds = []
const config = {
   ...env,
   jwtAccessSecret: 'course-modules-integration-secret-longer-than-32-characters',
   authSessionTtlSeconds: 900,
   authRefreshTtlSeconds: 86400,
   authAdminRateLimit: 1000,
}

async function createUser(client, role, name) {
   const user = await client.query("INSERT INTO users (status) VALUES ('active') RETURNING id")
   const userId = user.rows[0].id
   userIds.push(userId)
   await client.query(
      `INSERT INTO user_profiles (user_id, first_name, last_name)
       VALUES ($1, $2, 'M05B')`,
      [userId, name],
   )
   await client.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, id FROM roles WHERE code = $2`,
      [userId, role],
   )
   return userId
}

async function issue(userId) {
   return withTransaction((client) => issueSessionService({
      userId,
      requestContext: { userAgent: 'M05-B integration', ipAddress: '127.0.0.1' },
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
   await client.query('DELETE FROM test_assignments WHERE assigned_by = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM tests WHERE created_by = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM lessons WHERE course_id = ANY($1::bigint[])', [courseIds])
   await client.query('DELETE FROM course_modules WHERE course_id = ANY($1::bigint[])', [courseIds])
   await client.query("DELETE FROM audit_events WHERE event_code LIKE 'course.%' AND actor_user_id = ANY($1::bigint[])", [userIds])
   await client.query('DELETE FROM course_teachers WHERE course_id = ANY($1::bigint[])', [courseIds])
   await client.query('DELETE FROM courses WHERE id = ANY($1::bigint[]) OR created_by = ANY($2::bigint[])', [courseIds, userIds])
   await client.query('DELETE FROM auth_refresh_tokens WHERE session_id IN (SELECT id FROM auth_sessions WHERE user_id = ANY($1::bigint[]))', [userIds])
   await client.query('DELETE FROM auth_sessions WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM user_roles WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM user_profiles WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [userIds])
}

test('course modules, preview and copy integration', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   const app = createApp({ authProtection: { config }, telegramAuth: { config } })
   const server = await listen(app)
   const port = server.address().port
   const base = '/api/v1/admin/courses'

   try {
      const adminId = await createUser(client, 'admin', 'Admin')
      const studentId = await createUser(client, 'student', 'Student')
      const teacherId = await createUser(client, 'teacher', 'Teacher')
      const unassignedTeacherId = await createUser(client, 'teacher', 'Unassigned')
      const sessions = {
         admin: await issue(adminId),
         student: await issue(studentId),
         teacher: await issue(teacherId),
         unassignedTeacher: await issue(unassignedTeacherId),
      }

      const course = await api(port, 'POST', base, sessions.admin, {
         title: 'Geometry',
         translations: { tg: { title: 'Геометрия' } },
      })
      const courseId = course.body.data.id
      courseIds.push(courseId)
      await api(port, 'POST', `${base}/${courseId}/teachers`, sessions.admin, {
         userId: teacherId,
         canEditCourse: false,
      })

      const moduleIds = []
      await t.test('appends modules in order, including concurrent creation', async () => {
         const first = await api(port, 'POST', `${base}/${courseId}/modules`, sessions.admin, {
            title: '  Triangles  ',
            description: 'Basics',
            translations: { en: { title: 'Triangles' } },
         })
         assert.equal(first.response.status, 201)
         assert.equal(first.body.data.title, 'Triangles')
         assert.equal(first.body.data.position, 1)
         assert.equal(first.body.data.status, 'draft')
         assert.equal(typeof first.body.data.id, 'string')
         moduleIds.push(first.body.data.id)

         const concurrent = await Promise.all(['Circles', 'Polygons'].map((title) => (
            api(port, 'POST', `${base}/${courseId}/modules`, sessions.admin, { title })
         )))
         assert.deepEqual(concurrent.map(({ response }) => response.status), [201, 201])
         assert.deepEqual(
            concurrent.map(({ body }) => body.data.position).sort(),
            [2, 3],
         )
         for (const { body } of concurrent.sort((a, b) => a.body.data.position - b.body.data.position)) {
            moduleIds.push(body.data.id)
         }
      })

      await t.test('validates module input and hides foreign modules', async () => {
         for (const body of [{ title: '' }, { status: 'published' }, { position: 1 }, { title: 'x'.repeat(201) }]) {
            const result = await api(port, 'POST', `${base}/${courseId}/modules`, sessions.admin, body)
            assert.equal(result.response.status, 400)
            assert.equal(result.body.error.code, 'VALIDATION_ERROR')
         }
         const other = await api(port, 'POST', base, sessions.admin, { title: 'Other' })
         courseIds.push(other.body.data.id)
         const foreign = await api(port, 'PATCH', `${base}/${other.body.data.id}/modules/${moduleIds[0]}`, sessions.admin, { title: 'Moved' })
         assert.equal(foreign.response.status, 404)
         assert.equal(foreign.body.error.code, 'COURSE_MODULE_NOT_FOUND')
         const invalid = await api(port, 'PATCH', `${base}/${courseId}/modules/abc`, sessions.admin, { title: 'Bad' })
         assert.equal(invalid.body.error.code, 'INVALID_MODULE_ID')
         const updated = await api(port, 'PATCH', `${base}/${courseId}/modules/${moduleIds[0]}`, sessions.admin, {
            description: null,
         })
         assert.equal(updated.response.status, 200)
         assert.equal(updated.body.data.description, null)
         assert.equal(updated.body.data.title, 'Triangles')
      })

      await t.test('enforces draft -> published -> archived -> draft transitions', async () => {
         const path = `${base}/${courseId}/modules/${moduleIds[0]}`
         const earlyArchive = await api(port, 'POST', `${path}/archive`, sessions.admin)
         assert.equal(earlyArchive.response.status, 409)
         assert.equal(earlyArchive.body.error.code, 'INVALID_MODULE_TRANSITION')
         const published = await api(port, 'POST', `${path}/publish`, sessions.admin)
         assert.equal(published.body.data.status, 'published')
         assert.equal((await api(port, 'POST', `${path}/publish`, sessions.admin)).response.status, 409)
         assert.equal((await api(port, 'POST', `${path}/restore`, sessions.admin)).response.status, 409)
         const archived = await api(port, 'POST', `${path}/archive`, sessions.admin)
         assert.equal(archived.body.data.status, 'archived')
         assert.equal(archived.body.data.position, 1)
         const restored = await api(port, 'POST', `${path}/restore`, sessions.admin)
         assert.equal(restored.body.data.status, 'draft')
         await api(port, 'POST', `${path}/publish`, sessions.admin)
         await api(port, 'POST', `${path}/archive`, sessions.admin)
         await api(port, 'POST', `${base}/${courseId}/modules/${moduleIds[1]}/publish`, sessions.admin)
      })

      await t.test('reorders with a complete id list in two passes', async () => {
         const path = `${base}/${courseId}/modules/order`
         const duplicate = await api(port, 'PUT', path, sessions.admin, {
            moduleIds: [moduleIds[0], moduleIds[0], moduleIds[1]],
         })
         assert.equal(duplicate.response.status, 400)
         assert.equal(duplicate.body.error.code, 'VALIDATION_ERROR')
         const incomplete = await api(port, 'PUT', path, sessions.admin, { moduleIds: moduleIds.slice(0, 2) })
         assert.equal(incomplete.response.status, 409)
         assert.equal(incomplete.body.error.code, 'COURSE_MODULE_ORDER_MISMATCH')
         const foreign = await api(port, 'PUT', path, sessions.admin, {
            moduleIds: [moduleIds[0], moduleIds[1], '9223372036854775807'],
         })
         assert.equal(foreign.body.error.code, 'COURSE_MODULE_ORDER_MISMATCH')

         const reversed = [...moduleIds].reverse()
         const reordered = await api(port, 'PUT', path, sessions.admin, { moduleIds: reversed })
         assert.equal(reordered.response.status, 200)
         assert.deepEqual(reordered.body.data.modules.map(({ id }) => id), reversed)
         assert.deepEqual(reordered.body.data.modules.map(({ position }) => position), [1, 2, 3])
      })

      await t.test('previews structure with lesson and test counts for admins and course teachers', async () => {
         const lesson = await client.query(
            `INSERT INTO lessons (module_id, course_id, title, position, lesson_type, created_by)
             VALUES ($1, $2, 'Angles', 1, 'text', $3) RETURNING id`,
            [moduleIds[1], courseId, adminId],
         )
         const createdTest = await client.query(
            "INSERT INTO tests (title, mode, created_by) VALUES ('Quiz', 'practice', $1) RETURNING id",
            [adminId],
         )
         await client.query(
            'INSERT INTO test_assignments (test_id, lesson_id, assigned_by) VALUES ($1, $2, $3)',
            [createdTest.rows[0].id, lesson.rows[0].id, adminId],
         )

         const preview = await api(port, 'GET', `${base}/${courseId}/preview`, sessions.teacher)
         assert.equal(preview.response.status, 200)
         assert.deepEqual(preview.body.data.course, { id: courseId, title: 'Geometry', status: 'draft' })
         const withLesson = preview.body.data.modules.find(({ id }) => id === moduleIds[1])
         assert.equal(withLesson.lessonsCount, 1)
         assert.equal(withLesson.testsCount, 1)
         assert.deepEqual(Object.keys(withLesson).sort(), [
            'description', 'id', 'lessonsCount', 'position', 'status', 'testsCount', 'title',
         ])
         assert.deepEqual(preview.body.data.modules.map(({ position }) => position), [1, 2, 3])

         const unassigned = await api(port, 'GET', `${base}/${courseId}/preview`, sessions.unassignedTeacher)
         assert.equal(unassigned.response.status, 404)
         const student = await api(port, 'GET', `${base}/${courseId}/preview`, sessions.student)
         assert.equal(student.response.status, 403)

         const grants = await client.query(
            `SELECT
               (SELECT count(*)::int FROM course_enrollments WHERE course_id = $1) AS enrollments,
               (SELECT count(*)::int FROM module_access_grants WHERE course_id = $1) AS modules`,
            [courseId],
         )
         assert.deepEqual(grants.rows[0], { enrollments: 0, modules: 0 })
      })

      await t.test('deletes only empty draft modules', async () => {
         const withLessons = await api(port, 'DELETE', `${base}/${courseId}/modules/${moduleIds[1]}`, sessions.admin)
         assert.equal(withLessons.response.status, 409)
         assert.equal(withLessons.body.error.code, 'COURSE_MODULE_NOT_DELETABLE')
         const archived = await api(port, 'DELETE', `${base}/${courseId}/modules/${moduleIds[0]}`, sessions.admin)
         assert.equal(archived.body.error.code, 'COURSE_MODULE_NOT_DELETABLE')

         const empty = await api(port, 'POST', `${base}/${courseId}/modules`, sessions.admin, { title: 'Temporary' })
         assert.equal(empty.body.data.position, 4)
         const deleted = await api(port, 'DELETE', `${base}/${courseId}/modules/${empty.body.data.id}`, sessions.admin)
         assert.equal(deleted.response.status, 200)
         assert.deepEqual(deleted.body.data, { id: empty.body.data.id, status: 'deleted' })
      })

      await t.test('limits module management to administrators and editing teachers', async () => {
         const path = `${base}/${courseId}/modules`
         const student = await api(port, 'POST', path, sessions.student, { title: 'No' })
         assert.equal(student.response.status, 403)
         assert.equal(student.body.error.code, 'ACTION_FORBIDDEN')
         const viewer = await api(port, 'POST', path, sessions.teacher, { title: 'No' })
         assert.equal(viewer.response.status, 404)
         assert.equal(viewer.body.error.code, 'COURSE_NOT_FOUND')

         await api(port, 'PATCH', `${base}/${courseId}/teachers/${teacherId}`, sessions.admin, { canEditCourse: true })
         const editor = await api(port, 'POST', path, sessions.teacher, { title: 'Teacher module' })
         assert.equal(editor.response.status, 201)
         moduleIds.push(editor.body.data.id)
         const copyDenied = await api(port, 'POST', `${base}/${courseId}/copy`, sessions.teacher, {})
         assert.equal(copyDenied.response.status, 403)
      })

      await t.test('copies course and modules as drafts without teachers or grants', async () => {
         const copied = await api(port, 'POST', `${base}/${courseId}/copy`, sessions.admin)
         assert.equal(copied.response.status, 201)
         const copy = copied.body.data.course
         courseIds.push(copy.id)
         assert.equal(copy.title, 'Geometry (copy)')
         assert.equal(copy.status, 'draft')
         assert.deepEqual(copy.translations, { tg: { title: 'Геометрия' } })
         assert.equal(copied.body.data.sourceCourseId, courseId)
         assert.deepEqual(copied.body.data.copied, { modules: 4 })

         const source = await client.query(
            'SELECT title, description, position, translations FROM course_modules WHERE course_id = $1 ORDER BY position',
            [courseId],
         )
         const target = await client.query(
            'SELECT title, description, position, translations, status FROM course_modules WHERE course_id = $1 ORDER BY position',
            [copy.id],
         )
         assert.deepEqual(target.rows.map(({ status, ...row }) => { void status; return row }), source.rows)
         assert.ok(target.rows.every(({ status }) => status === 'draft'))

         const leftovers = await client.query(
            `SELECT
               (SELECT count(*)::int FROM course_teachers WHERE course_id = $1) AS teachers,
               (SELECT count(*)::int FROM course_enrollments WHERE course_id = $1) AS enrollments,
               (SELECT count(*)::int FROM module_access_grants WHERE course_id = $1) AS grants,
               (SELECT count(*)::int FROM lessons WHERE course_id = $1) AS lessons`,
            [copy.id],
         )
         assert.deepEqual(leftovers.rows[0], { teachers: 0, enrollments: 0, grants: 0, lessons: 0 })

         const named = await api(port, 'POST', `${base}/${courseId}/copy`, sessions.admin, { title: 'Geometry 2027' })
         courseIds.push(named.body.data.course.id)
         assert.equal(named.body.data.course.title, 'Geometry 2027')
         const unknown = await api(port, 'POST', `${base}/${courseId}/copy`, sessions.admin, { code: 'GEO' })
         assert.equal(unknown.response.status, 400)
         const missing = await api(port, 'POST', `${base}/9223372036854775807/copy`, sessions.admin, {})
         assert.equal(missing.response.status, 404)
      })

      await t.test('rolls back the whole copy when audit persistence fails', async () => {
         const title = `Rollback copy ${Date.now()}`
         const rollbackServer = await listen(createApp({
            authProtection: { config },
            telegramAuth: { config },
            courseModules: {
               auth: { appendAuditEvent: async () => { throw new Error('injected audit failure') } },
            },
         }))
         try {
            const result = await api(rollbackServer.address().port, 'POST', `${base}/${courseId}/copy`, sessions.admin, { title })
            assert.equal(result.response.status, 500)
            const persisted = await client.query(
               `SELECT count(*)::int AS courses,
                  (SELECT count(*)::int FROM course_modules AS module
                    JOIN courses AS course ON course.id = module.course_id
                    WHERE course.title = $1) AS modules
                FROM courses WHERE title = $1`,
               [title],
            )
            assert.deepEqual(persisted.rows[0], { courses: 0, modules: 0 })
         } finally {
            await new Promise((resolve) => rollbackServer.close(resolve))
         }
      })

      await t.test('audits module mutations and copies', async () => {
         const events = await client.query(
            `SELECT event_code FROM audit_events
             WHERE actor_user_id = ANY($1::bigint[])
               AND (event_code LIKE 'course.module%' OR event_code = 'course.copied')`,
            [userIds],
         )
         const codes = new Set(events.rows.map(({ event_code: code }) => code))
         for (const code of [
            'course.module.created',
            'course.module.updated',
            'course.module.published',
            'course.module.archived',
            'course.module.restored',
            'course.module.deleted',
            'course.modules.reordered',
            'course.copied',
         ]) {
            assert.ok(codes.has(code), code)
         }
      })
   } finally {
      await cleanup(client)
      await client.end()
      await new Promise((resolve) => server.close(resolve))
   }
})
