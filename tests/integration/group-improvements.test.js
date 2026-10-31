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
   jwtAccessSecret: 'group-improvements-integration-secret-longer-than-32-chars',
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
       VALUES ($1, $2, 'GroupsApi')`,
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
      requestContext: { userAgent: 'groups api integration', ipAddress: '127.0.0.1' },
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

async function listen(app) {
   return new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
   })
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

test('group API improvements integration', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   const app = createApp({ authProtection: { config }, telegramAuth: { config } })
   const server = await listen(app)
   const port = server.address().port
   const stamp = Date.now()

   try {
      const adminId = await createUser(client, 'admin', 'Admin')
      const studentId = await createUser(client, 'student', 'Student')
      const otherStudentId = await createUser(client, 'student', 'Other')
      const teacherId = await createUser(client, 'teacher', 'Teacher')
      const plainTeacherId = await createUser(client, 'teacher', 'Plain')
      const sessions = {
         admin: await issue(adminId),
         student: await issue(studentId),
         teacher: await issue(teacherId),
         plainTeacher: await issue(plainTeacherId),
      }
      const create = async (body, session = sessions.admin, port_ = port) => {
         const result = await api(port_, 'POST', '/api/v1/admin/groups', session, body)
         if (result.response.status === 201) groupIds.push(result.body.data.id)
         return result
      }

      let groupId
      await t.test('generates a transliterated code when code is omitted and returns counts', async () => {
         const created = await create({ name: `Гурӯҳи Ҷавонон ${stamp}` })
         assert.equal(created.response.status, 201)
         assert.match(created.body.data.code, new RegExp(`^guruhi-javonon-${stamp}-[a-f0-9]{6}$`))
         assert.equal(created.body.data.memberCount, 0)
         assert.equal(created.body.data.teacherCount, 0)
         groupId = created.body.data.id
         const symbols = await create({ name: '!!! ###' })
         assert.match(symbols.body.data.code, /^group-[a-f0-9]{6}$/)
         const long = await create({ name: 'x'.repeat(200) })
         assert.equal(long.body.data.code.length, 80)
      })

      await t.test('retries a generated code collision inside the transaction', async () => {
         const suffixes = ['aaaaaa', 'aaaaaa', 'bbbbbb']
         const retryApp = createApp({
            authProtection: { config },
            telegramAuth: { config },
            groups: { codeSuffix: () => suffixes.shift() },
         })
         const retryServer = await listen(retryApp)
         try {
            const retryPort = retryServer.address().port
            const name = `Retry ${stamp}`
            const first = await create({ name }, sessions.admin, retryPort)
            assert.equal(first.body.data.code, `retry-${stamp}-aaaaaa`)
            const second = await create({ name }, sessions.admin, retryPort)
            assert.equal(second.response.status, 201)
            assert.equal(second.body.data.code, `retry-${stamp}-bbbbbb`)
         } finally {
            await new Promise((resolve) => retryServer.close(resolve))
         }
      })

      await t.test('keeps the 409 contract for an explicit duplicate code', async () => {
         const code = `explicit-${stamp}`
         const first = await create({ code, name: 'Explicit' })
         assert.equal(first.response.status, 201)
         assert.equal(first.body.data.code, code)
         const duplicate = await create({ code: code.toUpperCase(), name: 'Explicit Again' })
         assert.equal(duplicate.response.status, 409)
         assert.equal(duplicate.body.error.code, 'GROUP_CODE_CONFLICT')
         const patched = await api(port, 'PATCH', `/api/v1/admin/groups/${groupId}`, sessions.admin, { code })
         assert.equal(patched.response.status, 409)
         assert.equal(patched.body.error.code, 'GROUP_CODE_CONFLICT')
      })

      await t.test('edits the member representative flag with permission, CSRF and 404', async () => {
         const added = await api(port, 'POST', `/api/v1/admin/groups/${groupId}/members`, sessions.admin, { userId: studentId })
         assert.equal(added.response.status, 201)
         const path = `/api/v1/admin/groups/${groupId}/members/${studentId}`
         const denied = await api(port, 'PATCH', path, sessions.teacher, { isRepresentative: true })
         assert.equal(denied.response.status, 403)
         assert.equal(denied.body.error.code, 'ACTION_FORBIDDEN')
         const csrf = await api(port, 'PATCH', path, sessions.admin, { isRepresentative: true }, true, false)
         assert.equal(csrf.response.status, 403)
         assert.equal(csrf.body.error.code, 'CSRF_TOKEN_INVALID')
         const invalid = await api(port, 'PATCH', path, sessions.admin, {})
         assert.equal(invalid.response.status, 400)
         const updated = await api(port, 'PATCH', path, sessions.admin, { isRepresentative: true }, true)
         assert.equal(updated.response.status, 200)
         assert.equal(updated.body.data.id, studentId)
         assert.equal(updated.body.data.role, 'representative')
         assert.equal(updated.body.data.firstName, 'Student')
         assert.equal(updated.body.data.status, 'active')
         const missing = await api(port, 'PATCH', `/api/v1/admin/groups/${groupId}/members/${otherStudentId}`, sessions.admin, { isRepresentative: true })
         assert.equal(missing.response.status, 404)
         assert.equal(missing.body.error.code, 'GROUP_MEMBER_NOT_FOUND')
      })

      await t.test('edits teacher permissions with permission, CSRF and 404', async () => {
         const assigned = await api(port, 'POST', `/api/v1/admin/groups/${groupId}/teachers`, sessions.admin, { userId: teacherId })
         assert.equal(assigned.response.status, 201)
         const path = `/api/v1/admin/groups/${groupId}/teachers/${teacherId}`
         const denied = await api(port, 'PATCH', path, sessions.student, { canViewResults: true })
         assert.equal(denied.response.status, 403)
         const csrf = await api(port, 'PATCH', path, sessions.admin, { canViewResults: true }, true, false)
         assert.equal(csrf.body.error.code, 'CSRF_TOKEN_INVALID')
         const empty = await api(port, 'PATCH', path, sessions.admin, {})
         assert.equal(empty.response.status, 400)
         const updated = await api(port, 'PATCH', path, sessions.admin, { canPublishAnnouncements: true, canViewResults: true }, true)
         assert.equal(updated.response.status, 200)
         assert.equal(updated.body.data.id, teacherId)
         assert.equal(updated.body.data.role, 'teacher')
         assert.deepEqual(updated.body.data.permissions, {
            publishAnnouncements: true,
            assignTests: false,
            viewResults: true,
         })
         const missing = await api(port, 'PATCH', `/api/v1/admin/groups/${groupId}/teachers/${plainTeacherId}`, sessions.admin, { canAssignTests: true })
         assert.equal(missing.response.status, 404)
         assert.equal(missing.body.error.code, 'GROUP_TEACHER_NOT_FOUND')
         const audits = await client.query(
            `SELECT event_code FROM audit_events
             WHERE event_code IN ('group.member.updated', 'group.teacher.updated') AND actor_user_id = $1`,
            [adminId],
         )
         assert.equal(audits.rowCount, 2)
      })

      await t.test('returns counts on update', async () => {
         const updated = await api(port, 'PATCH', `/api/v1/admin/groups/${groupId}`, sessions.admin, { description: 'Counts' })
         assert.equal(updated.response.status, 200)
         assert.equal(updated.body.data.memberCount, 1)
         assert.equal(updated.body.data.teacherCount, 1)
      })

      await t.test('filters account candidates by group membership and teaching', async () => {
         const base = `/api/v1/admin/users?q=GroupsApi&limit=100`
         const all = await api(port, 'GET', base, sessions.admin)
         assert.ok(all.body.data.users.some((user) => user.id === studentId))
         const notMembers = await api(port, 'GET', `${base}&role=student&notInGroup=${groupId}`, sessions.admin)
         assert.equal(notMembers.response.status, 200)
         const memberIds = notMembers.body.data.users.map((user) => user.id)
         assert.ok(!memberIds.includes(studentId))
         assert.ok(memberIds.includes(otherStudentId))
         assert.equal(notMembers.body.data.pagination.total, memberIds.length)
         const notTeachers = await api(port, 'GET', `${base}&role=teacher&notTeacherOfGroup=${groupId}`, sessions.admin)
         const teacherIds = notTeachers.body.data.users.map((user) => user.id)
         assert.ok(!teacherIds.includes(teacherId))
         assert.ok(teacherIds.includes(plainTeacherId))
         for (const query of ['notInGroup=abc', 'notTeacherOfGroup=-1', 'notInGroup=0']) {
            const malformed = await api(port, 'GET', `/api/v1/admin/users?${query}`, sessions.admin)
            assert.equal(malformed.response.status, 400)
            assert.equal(malformed.body.error.code, 'VALIDATION_ERROR')
         }
      })

      await t.test('filters announcements by status for staff only', async () => {
         const base = `/api/v1/groups/${groupId}/announcements`
         const make = async (title, status) => {
            const created = await api(port, 'POST', base, sessions.admin, { title, content: title, status })
            assert.equal(created.response.status, 201)
            return created.body.data.id
         }
         await make('Published', 'published')
         await make('Draft', 'draft')
         const archivedId = await make('To archive', 'published')
         const archived = await api(port, 'DELETE', `${base}/${archivedId}`, sessions.admin)
         assert.equal(archived.body.data.status, 'archived')
         const titles = (result) => result.body.data.announcements.map((item) => item.title).sort()

         const staffDefault = await api(port, 'GET', base, sessions.admin)
         assert.deepEqual(titles(staffDefault), ['Draft', 'Published'])
         const staffArchived = await api(port, 'GET', `${base}?status=archived`, sessions.admin)
         assert.deepEqual(titles(staffArchived), ['To archive'])
         const teacherArchived = await api(port, 'GET', `${base}?status=archived`, sessions.teacher)
         assert.deepEqual(titles(teacherArchived), ['To archive'])

         const studentDefault = await api(port, 'GET', base, sessions.student)
         assert.deepEqual(titles(studentDefault), ['Published'])
         for (const status of ['archived', 'draft']) {
            const hidden = await api(port, 'GET', `${base}?status=${status}`, sessions.student)
            assert.equal(hidden.response.status, 200)
            assert.deepEqual(hidden.body.data.announcements, [])
         }
         const studentPublished = await api(port, 'GET', `${base}?status=published`, sessions.student)
         assert.deepEqual(titles(studentPublished), ['Published'])
         const invalid = await api(port, 'GET', `${base}?status=deleted`, sessions.admin)
         assert.equal(invalid.response.status, 400)
      })

      await t.test('rejects composition changes and new announcements in an archived group', async () => {
         const archived = await api(port, 'PATCH', `/api/v1/admin/groups/${groupId}`, sessions.admin, { status: 'archived' })
         assert.equal(archived.body.data.status, 'archived')
         const attempts = [
            ['POST', `/api/v1/admin/groups/${groupId}/members`, { userId: otherStudentId }],
            ['DELETE', `/api/v1/admin/groups/${groupId}/members/${studentId}`],
            ['PATCH', `/api/v1/admin/groups/${groupId}/members/${studentId}`, { isRepresentative: false }],
            ['POST', `/api/v1/admin/groups/${groupId}/teachers`, { userId: plainTeacherId }],
            ['DELETE', `/api/v1/admin/groups/${groupId}/teachers/${teacherId}`],
            ['PATCH', `/api/v1/admin/groups/${groupId}/teachers/${teacherId}`, { canAssignTests: true }],
            ['POST', `/api/v1/groups/${groupId}/announcements`, { title: 'No', content: 'No' }],
         ]
         for (const [method, path, body] of attempts) {
            const result = await api(port, method, path, sessions.admin, body)
            assert.equal(result.response.status, 409, `${method} ${path}`)
            assert.equal(result.body.error.code, 'GROUP_ARCHIVED')
         }
         const members = await api(port, 'GET', `/api/v1/groups/${groupId}/members`, sessions.admin)
         assert.equal(members.response.status, 200)
         assert.equal(members.body.data.members.length, 1)
         const restored = await api(port, 'PATCH', `/api/v1/admin/groups/${groupId}`, sessions.admin, { status: 'active' })
         assert.equal(restored.body.data.status, 'active')
         const added = await api(port, 'POST', `/api/v1/admin/groups/${groupId}/members`, sessions.admin, { userId: otherStudentId })
         assert.equal(added.response.status, 201)
      })

      await t.test('filters the group list by status and name with a total', async () => {
         const prefix = `Filter_${stamp}`
         const activeA = await create({ name: `${prefix} Alpha` })
         await create({ name: `${prefix} Beta` })
         await create({ name: `${prefix} Gamma`, status: 'archived' })
         await create({ name: `Other%_${stamp}` })
         const search = encodeURIComponent(prefix.toLowerCase())

         const all = await api(port, 'GET', `/api/v1/groups?q=${search}`, sessions.admin)
         assert.equal(all.response.status, 200)
         assert.equal(all.body.data.pagination.total, 3)
         const active = await api(port, 'GET', `/api/v1/groups?q=${search}&status=active&limit=1`, sessions.admin)
         assert.equal(active.body.data.groups.length, 1)
         assert.equal(active.body.data.groups[0].id, activeA.body.data.id)
         assert.equal(active.body.data.pagination.total, 2)
         assert.equal(active.body.data.pagination.hasMore, true)
         const archived = await api(port, 'GET', `/api/v1/groups?q=${search}&status=archived`, sessions.admin)
         assert.deepEqual(archived.body.data.groups.map((group) => group.name), [`${prefix} Gamma`])

         const wildcard = await api(port, 'GET', `/api/v1/groups?q=${encodeURIComponent('%_')}`, sessions.admin)
         assert.deepEqual(wildcard.body.data.groups.map((group) => group.name), [`Other%_${stamp}`])

         const student = await api(port, 'GET', `/api/v1/groups?q=${search}`, sessions.student)
         assert.equal(student.body.data.pagination.total, 0)

         for (const query of ['q=a', `q=${'a'.repeat(101)}`, 'status=deleted', 'sort=name']) {
            const invalid = await api(port, 'GET', `/api/v1/groups?${query}`, sessions.admin)
            assert.equal(invalid.response.status, 400, query)
            assert.equal(invalid.body.error.code, 'VALIDATION_ERROR')
         }
      })
   } finally {
      await cleanup(client)
      await client.end()
      await new Promise((resolve) => server.close(resolve))
   }
})
