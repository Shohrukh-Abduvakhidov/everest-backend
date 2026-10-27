import assert from 'node:assert/strict'
import test from 'node:test'

import pg from 'pg'

import { createApp } from '../../src/app.js'
import env from '../../src/configs/env.js'
import { withTransaction } from '../../src/repositories/transaction-repository.js'
import { issueSessionService } from '../../src/services/auth/session-service.js'

const { Client } = pg
const userIds = []
const groupIds = []
const config = {
   ...env,
   jwtAccessSecret: 'group-admin-integration-secret-longer-than-32-characters',
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
       VALUES ($1, $2, 'M04B')`,
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
      requestContext: { userAgent: 'M04-B integration', ipAddress: '127.0.0.1' },
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
   await client.query("DELETE FROM audit_events WHERE event_code LIKE 'group.%' AND actor_user_id = ANY($1::bigint[])", [userIds])
   await client.query('DELETE FROM group_announcements WHERE group_id = ANY($1::bigint[])', [groupIds])
   await client.query('DELETE FROM group_teachers WHERE group_id = ANY($1::bigint[])', [groupIds])
   await client.query('DELETE FROM group_members WHERE group_id = ANY($1::bigint[])', [groupIds])
   await client.query('DELETE FROM groups WHERE id = ANY($1::bigint[])', [groupIds])
   await client.query('DELETE FROM auth_refresh_tokens WHERE session_id IN (SELECT id FROM auth_sessions WHERE user_id = ANY($1::bigint[]))', [userIds])
   await client.query('DELETE FROM auth_sessions WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM user_roles WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM user_profiles WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [userIds])
}

test('group administration and announcement integration', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   const app = createApp({ authProtection: { config }, telegramAuth: { config } })
   const server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
   })
   const port = server.address().port

   try {
      const adminId = await createUser(client, 'admin', 'Admin')
      const ownerId = await createUser(client, 'owner', 'Owner')
      const studentId = await createUser(client, 'student', 'Student')
      const otherStudentId = await createUser(client, 'student', 'Other Student')
      const teacherId = await createUser(client, 'teacher', 'Teacher')
      const unrelatedTeacherId = await createUser(client, 'teacher', 'Unrelated Teacher')
      const sessions = {
         admin: await issue(adminId),
         owner: await issue(ownerId),
         student: await issue(studentId),
         teacher: await issue(teacherId),
         unrelatedTeacher: await issue(unrelatedTeacherId),
      }
      const code = `m04b-${Date.now()}`

      await t.test('requires authentication, permission, and cookie CSRF', async () => {
         const anonymous = await api(port, 'POST', '/api/v1/admin/groups', null, { code, name: 'Group' })
         assert.equal(anonymous.response.status, 401)
         const denied = await api(port, 'POST', '/api/v1/admin/groups', sessions.student, { code, name: 'Group' })
         assert.equal(denied.response.status, 403)
         assert.equal(denied.body.error.code, 'ACTION_FORBIDDEN')
         const csrf = await api(port, 'POST', '/api/v1/admin/groups', sessions.admin, { code, name: 'Group' }, true, false)
         assert.equal(csrf.response.status, 403)
         assert.equal(csrf.body.error.code, 'CSRF_TOKEN_INVALID')
      })

      await t.test('creates and updates a group with validation and audit', async () => {
         const created = await api(port, 'POST', '/api/v1/admin/groups', sessions.admin, {
            code,
            name: 'M04-B Group',
            description: 'Administration test',
         })
         assert.equal(created.response.status, 201)
         assert.equal(typeof created.body.data.id, 'string')
         groupIds.push(created.body.data.id)
         const updated = await api(port, 'PATCH', `/api/v1/admin/groups/${created.body.data.id}`, sessions.owner, {
            name: 'M04-B Updated',
         })
         assert.equal(updated.response.status, 200)
         assert.equal(updated.body.data.name, 'M04-B Updated')
         const invalid = await api(port, 'PATCH', `/api/v1/admin/groups/${created.body.data.id}`, sessions.admin, { createdBy: studentId })
         assert.equal(invalid.response.status, 400)
      })

      await t.test('rolls back a group mutation when audit persistence fails', async () => {
         const rollbackCode = `${code}-rollback`
         const rollbackApp = createApp({
            authProtection: { config },
            telegramAuth: { config },
            groups: {
               auth: { appendAuditEvent: async () => { throw new Error('injected audit failure') } },
            },
         })
         const rollbackServer = await new Promise((resolve) => {
            const listener = rollbackApp.listen(0, '127.0.0.1', () => resolve(listener))
         })
         try {
            const result = await api(
               rollbackServer.address().port,
               'POST',
               '/api/v1/admin/groups',
               sessions.admin,
               { code: rollbackCode, name: 'Must Roll Back' },
            )
            assert.equal(result.response.status, 500)
            const persisted = await client.query('SELECT id FROM groups WHERE code = $1', [rollbackCode])
            assert.equal(persisted.rowCount, 0)
         } finally {
            await new Promise((resolve) => rollbackServer.close(resolve))
         }
      })

      await t.test('manages student membership with history, duplicate protection, and no grants', async () => {
         const groupId = groupIds[0]
         const add = () => api(port, 'POST', `/api/v1/admin/groups/${groupId}/members`, sessions.admin, { userId: studentId })
         const concurrent = await Promise.all([add(), add()])
         assert.deepEqual(concurrent.map(({ response }) => response.status).sort(), [201, 409])
         const wrongRole = await api(port, 'POST', `/api/v1/admin/groups/${groupId}/members`, sessions.admin, { userId: teacherId })
         assert.equal(wrongRole.body.error.code, 'GROUP_MEMBER_INELIGIBLE')
         const removed = await api(port, 'DELETE', `/api/v1/admin/groups/${groupId}/members/${studentId}`, sessions.admin)
         assert.equal(removed.body.data.status, 'removed')
         const reactivated = await add()
         assert.equal(reactivated.response.status, 201)
         const grants = await client.query(
            `SELECT
               (SELECT count(*)::int FROM course_enrollments WHERE user_id = $1) AS courses,
               (SELECT count(*)::int FROM module_access_grants WHERE user_id = $1) AS modules`,
            [studentId],
         )
         assert.deepEqual(grants.rows[0], { courses: 0, modules: 0 })
      })

      await t.test('assigns and removes eligible teachers with duplicate protection', async () => {
         const groupId = groupIds[0]
         const assigned = await api(port, 'POST', `/api/v1/admin/groups/${groupId}/teachers`, sessions.admin, {
            userId: teacherId,
            canPublishAnnouncements: true,
         })
         assert.equal(assigned.response.status, 201)
         assert.equal(assigned.body.data.permissions.publishAnnouncements, true)
         const duplicate = await api(port, 'POST', `/api/v1/admin/groups/${groupId}/teachers`, sessions.admin, { userId: teacherId })
         assert.equal(duplicate.body.error.code, 'GROUP_TEACHER_ALREADY_ASSIGNED')
         const wrongRole = await api(port, 'POST', `/api/v1/admin/groups/${groupId}/teachers`, sessions.admin, { userId: otherStudentId })
         assert.equal(wrongRole.body.error.code, 'GROUP_TEACHER_INELIGIBLE')
      })

      let announcementId
      await t.test('allows an assigned teacher to create and update a text announcement', async () => {
         const groupId = groupIds[0]
         const created = await api(port, 'POST', `/api/v1/groups/${groupId}/announcements`, sessions.teacher, {
            title: 'Notice',
            content: 'Class starts at nine.',
            status: 'draft',
            authorId: adminId,
         })
         assert.equal(created.response.status, 400)
         const valid = await api(port, 'POST', `/api/v1/groups/${groupId}/announcements`, sessions.teacher, {
            title: 'Notice', content: 'Class starts at nine.', status: 'draft',
         })
         assert.equal(valid.response.status, 201)
         announcementId = valid.body.data.id
         assert.equal(valid.body.data.authorId, teacherId)
         const updated = await api(port, 'PATCH', `/api/v1/groups/${groupId}/announcements/${announcementId}`, sessions.teacher, {
            content: 'Class starts at ten.', status: 'published', isPinned: true,
         })
         assert.equal(updated.body.data.content, 'Class starts at ten.')
         assert.equal(updated.body.data.authorId, teacherId)
      })

      await t.test('enforces announcement visibility and non-disclosing group access', async () => {
         const groupId = groupIds[0]
         const member = await api(port, 'GET', `/api/v1/groups/${groupId}/announcements`, sessions.student)
         assert.equal(member.response.status, 200)
         assert.equal(member.body.data.announcements.length, 1)
         const unrelated = await api(port, 'GET', `/api/v1/groups/${groupId}/announcements`, sessions.unrelatedTeacher)
         const missing = await api(port, 'GET', '/api/v1/groups/9223372036854775807/announcements', sessions.unrelatedTeacher)
         assert.equal(unrelated.response.status, 404)
         assert.equal(missing.response.status, 404)
         assert.deepEqual(unrelated.body, missing.body)
         const manageDenied = await api(port, 'POST', `/api/v1/groups/${groupId}/announcements`, sessions.unrelatedTeacher, {
            title: 'No', content: 'Not assigned', status: 'published',
         })
         assert.equal(manageDenied.response.status, 404)
         assert.equal(manageDenied.body.error.code, 'GROUP_NOT_FOUND')
      })

      await t.test('archives announcements and removes teacher assignments', async () => {
         const groupId = groupIds[0]
         const archived = await api(port, 'DELETE', `/api/v1/groups/${groupId}/announcements/${announcementId}`, sessions.teacher)
         assert.equal(archived.body.data.status, 'archived')
         const removed = await api(port, 'DELETE', `/api/v1/admin/groups/${groupId}/teachers/${teacherId}`, sessions.admin)
         assert.equal(removed.body.data.status, 'removed')
      })

      await t.test('records all successful mutations as audit events', async () => {
         const result = await client.query(
            "SELECT count(*)::int AS count FROM audit_events WHERE event_code LIKE 'group.%' AND actor_user_id = ANY($1::bigint[])",
            [userIds],
         )
         assert.ok(result.rows[0].count >= 8)
      })
   } finally {
      await cleanup(client)
      await client.end()
      await new Promise((resolve) => server.close(resolve))
   }
})
