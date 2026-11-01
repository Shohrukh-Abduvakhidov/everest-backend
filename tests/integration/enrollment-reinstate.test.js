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
   jwtAccessSecret: 'enrollment-reinstate-integration-secret-longer-than-32-chars',
   authSessionTtlSeconds: 900,
   authRefreshTtlSeconds: 86400,
   authAdminRateLimit: 1000,
}
const day = 24 * 60 * 60 * 1000

function future(days = 30) {
   return new Date(Date.now() + days * day).toISOString()
}

async function createUser(client, role, name, phone = null) {
   const user = await client.query(
      `INSERT INTO users (status, onboarding_completed_at)
       VALUES ('active', CURRENT_TIMESTAMP) RETURNING id`,
   )
   const userId = user.rows[0].id
   userIds.push(userId)
   await client.query(
      `INSERT INTO user_profiles (user_id, first_name, last_name) VALUES ($1, $2, 'Reinstate')`,
      [userId, name],
   )
   await client.query(
      `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2`,
      [userId, role],
   )
   if (phone) {
      await client.query(
         'INSERT INTO user_phones (user_id, phone_e164) VALUES ($1, $2)',
         [userId, phone],
      )
   }
   return userId
}

async function issue(userId) {
   return withTransaction((client) => issueSessionService({
      userId,
      requestContext: { userAgent: 'reinstate integration', ipAddress: '127.0.0.1' },
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
   await client.query('DELETE FROM module_access_grants WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM course_enrollments WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM course_modules WHERE course_id = ANY($1::bigint[])', [courseIds])
   await client.query("DELETE FROM audit_events WHERE event_code LIKE 'course.%' AND (actor_user_id = ANY($1::bigint[]) OR subject_user_id = ANY($1::bigint[]))", [userIds])
   await client.query('DELETE FROM course_teachers WHERE course_id = ANY($1::bigint[])', [courseIds])
   await client.query('DELETE FROM courses WHERE id = ANY($1::bigint[]) OR created_by = ANY($2::bigint[])', [courseIds, userIds])
   await client.query('DELETE FROM subjects WHERE id = ANY($1::bigint[])', [subjectIds])
   await client.query('DELETE FROM auth_refresh_tokens WHERE session_id IN (SELECT id FROM auth_sessions WHERE user_id = ANY($1::bigint[]))', [userIds])
   await client.query('DELETE FROM auth_sessions WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM user_phones WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM user_roles WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM user_profiles WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [userIds])
}

test('enrollment reinstatement and enrollment candidate filters integration', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   const app = createApp({ authProtection: { config }, telegramAuth: { config } })
   const server = await listen(app)
   const port = server.address().port
   const admin = '/api/v1/admin/courses'
   const phone = `+992${String(Date.now()).slice(-9)}`

   try {
      const subject = await client.query(
         "INSERT INTO subjects (code, primary_language) VALUES ($1, 'tg') RETURNING id",
         [`reinstate-${Date.now()}`],
      )
      subjectIds.push(subject.rows[0].id)
      const adminId = await createUser(client, 'admin', 'Admin')
      const studentId = await createUser(client, 'student', 'Student', phone)
      const otherStudentId = await createUser(client, 'student', 'Other')
      const session = await issue(adminId)

      const course = await api(port, 'POST', admin, session, { title: 'Reinstate Course', subjectId: null })
      const courseId = course.body.data.id
      courseIds.push(courseId)
      const module = await api(port, 'POST', `${admin}/${courseId}/modules`, session, {
         title: 'Reinstate module',
         description: 'Public description',
      })
      const moduleId = module.body.data.id
      await api(port, 'POST', `${admin}/${courseId}/modules/${moduleId}/publish`, session)
      await client.query('UPDATE courses SET subject_id = $2 WHERE id = $1', [courseId, subjectIds[0]])
      const published = await api(port, 'POST', `${admin}/${courseId}/publish`, session)
      assert.equal(published.response.status, 200, JSON.stringify(published.body))
      const enrollments = `${admin}/${courseId}/enrollments`
      const modules = `${enrollments}/${studentId}/modules`
      const candidates = `/api/v1/admin/users?q=Reinstate&role=student&limit=100&notEnrolledInCourse=${courseId}`

      await t.test('an active duplicate enrollment and module grant still return 409', async () => {
         const first = await api(port, 'POST', enrollments, session, { userId: studentId, expiresAt: future(10) })
         assert.equal(first.response.status, 201)
         const duplicate = await api(port, 'POST', enrollments, session, { userId: studentId, expiresAt: null })
         assert.equal(duplicate.response.status, 409)
         assert.equal(duplicate.body.error.code, 'ENROLLMENT_ALREADY_EXISTS')
         const grant = await api(port, 'POST', modules, session, { moduleId, expiresAt: future(10) })
         assert.equal(grant.response.status, 201)
         const again = await api(port, 'POST', modules, session, { moduleId, expiresAt: null })
         assert.equal(again.response.status, 409)
         assert.equal(again.body.error.code, 'MODULE_ACCESS_ALREADY_EXISTS')
      })

      await t.test('lists enrollments with the student phone', async () => {
         const listed = await api(port, 'GET', enrollments, session)
         assert.equal(listed.response.status, 200)
         const row = listed.body.data.enrollments.find((item) => item.userId === studentId)
         assert.deepEqual(row.user, { firstName: 'Student', lastName: 'Reinstate', phone })
      })

      await t.test('filters user candidates by non-revoked course enrollment', async () => {
         const listed = await api(port, 'GET', candidates, session)
         assert.equal(listed.response.status, 200)
         const ids = listed.body.data.users.map((user) => user.id)
         assert.ok(!ids.includes(studentId))
         assert.ok(ids.includes(otherStudentId))
         assert.equal(listed.body.data.pagination.total, ids.length)
         for (const query of ['notEnrolledInCourse=abc', 'notEnrolledInCourse=-1', 'notEnrolledInCourse=0']) {
            const malformed = await api(port, 'GET', `/api/v1/admin/users?${query}`, session)
            assert.equal(malformed.response.status, 400)
            assert.equal(malformed.body.error.code, 'VALIDATION_ERROR')
         }
      })

      await t.test('reinstates a revoked enrollment while module grants stay revoked', async () => {
         const revoked = await api(port, 'POST', `${enrollments}/${studentId}/revoke`, session)
         assert.equal(revoked.body.data.state, 'revoked')
         const listed = await api(port, 'GET', candidates, session)
         assert.ok(listed.body.data.users.some((user) => user.id === studentId))

         const beginsAt = future(1)
         const expiresAt = future(60)
         const reinstated = await api(port, 'POST', enrollments, session, { userId: studentId, beginsAt, expiresAt })
         assert.equal(reinstated.response.status, 201)
         assert.equal(reinstated.body.data.state, 'scheduled')
         assert.equal(reinstated.body.data.beginsAt, beginsAt)
         assert.equal(reinstated.body.data.expiresAt, expiresAt)
         assert.equal(reinstated.body.data.revokedAt, null)
         assert.equal(reinstated.body.data.revokedBy, null)
         const audit = await client.query(
            "SELECT 1 FROM audit_events WHERE event_code = 'course.enrollment.regranted' AND subject_user_id = $1",
            [studentId],
         )
         assert.equal(audit.rowCount, 1)

         const grants = await api(port, 'GET', modules, session)
         assert.equal(grants.body.data.moduleGrants.length, 1)
         assert.equal(grants.body.data.moduleGrants[0].state, 'revoked')
      })

      await t.test('reinstates a revoked module grant with new dates', async () => {
         const expiresAt = future(20)
         const regranted = await api(port, 'POST', modules, session, { moduleId, expiresAt })
         assert.equal(regranted.response.status, 201)
         assert.equal(regranted.body.data.expiresAt, expiresAt)
         assert.equal(regranted.body.data.revokedAt, null)
         const audit = await client.query(
            "SELECT 1 FROM audit_events WHERE event_code = 'course.module_access.regranted' AND subject_user_id = $1",
            [studentId],
         )
         assert.equal(audit.rowCount, 1)
      })
   } finally {
      await cleanup(client)
      await client.end()
      await new Promise((resolve) => server.close(resolve))
   }
})
