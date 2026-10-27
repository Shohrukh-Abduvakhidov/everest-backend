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
const subjectIds = []
const config = {
   ...env,
   jwtAccessSecret: 'course-management-integration-secret-longer-than-32-characters',
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
       VALUES ($1, $2, 'M05A')`,
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
      requestContext: { userAgent: 'M05-A integration', ipAddress: '127.0.0.1' },
      client,
   }, { config }))
}

async function api(port, method, path, session, body, cookie = false, csrf = true) {
   const headers = { 'content-type': 'application/json' }
   if (session) {
      if (cookie) {
         headers.cookie = `everest_access=${session.accessToken}`
         headers.origin = env.corsOrigins[0]
         if (csrf) headers['x-csrf-token'] = session.csrfToken
      } else {
         headers.authorization = `Bearer ${session.accessToken}`
      }
   }
   const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
   })
   return { response, body: await response.json() }
}

async function cleanup(client) {
   if (!userIds.length) return
   await client.query("DELETE FROM audit_events WHERE event_code LIKE 'course.%' AND actor_user_id = ANY($1::bigint[])", [userIds])
   await client.query('DELETE FROM course_teachers WHERE course_id = ANY($1::bigint[])', [courseIds])
   await client.query('DELETE FROM courses WHERE id = ANY($1::bigint[])', [courseIds])
   await client.query('DELETE FROM subjects WHERE id = ANY($1::bigint[])', [subjectIds])
   await client.query('DELETE FROM auth_refresh_tokens WHERE session_id IN (SELECT id FROM auth_sessions WHERE user_id = ANY($1::bigint[]))', [userIds])
   await client.query('DELETE FROM auth_sessions WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM user_roles WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM user_profiles WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [userIds])
}

test('course management lifecycle integration', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   const app = createApp({ authProtection: { config }, telegramAuth: { config } })
   const server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
   })
   const port = server.address().port

   try {
      const ownerId = await createUser(client, 'owner', 'Owner')
      const adminId = await createUser(client, 'admin', 'Admin')
      const studentId = await createUser(client, 'student', 'Student')
      const teacherId = await createUser(client, 'teacher', 'Teacher')
      const unassignedTeacherId = await createUser(client, 'teacher', 'Unassigned')
      const subject = await client.query(
         `INSERT INTO subjects (code, primary_language)
          VALUES ($1, 'ru') RETURNING id`,
         [`m05a-${Date.now()}`],
      )
      const subjectId = subject.rows[0].id
      subjectIds.push(subjectId)
      const sessions = {
         owner: await issue(ownerId),
         admin: await issue(adminId),
         student: await issue(studentId),
         teacher: await issue(teacherId),
         unassignedTeacher: await issue(unassignedTeacherId),
      }

      await t.test('requires authentication, permission, and cookie CSRF', async () => {
         const anonymous = await api(port, 'GET', '/api/v1/admin/courses')
         assert.equal(anonymous.response.status, 401)
         const denied = await api(port, 'POST', '/api/v1/admin/courses', sessions.student, { title: 'No' })
         assert.equal(denied.response.status, 403)
         assert.equal(denied.body.error.code, 'ACTION_FORBIDDEN')
         const csrf = await api(port, 'POST', '/api/v1/admin/courses', sessions.admin, { title: 'No CSRF' }, true, false)
         assert.equal(csrf.response.status, 403)
         assert.equal(csrf.body.error.code, 'CSRF_TOKEN_INVALID')
      })

      let courseId
      let incompleteCourseId
      await t.test('creates safe draft courses and partially updates schema fields', async () => {
         const created = await api(port, 'POST', '/api/v1/admin/courses', sessions.admin, {
            subjectId,
            title: '  Algebra  ',
            description: '  Core course  ',
            languageCode: 'ru',
            translations: { tg: { title: 'Алгебра' }, en: { title: 'Algebra' } },
         })
         assert.equal(created.response.status, 201)
         assert.equal(typeof created.body.data.id, 'string')
         assert.equal(created.body.data.title, 'Algebra')
         assert.equal(created.body.data.status, 'draft')
         courseId = created.body.data.id
         courseIds.push(courseId)

         const incomplete = await api(port, 'POST', '/api/v1/admin/courses', sessions.owner, {
            title: 'Incomplete Draft',
         })
         assert.equal(incomplete.response.status, 201)
         incompleteCourseId = incomplete.body.data.id
         courseIds.push(incompleteCourseId)

         const updated = await api(port, 'PATCH', `/api/v1/admin/courses/${courseId}`, sessions.owner, {
            description: null,
            languageCode: 'tg',
         })
         assert.equal(updated.response.status, 200)
         assert.equal(updated.body.data.description, null)
         assert.equal(updated.body.data.title, 'Algebra')
         assert.equal(updated.body.data.languageCode, 'tg')
      })

      await t.test('rejects unknown, protected, malformed, and missing reference fields', async () => {
         for (const body of [
            { status: 'published' },
            { createdBy: studentId },
            { title: '' },
            { languageCode: 'de' },
            { translations: { de: { title: 'Nein' } } },
            { subjectId: '9223372036854775807' },
         ]) {
            const result = await api(port, 'PATCH', `/api/v1/admin/courses/${courseId}`, sessions.admin, body)
            assert.equal(result.response.status, 400)
            assert.equal(result.body.error.code, 'VALIDATION_ERROR')
         }
      })

      await t.test('lists and reads courses for owner/admin but denies students', async () => {
         const list = await api(port, 'GET', '/api/v1/admin/courses?limit=1&offset=0', sessions.owner)
         assert.equal(list.response.status, 200)
         assert.equal(list.body.data.courses.length, 1)
         assert.equal(list.body.data.pagination.hasMore, true)
         const detail = await api(port, 'GET', `/api/v1/admin/courses/${courseId}`, sessions.admin)
         assert.equal(detail.body.data.id, courseId)
         for (const forbidden of ['enrollments', 'modules', 'accessGrants']) {
            assert.equal(Object.hasOwn(detail.body.data, forbidden), false)
         }
         const denied = await api(port, 'GET', '/api/v1/admin/courses', sessions.student)
         assert.equal(denied.response.status, 403)
      })

      await t.test('publishes and unpublishes only through valid explicit transitions', async () => {
         const incomplete = await api(port, 'POST', `/api/v1/admin/courses/${incompleteCourseId}/publish`, sessions.admin)
         assert.equal(incomplete.response.status, 409)
         assert.equal(incomplete.body.error.code, 'COURSE_NOT_READY_FOR_PUBLICATION')
         const published = await api(port, 'POST', `/api/v1/admin/courses/${courseId}/publish`, sessions.owner)
         assert.equal(published.body.data.status, 'published')
         const repeated = await api(port, 'POST', `/api/v1/admin/courses/${courseId}/publish`, sessions.admin)
         assert.equal(repeated.response.status, 409)
         assert.equal(repeated.body.error.code, 'INVALID_COURSE_TRANSITION')
         const teacherDenied = await api(port, 'POST', `/api/v1/admin/courses/${courseId}/unpublish`, sessions.teacher)
         assert.equal(teacherDenied.response.status, 403)
         const unpublished = await api(port, 'POST', `/api/v1/admin/courses/${courseId}/unpublish`, sessions.admin)
         assert.equal(unpublished.body.data.status, 'draft')
      })

      await t.test('assigns teachers atomically and rejects duplicate concurrent assignment', async () => {
         const add = () => api(port, 'POST', `/api/v1/admin/courses/${courseId}/teachers`, sessions.admin, {
            userId: teacherId,
            canEditCourse: false,
            canManageLessons: true,
         })
         const concurrent = await Promise.all([add(), add()])
         assert.deepEqual(concurrent.map(({ response }) => response.status).sort(), [201, 409])
         const wrongRole = await api(port, 'POST', `/api/v1/admin/courses/${courseId}/teachers`, sessions.owner, {
            userId: studentId,
         })
         assert.equal(wrongRole.body.error.code, 'COURSE_TEACHER_INELIGIBLE')
      })

      await t.test('scopes teacher reads and editing to assignment permissions', async () => {
         const visible = await api(port, 'GET', `/api/v1/admin/courses/${courseId}`, sessions.teacher)
         assert.equal(visible.response.status, 200)
         assert.equal(visible.body.data.relationship.canEdit, false)
         const list = await api(port, 'GET', '/api/v1/admin/courses', sessions.teacher)
         assert.deepEqual(list.body.data.courses.map(({ id }) => id), [courseId])

         const missing = await api(port, 'GET', '/api/v1/admin/courses/9223372036854775807', sessions.unassignedTeacher)
         const inaccessible = await api(port, 'GET', `/api/v1/admin/courses/${courseId}`, sessions.unassignedTeacher)
         assert.equal(missing.response.status, 404)
         assert.deepEqual(inaccessible.body, missing.body)

         const editDenied = await api(port, 'PATCH', `/api/v1/admin/courses/${courseId}`, sessions.teacher, { title: 'Denied' })
         assert.equal(editDenied.response.status, 404)
         assert.equal(editDenied.body.error.code, 'COURSE_NOT_FOUND')

         const permission = await api(port, 'PATCH', `/api/v1/admin/courses/${courseId}/teachers/${teacherId}`, sessions.admin, {
            canEditCourse: true,
            canViewResults: true,
         })
         assert.equal(permission.body.data.permissions.editCourse, true)
         const edited = await api(port, 'PATCH', `/api/v1/admin/courses/${courseId}`, sessions.teacher, { title: 'Teacher Edit' })
         assert.equal(edited.response.status, 200)
         assert.equal(edited.body.data.title, 'Teacher Edit')
      })

      await t.test('lists, removes, and reassigns teachers without creating access grants', async () => {
         const roster = await api(port, 'GET', `/api/v1/admin/courses/${courseId}/teachers`, sessions.teacher)
         assert.equal(roster.response.status, 200)
         assert.equal(roster.body.data.teachers[0].id, teacherId)
         const removed = await api(port, 'DELETE', `/api/v1/admin/courses/${courseId}/teachers/${teacherId}`, sessions.owner)
         assert.equal(removed.body.data.status, 'removed')
         const reassigned = await api(port, 'POST', `/api/v1/admin/courses/${courseId}/teachers`, sessions.admin, {
            userId: teacherId,
            canEditCourse: true,
         })
         assert.equal(reassigned.response.status, 201)
         const grants = await client.query(
            `SELECT
               (SELECT count(*)::int FROM course_enrollments WHERE course_id = $1) AS enrollments,
               (SELECT count(*)::int FROM module_access_grants WHERE course_id = $1) AS modules,
               (SELECT count(*)::int FROM group_members WHERE user_id = $2) AS groups`,
            [courseId, teacherId],
         )
         assert.deepEqual(grants.rows[0], { enrollments: 0, modules: 0, groups: 0 })
      })

      await t.test('rolls back course creation when audit persistence fails', async () => {
         const title = `Rollback ${Date.now()}`
         const rollbackApp = createApp({
            authProtection: { config },
            telegramAuth: { config },
            courses: {
               auth: { appendAuditEvent: async () => { throw new Error('injected audit failure') } },
            },
         })
         const rollbackServer = await new Promise((resolve) => {
            const listener = rollbackApp.listen(0, '127.0.0.1', () => resolve(listener))
         })
         try {
            const result = await api(rollbackServer.address().port, 'POST', '/api/v1/admin/courses', sessions.admin, {
               subjectId,
               title,
            })
            assert.equal(result.response.status, 500)
            const persisted = await client.query('SELECT id FROM courses WHERE title = $1', [title])
            assert.equal(persisted.rowCount, 0)
         } finally {
            await new Promise((resolve) => rollbackServer.close(resolve))
         }
      })

      await t.test('audits successful course mutations', async () => {
         const events = await client.query(
            "SELECT count(*)::int AS count FROM audit_events WHERE event_code LIKE 'course.%' AND actor_user_id = ANY($1::bigint[])",
            [userIds],
         )
         assert.ok(events.rows[0].count >= 9)
      })
   } finally {
      await cleanup(client)
      await client.end()
      await new Promise((resolve) => server.close(resolve))
   }
})
