import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import pg from 'pg'

import { createApp } from '../../src/app.js'
import env from '../../src/configs/env.js'
import { createAccessToken } from '../../src/services/auth/session-token-service.js'
import {
   blockUserService,
   replaceUserRolesService,
} from '../../src/services/account-admin-service.js'
import { createTelegramAuthTestService } from '../helpers/service-factories.js'

const { Client } = pg
const fixtureIds = []
const suffix = randomUUID().replaceAll('-', '').slice(0, 10)
const secret = 'admin-accounts-integration-secret-longer-than-32-chars'
const config = {
   ...env,
   jwtAccessSecret: secret,
   authAdminRateLimit: 1000,
   telegram: {
      clientId: 'test-client', clientSecret: 'test-client-secret', redirectUri: 'http://localhost/callback',
      botUsername: 'test_bot', botToken: 'test-token', webhookSecret: 'test-webhook-secret',
   },
}
let phoneCounter = 0

async function createUser(client, { status = 'active', roles = ['student'], firstName = 'Fixture', lastName = `M17${suffix}`, createdAt } = {}) {
   const user = await client.query(
      `INSERT INTO users (status, blocked_at, created_at)
       VALUES ($1::varchar, CASE WHEN $1::varchar = 'blocked' THEN CURRENT_TIMESTAMP END, COALESCE($2, CURRENT_TIMESTAMP))
       RETURNING id`,
      [status, createdAt ?? null],
   )
   const userId = user.rows[0].id
   fixtureIds.push(userId)
   phoneCounter += 1
   await client.query(
      'INSERT INTO user_profiles (user_id, first_name, last_name) VALUES ($1, $2, $3)',
      [userId, firstName, lastName],
   )
   await client.query(
      'INSERT INTO user_phones (user_id, phone_e164) VALUES ($1, $2)',
      [userId, `+99288${String(Date.now()).slice(-5)}${String(phoneCounter).padStart(2, '0')}`],
   )
   await client.query(
      'INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = ANY($2::text[])',
      [userId, roles],
   )
   return userId
}

async function issueToken(client, userId) {
   const expiresAt = new Date(Date.now() + 600000)
   const session = await client.query(
      'INSERT INTO auth_sessions (user_id, expires_at) VALUES ($1, $2) RETURNING id',
      [userId, expiresAt],
   )
   await client.query(
      'INSERT INTO auth_refresh_tokens (session_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [session.rows[0].id, `admin-accounts-${session.rows[0].id}`, expiresAt],
   )
   return createAccessToken({ userId, sessionId: session.rows[0].id, expiresAt }, secret)
}

async function cleanup(client) {
   if (!fixtureIds.length) return
   await client.query('DELETE FROM audit_events WHERE subject_user_id = ANY($1::bigint[]) OR actor_user_id = ANY($1::bigint[])', [fixtureIds])
   await client.query('DELETE FROM auth_refresh_tokens WHERE session_id IN (SELECT id FROM auth_sessions WHERE user_id = ANY($1::bigint[]))', [fixtureIds])
   await client.query('DELETE FROM auth_sessions WHERE user_id = ANY($1::bigint[])', [fixtureIds])
   await client.query('DELETE FROM auth_identities WHERE user_id = ANY($1::bigint[])', [fixtureIds])
   await client.query('DELETE FROM user_roles WHERE user_id = ANY($1::bigint[]) OR assigned_by = ANY($1::bigint[])', [fixtureIds])
   await client.query('DELETE FROM user_phones WHERE user_id = ANY($1::bigint[])', [fixtureIds])
   await client.query('DELETE FROM user_profiles WHERE user_id = ANY($1::bigint[])', [fixtureIds])
   await client.query('UPDATE users SET approved_by = NULL, blocked_by = NULL WHERE id = ANY($1::bigint[])', [fixtureIds])
   await client.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [fixtureIds])
}

test('admin accounts: list, roles and owner protection (M17)', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   const app = createApp({ telegramAuth: createTelegramAuthTestService({ config }).dependencies, authProtection: { config } })
   const server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
   })
   const port = server.address().port

   async function api(path, { method = 'GET', token, body } = {}) {
      const headers = {}
      if (token) headers.authorization = `Bearer ${token}`
      if (body !== undefined) headers['content-type'] = 'application/json'
      const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
         method,
         headers,
         ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      return { status: response.status, body: await response.json() }
   }

   async function rolesOf(userId) {
      const result = await client.query(
         `SELECT role.code FROM user_roles AS membership JOIN roles AS role ON role.id = membership.role_id
          WHERE membership.user_id = $1 ORDER BY role.code`,
         [userId],
      )
      return result.rows.map((row) => row.code)
   }

   try {
      const ownerId = await createUser(client, { roles: ['owner', 'student'] })
      const secondOwnerId = await createUser(client, { roles: ['owner', 'student'] })
      const adminId = await createUser(client, { roles: ['admin', 'student'] })
      const otherAdminId = await createUser(client, { roles: ['admin', 'student'] })
      const teacherId = await createUser(client, { roles: ['teacher', 'student'] })
      const studentId = await createUser(client, { roles: ['student'] })
      const tokens = {
         owner: await issueToken(client, ownerId),
         admin: await issueToken(client, adminId),
         teacher: await issueToken(client, teacherId),
         student: await issueToken(client, studentId),
      }

      await t.test('permission matrix for the account list', async () => {
         assert.equal((await api('/admin/users')).status, 401)
         for (const role of ['teacher', 'student']) {
            const denied = await api('/admin/users', { token: tokens[role] })
            assert.equal(denied.status, 403)
            assert.equal(denied.body.error.code, 'ADMIN_ROLE_REQUIRED')
         }
         for (const role of ['owner', 'admin']) assert.equal((await api('/admin/users', { token: tokens[role] })).status, 200)
         const roleDenied = await api(`/admin/users/${studentId}/roles`, { method: 'PUT', token: tokens.teacher, body: { roles: ['student'] } })
         assert.equal(roleDenied.status, 403)
         assert.equal(roleDenied.body.error.code, 'ADMIN_ROLE_REQUIRED')
      })

      await t.test('list filters, searches, paginates with total and stable order', async () => {
         const base = Date.now() - 3600000
         const listed = []
         for (const [index, status] of ['active', 'blocked', 'pending'].entries()) {
            listed.push(await createUser(client, {
               status,
               firstName: `Listed${index}`,
               lastName: `Search${suffix}x`,
               createdAt: new Date(base + index * 1000),
            }))
         }
         // Same created_at: the id breaks the tie.
         const tie = await createUser(client, { firstName: 'Listed3', lastName: `Search${suffix}x`, createdAt: new Date(base + 2000) })
         await client.query(
            `INSERT INTO auth_identities (user_id, provider, issuer, provider_subject)
             VALUES ($1, 'telegram', 'https://oauth.telegram.org', $2)`,
            [listed[0], `subject-${suffix}`],
         )
         const search = `Search${suffix}`
         const all = await api(`/admin/users?q=${search}`, { token: tokens.admin })
         assert.equal(all.status, 200, JSON.stringify(all.body))
         assert.equal(all.body.data.pagination.total, 4)
         assert.deepEqual(all.body.data.users.map((user) => user.id), [tie, listed[2], listed[1], listed[0]])
         const oldest = await api(`/admin/users?q=${search}&sort=createdAt`, { token: tokens.admin })
         assert.deepEqual(oldest.body.data.users.map((user) => user.id), [listed[0], listed[1], listed[2], tie])
         const item = all.body.data.users.find((user) => user.id === listed[0])
         assert.deepEqual(Object.keys(item).sort(), [
            'createdAt', 'displayName', 'firstName', 'id', 'lastLoginAt', 'lastName', 'phone', 'roles', 'status', 'telegramLinked',
         ])
         assert.equal(item.displayName, `Listed0 Search${suffix}x`)
         assert.deepEqual(item.roles, ['student'])
         assert.equal(item.telegramLinked, true)
         assert.match(item.phone, /^\+\d+$/)
         assert.equal(typeof item.id, 'string')
         assert.ok(!JSON.stringify(all.body).includes('password'))

         const page = await api(`/admin/users?q=${search}&limit=2&offset=0`, { token: tokens.admin })
         assert.deepEqual(page.body.data.pagination, { limit: 2, offset: 0, hasMore: true, total: 4 })
         const last = await api(`/admin/users?q=${search}&limit=2&offset=2`, { token: tokens.admin })
         assert.deepEqual(last.body.data.pagination, { limit: 2, offset: 2, hasMore: false, total: 4 })
         const blocked = await api(`/admin/users?q=${search}&status=blocked`, { token: tokens.admin })
         assert.deepEqual(blocked.body.data.users.map((user) => user.id), [listed[1]])
         const owners = await api(`/admin/users?q=M17${suffix}&role=owner`, { token: tokens.admin })
         assert.deepEqual(owners.body.data.users.map((user) => user.id).sort(), [ownerId, secondOwnerId].sort())
         const byPhone = await api(`/admin/users?q=${encodeURIComponent(item.phone.slice(1))}`, { token: tokens.admin })
         assert.ok(byPhone.body.data.users.some((user) => user.id === listed[0]))
         const fullName = await api(`/admin/users?q=${encodeURIComponent(`Listed1 Search${suffix}`)}`, { token: tokens.admin })
         assert.deepEqual(fullName.body.data.users.map((user) => user.id), [listed[1]])
         // `_` and `%` are literal: "Search<suffix>_" must not match "Search<suffix>x".
         const literal = await api(`/admin/users?q=${encodeURIComponent(`${search}_`)}`, { token: tokens.admin })
         assert.equal(literal.body.data.pagination.total, 0)
         for (const query of ['q=a', `q=${'a'.repeat(101)}`, 'status=deleted', 'role=root', 'sort=name', 'extra=1', 'limit=101']) {
            const invalid = await api(`/admin/users?${query}`, { token: tokens.admin })
            assert.equal(invalid.status, 400, query)
            assert.equal(invalid.body.error.code, 'VALIDATION_ERROR')
         }
         const pending = await api('/admin/users/pending?limit=1', { token: tokens.admin })
         assert.equal(pending.status, 200)
         assert.equal(typeof pending.body.data.pagination.total, 'number')
         assert.ok(pending.body.data.pagination.total >= 1)
         assert.equal(pending.body.data.pagination.limit, 1)
      })

      await t.test('role change matrix', async () => {
         const put = (userId, roles, token) => api(`/admin/users/${userId}/roles`, { method: 'PUT', token, body: { roles } })
         const expectError = (response, status, code) => {
            assert.equal(response.status, status, JSON.stringify(response.body))
            assert.equal(response.body.error.code, code)
         }
         const target = await createUser(client, { roles: ['student'] })
         const granted = await put(target, ['student', 'teacher'], tokens.admin)
         assert.equal(granted.status, 200, JSON.stringify(granted.body))
         assert.equal(granted.body.data.changed, true)
         assert.deepEqual(granted.body.data.user.roles, ['student', 'teacher'])
         const again = await put(target, ['teacher', 'student'], tokens.admin)
         assert.equal(again.body.data.changed, false)
         assert.equal(again.body.data.revokedSessions, 0)
         const audits = await client.query(
            `SELECT actor_user_id, metadata FROM audit_events
             WHERE subject_user_id = $1 AND event_code = 'admin.account.roles_changed'`,
            [target],
         )
         assert.equal(audits.rows.length, 1)
         assert.equal(audits.rows[0].actor_user_id, adminId)
         assert.deepEqual(audits.rows[0].metadata.before, ['student'])
         assert.deepEqual(audits.rows[0].metadata.after, ['student', 'teacher'])

         expectError(await put(target, ['student', 'admin'], tokens.admin), 403, 'ROLE_ASSIGNMENT_FORBIDDEN')
         expectError(await put(target, ['student', 'owner'], tokens.admin), 403, 'ROLE_ASSIGNMENT_FORBIDDEN')
         expectError(await put(otherAdminId, ['student', 'admin', 'teacher'], tokens.admin), 403, 'ROLE_ASSIGNMENT_FORBIDDEN')
         expectError(await put(ownerId, ['student', 'owner', 'teacher'], tokens.admin), 403, 'ROLE_ASSIGNMENT_FORBIDDEN')
         expectError(await put(adminId, ['student'], tokens.admin), 409, 'SELF_ROLE_CHANGE_FORBIDDEN')
         expectError(await put(ownerId, ['student', 'owner', 'admin'], tokens.owner), 409, 'SELF_ROLE_CHANGE_FORBIDDEN')
         expectError(await put(target, ['student', 'root'], tokens.owner), 400, 'INVALID_ROLES')
         expectError(await put(target, [], tokens.owner), 400, 'INVALID_ROLES')
         expectError(await put(target, ['student', 'student'], tokens.owner), 400, 'INVALID_ROLES')
         expectError(await put(target, ['teacher'], tokens.owner), 422, 'STUDENT_ROLE_REQUIRED')
         expectError(await put('abc', ['student'], tokens.owner), 400, 'INVALID_USER_ID')
         expectError(await put('999999999999', ['student'], tokens.owner), 404, 'USER_NOT_FOUND')

         const promoted = await put(target, ['student', 'admin'], tokens.owner)
         assert.equal(promoted.status, 200)
         assert.deepEqual(await rolesOf(target), ['admin', 'student'])
         const demoted = await put(otherAdminId, ['student'], tokens.owner)
         assert.equal(demoted.status, 200)
         assert.deepEqual(await rolesOf(otherAdminId), ['student'])

         // The owner role is created only by bootstrap:owner: nobody grants it, owners included.
         expectError(await put(target, ['student', 'owner'], tokens.owner), 403, 'ROLE_ASSIGNMENT_FORBIDDEN')
         expectError(await put(target, ['student', 'admin', 'owner'], tokens.owner), 403, 'ROLE_ASSIGNMENT_FORBIDDEN')
         assert.deepEqual(await rolesOf(target), ['admin', 'student'])
         // Keeping owner on an existing owner is not a grant.
         const ownerKept = await put(secondOwnerId, ['student', 'owner', 'teacher'], tokens.owner)
         assert.equal(ownerKept.status, 200, JSON.stringify(ownerKept.body))
         assert.equal(ownerKept.body.data.changed, true)
         assert.deepEqual(await rolesOf(secondOwnerId), ['owner', 'student', 'teacher'])
         const ownerUnchanged = await put(secondOwnerId, ['teacher', 'owner', 'student'], tokens.owner)
         assert.equal(ownerUnchanged.status, 200)
         assert.equal(ownerUnchanged.body.data.changed, false)
         assert.equal((await put(secondOwnerId, ['student', 'owner'], tokens.owner)).status, 200)
         assert.deepEqual(await rolesOf(secondOwnerId), ['owner', 'student'])
      })

      await t.test('role change and block revoke the subject sessions', async () => {
         const subject = await createUser(client, { roles: ['student'] })
         const token = await issueToken(client, subject)
         assert.equal((await api('/profile', { token })).status, 200)
         const changed = await api(`/admin/users/${subject}/roles`, { method: 'PUT', token: tokens.owner, body: { roles: ['student', 'teacher'] } })
         assert.equal(changed.body.data.revokedSessions, 1)
         assert.equal((await api('/profile', { token })).status, 401)
         const sessions = await client.query(
            'SELECT revoke_reason FROM auth_sessions WHERE user_id = $1',
            [subject],
         )
         assert.deepEqual(sessions.rows.map((row) => row.revoke_reason), ['roles_changed'])
         const refresh = await client.query(
            `SELECT count(*)::integer AS live FROM auth_refresh_tokens AS token
             JOIN auth_sessions AS session ON session.id = token.session_id
             WHERE session.user_id = $1 AND token.revoked_at IS NULL`,
            [subject],
         )
         assert.equal(refresh.rows[0].live, 0)

         const fresh = await issueToken(client, subject)
         const blocked = await api(`/admin/users/${subject}/block`, { method: 'POST', token: tokens.admin })
         assert.equal(blocked.status, 200)
         assert.equal(blocked.body.data.revokedSessions, 1)
         assert.equal((await api('/profile', { token: fresh })).status, 401)
      })

      await t.test('owners are protected in status transitions', async () => {
         const blockedOwner = await api(`/admin/users/${secondOwnerId}/block`, { method: 'POST', token: tokens.admin })
         assert.equal(blockedOwner.status, 403)
         assert.equal(blockedOwner.body.error.code, 'OWNER_ACTION_FORBIDDEN')
         const pendingOwner = await createUser(client, { status: 'pending', roles: ['owner', 'student'] })
         const rejected = await api(`/admin/users/${pendingOwner}/reject`, { method: 'POST', token: tokens.admin })
         assert.equal(rejected.body.error.code, 'OWNER_ACTION_FORBIDDEN')
         const self = await api(`/admin/users/${ownerId}/block`, { method: 'POST', token: tokens.owner })
         assert.equal(self.body.error.code, 'SELF_BLOCK_FORBIDDEN')

         const byOwner = await api(`/admin/users/${secondOwnerId}/block`, { method: 'POST', token: tokens.owner })
         assert.equal(byOwner.status, 200, JSON.stringify(byOwner.body))
         const unblockByAdmin = await api(`/admin/users/${secondOwnerId}/unblock`, { method: 'POST', token: tokens.admin })
         assert.equal(unblockByAdmin.body.error.code, 'OWNER_ACTION_FORBIDDEN')
         const unblocked = await api(`/admin/users/${secondOwnerId}/unblock`, { method: 'POST', token: tokens.owner })
         assert.equal(unblocked.status, 200)
      })

      await t.test('the last active owner keeps owner access', async (subtest) => {
         const foreignOwners = await client.query(
            `SELECT count(DISTINCT account.id)::integer AS total FROM users AS account
             JOIN user_roles AS membership ON membership.user_id = account.id
             JOIN roles AS role ON role.id = membership.role_id
             WHERE role.code = 'owner' AND account.status = 'active' AND NOT (account.id = ANY($1::bigint[]))`,
            [fixtureIds],
         )
         if (foreignOwners.rows[0].total > 0) {
            subtest.skip('the database has other active owners; npm test runs this in a disposable database')
            return
         }
         // Only an active owner can reach these checks through the API, and then at least two
         // active owners exist. The guard is defensive; exercise it with a non-active owner actor.
         const lastOwner = await createUser(client, { roles: ['owner', 'student'] })
         const inactiveOwner = await createUser(client, { status: 'blocked', roles: ['owner', 'student'] })
         await client.query(
            `UPDATE users SET status = 'blocked', blocked_at = CURRENT_TIMESTAMP
             WHERE id = ANY($1::bigint[])`,
            [[ownerId, secondOwnerId]],
         )
         try {
            await assert.rejects(
               replaceUserRolesService(inactiveOwner, lastOwner, { roles: ['student'] }),
               { code: 'LAST_OWNER_PROTECTED' },
            )
            await assert.rejects(blockUserService(inactiveOwner, lastOwner), { code: 'LAST_OWNER_PROTECTED' })
            assert.deepEqual(await rolesOf(lastOwner), ['owner', 'student'])
         } finally {
            await client.query(
               `UPDATE users SET status = 'active', blocked_at = NULL WHERE id = ANY($1::bigint[])`,
               [[ownerId, secondOwnerId]],
            )
         }
      })

      await t.test('concurrent role changes are serialized', async () => {
         const ownerA = await createUser(client, { roles: ['owner', 'student'] })
         const ownerB = await createUser(client, { roles: ['owner', 'student'] })
         const results = await Promise.allSettled([
            replaceUserRolesService(ownerA, ownerB, { roles: ['student'] }),
            replaceUserRolesService(ownerB, ownerA, { roles: ['student'] }),
         ])
         assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
         assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'ROLE_ASSIGNMENT_FORBIDDEN')
         const remaining = [await rolesOf(ownerA), await rolesOf(ownerB)].filter((roles) => roles.includes('owner'))
         assert.equal(remaining.length, 1)

         const target = await createUser(client, { roles: ['student'] })
         const same = await Promise.all([
            replaceUserRolesService(ownerId, target, { roles: ['student', 'teacher'] }),
            replaceUserRolesService(ownerId, target, { roles: ['student', 'teacher'] }),
         ])
         assert.deepEqual(same.map((result) => result.changed).sort(), [false, true])
         const audits = await client.query(
            `SELECT count(*)::integer AS total FROM audit_events
             WHERE subject_user_id = $1 AND event_code = 'admin.account.roles_changed'`,
            [target],
         )
         assert.equal(audits.rows[0].total, 1)
      })
   } finally {
      await new Promise((resolve) => server.close(resolve))
      await cleanup(client)
      await client.end()
   }
})
