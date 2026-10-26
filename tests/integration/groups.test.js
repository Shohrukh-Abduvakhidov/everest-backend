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
   jwtAccessSecret: 'group-read-integration-secret-longer-than-32-characters',
   authSessionTtlSeconds: 900,
   authRefreshTtlSeconds: 86400,
}

async function createUser(client, role, name) {
   const result = await client.query(
      "INSERT INTO users (status) VALUES ('active') RETURNING id",
   )
   const userId = result.rows[0].id
   userIds.push(userId)
   await client.query(
      `INSERT INTO user_profiles (user_id, first_name, last_name)
       VALUES ($1, $2, 'Reader')`,
      [userId, name],
   )
   await client.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, id FROM roles WHERE code = $2`,
      [userId, role],
   )
   return userId
}

async function createGroup(client, createdBy, title, status = 'active') {
   const result = await client.query(
      `INSERT INTO groups (code, title, description, status, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [`m04a-${Date.now()}-${groupIds.length}`, title, `${title} description`, status, createdBy],
   )
   groupIds.push(result.rows[0].id)
   return result.rows[0].id
}

async function issue(userId) {
   return withTransaction((client) => issueSessionService(
      {
         userId,
         requestContext: { userAgent: 'M04-A integration', ipAddress: '127.0.0.1' },
         client,
      },
      { config },
   ))
}

async function api(port, path, session) {
   const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: session ? { authorization: `Bearer ${session.accessToken}` } : {},
   })
   return { response, body: await response.json() }
}

async function cleanup(client) {
   if (!userIds.length) return
   await client.query('DELETE FROM group_teachers WHERE group_id = ANY($1::bigint[])', [groupIds])
   await client.query('DELETE FROM group_members WHERE group_id = ANY($1::bigint[])', [groupIds])
   await client.query('DELETE FROM groups WHERE id = ANY($1::bigint[])', [groupIds])
   await client.query('DELETE FROM auth_identities WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM user_passwords WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query(
      `DELETE FROM auth_refresh_tokens WHERE session_id IN (
         SELECT id FROM auth_sessions WHERE user_id = ANY($1::bigint[])
       )`,
      [userIds],
   )
   await client.query('DELETE FROM auth_sessions WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM user_roles WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM user_profiles WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [userIds])
}

test('group read API integration', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   const app = createApp({ telegramAuth: { config } })
   const server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
   })
   const port = server.address().port

   try {
      const adminId = await createUser(client, 'admin', 'Admin')
      const ownerId = await createUser(client, 'owner', 'Owner')
      const studentId = await createUser(client, 'student', 'Student')
      const teacherId = await createUser(client, 'teacher', 'Teacher')
      const unrelatedStudentId = await createUser(client, 'student', 'Unrelated Student')
      const unrelatedTeacherId = await createUser(client, 'teacher', 'Unrelated Teacher')
      const memberId = await createUser(client, 'student', 'Member')

      const alphaId = await createGroup(client, adminId, 'Alpha Group')
      const betaId = await createGroup(client, adminId, 'Beta Group')
      const emptyId = await createGroup(client, adminId, 'Empty Group', 'archived')

      await client.query(
         `INSERT INTO group_members
            (group_id, user_id, status, is_representative, added_by)
          VALUES ($1, $2, 'active', FALSE, $3),
                 ($1, $4, 'active', TRUE, $3),
                 ($5, $2, 'left', FALSE, $3)`,
         [alphaId, studentId, adminId, memberId, betaId],
      )
      await client.query(
         `INSERT INTO group_teachers
            (group_id, user_id, can_publish_announcements, can_view_results, assigned_by)
          VALUES ($1, $2, TRUE, TRUE, $3)`,
         [betaId, teacherId, adminId],
      )
      await client.query(
         `INSERT INTO user_passwords (user_id, password_hash) VALUES ($1, 'private-hash')`,
         [memberId],
      )
      await client.query(
         `INSERT INTO auth_identities
            (user_id, provider, issuer, provider_subject, provider_profile)
          VALUES ($1, 'telegram', 'https://oauth.telegram.org', $2, '{"username":"private"}')`,
         [memberId, `m04a-${memberId}`],
      )

      const sessions = Object.fromEntries(await Promise.all([
         ['admin', adminId], ['owner', ownerId], ['student', studentId],
         ['teacher', teacherId], ['unrelatedStudent', unrelatedStudentId],
         ['unrelatedTeacher', unrelatedTeacherId],
      ].map(async ([key, userId]) => [key, await issue(userId)])))

      await t.test('requires authentication', async () => {
         const result = await api(port, '/api/v1/groups')
         assert.equal(result.response.status, 401)
         assert.equal(result.body.error.code, 'AUTHENTICATION_REQUIRED')
      })

      await t.test('students and teachers list only their current related groups', async () => {
         const student = await api(port, '/api/v1/groups', sessions.student)
         assert.deepEqual(student.body.data.groups.map(({ id }) => id), [alphaId])
         assert.deepEqual(student.body.data.groups[0].relationship, {
            member: true, representative: false, teacher: false, administrator: false,
         })

         const teacher = await api(port, '/api/v1/groups', sessions.teacher)
         assert.deepEqual(teacher.body.data.groups.map(({ id }) => id), [betaId])
         assert.equal(teacher.body.data.groups[0].relationship.teacher, true)

         assert.deepEqual(
            (await api(port, '/api/v1/groups', sessions.unrelatedStudent)).body.data.groups,
            [],
         )
         assert.deepEqual(
            (await api(port, '/api/v1/groups', sessions.unrelatedTeacher)).body.data.groups,
            [],
         )
      })

      await t.test('admin and owner see all groups with deterministic pagination', async () => {
         for (const session of [sessions.admin, sessions.owner]) {
            const first = await api(port, '/api/v1/groups?limit=2&offset=0', session)
            assert.equal(first.response.status, 200)
            assert.deepEqual(first.body.data.groups.map(({ name }) => name), [
               'Alpha Group', 'Beta Group',
            ])
            assert.equal(first.body.data.pagination.hasMore, true)
            const second = await api(port, '/api/v1/groups?limit=2&offset=2', session)
            assert.deepEqual(second.body.data.groups.map(({ name }) => name), ['Empty Group'])
            assert.equal(second.body.data.pagination.hasMore, false)
            assert.equal(first.body.data.groups[0].relationship.administrator, true)
         }
      })

      await t.test('returns safe detail without an embedded roster or course implication', async () => {
         const result = await api(port, `/api/v1/groups/${alphaId}`, sessions.student)
         assert.equal(result.response.status, 200)
         assert.equal(result.body.data.id, alphaId)
         assert.equal(typeof result.body.data.id, 'string')
         assert.equal(result.body.data.name, 'Alpha Group')
         assert.equal(result.body.data.memberCount, 2)
         assert.equal(result.body.data.teacherCount, 0)
         assert.equal(Object.hasOwn(result.body.data, 'members'), false)
         assert.equal(Object.hasOwn(result.body.data, 'courses'), false)
         assert.equal(Object.hasOwn(result.body.data, 'progress'), false)
         assert.equal(Object.hasOwn(result.body.data, 'ranking'), false)
      })

      await t.test('uses one response for missing and inaccessible groups', async () => {
         const inaccessible = await api(port, `/api/v1/groups/${betaId}`, sessions.student)
         const missing = await api(port, '/api/v1/groups/9223372036854775807', sessions.student)
         for (const result of [inaccessible, missing]) {
            assert.equal(result.response.status, 404)
            assert.equal(result.body.error.code, 'GROUP_NOT_FOUND')
            assert.equal(result.body.error.message, 'Group was not found')
         }
      })

      await t.test('rejects malformed, leading-zero, and overflow group IDs', async () => {
         for (const groupId of ['abc', '01', '9223372036854775808']) {
            const result = await api(port, `/api/v1/groups/${groupId}`, sessions.admin)
            assert.equal(result.response.status, 400)
            assert.equal(result.body.error.code, 'INVALID_GROUP_ID')
         }
      })

      await t.test('returns paginated safe active members', async () => {
         const first = await api(
            port,
            `/api/v1/groups/${alphaId}/members?limit=1&offset=0`,
            sessions.student,
         )
         assert.equal(first.response.status, 200)
         assert.equal(first.body.data.members.length, 1)
         assert.equal(first.body.data.pagination.hasMore, true)
         const second = await api(
            port,
            `/api/v1/groups/${alphaId}/members?limit=1&offset=1`,
            sessions.student,
         )
         assert.equal(second.body.data.members.length, 1)
         assert.equal(second.body.data.pagination.hasMore, false)
         const members = [...first.body.data.members, ...second.body.data.members]
         assert.ok(members.every(({ id }) => typeof id === 'string'))
         assert.ok(members.some(({ role }) => role === 'representative'))
         for (const member of members) {
            for (const forbidden of [
               'phone', 'passwordHash', 'session', 'tokenHash', 'telegram', 'recovery',
            ]) {
               assert.equal(Object.hasOwn(member, forbidden), false)
            }
         }
      })

      await t.test('returns safe teachers and denies unrelated teachers', async () => {
         const result = await api(port, `/api/v1/groups/${betaId}/teachers`, sessions.teacher)
         assert.equal(result.response.status, 200)
         assert.equal(result.body.data.teachers.length, 1)
         assert.equal(result.body.data.teachers[0].id, teacherId)
         assert.equal(result.body.data.teachers[0].role, 'teacher')
         assert.deepEqual(result.body.data.teachers[0].permissions, {
            publishAnnouncements: true, assignTests: false, viewResults: true,
         })
         assert.equal(Object.hasOwn(result.body.data.teachers[0], 'phone'), false)

         const denied = await api(
            port,
            `/api/v1/groups/${betaId}/teachers`,
            sessions.unrelatedTeacher,
         )
         assert.equal(denied.response.status, 404)
         assert.equal(denied.body.error.code, 'GROUP_NOT_FOUND')
      })

      await t.test('supports empty groups and validates list pagination', async () => {
         const members = await api(port, `/api/v1/groups/${emptyId}/members`, sessions.admin)
         const teachers = await api(port, `/api/v1/groups/${emptyId}/teachers`, sessions.owner)
         assert.deepEqual(members.body.data.members, [])
         assert.deepEqual(teachers.body.data.teachers, [])
         for (const query of ['limit=0', 'limit=101', 'offset=-1', 'limit=01']) {
            const invalid = await api(port, `/api/v1/groups?${query}`, sessions.admin)
            assert.equal(invalid.response.status, 400)
            assert.equal(invalid.body.error.code, 'VALIDATION_ERROR')
         }
      })

      await t.test('membership creates no course or module access', async () => {
         const result = await client.query(
            `SELECT
               (SELECT count(*)::int FROM course_enrollments WHERE user_id = $1) AS courses,
               (SELECT count(*)::int FROM module_access_grants WHERE user_id = $1) AS modules`,
            [studentId],
         )
         assert.deepEqual(result.rows[0], { courses: 0, modules: 0 })
      })
   } finally {
      await cleanup(client)
      await client.end()
      await new Promise((resolve) => server.close(resolve))
   }
})
