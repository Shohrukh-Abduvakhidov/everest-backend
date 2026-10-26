import assert from 'node:assert/strict'
import test from 'node:test'

import pg from 'pg'

import { createApp } from '../../src/app.js'
import env from '../../src/configs/env.js'
import * as authRepository from '../../src/repositories/auth-repository.js'
import { withTransaction } from '../../src/repositories/transaction-repository.js'
import { issueSessionService } from '../../src/services/auth/session-service.js'
import { updateOwnProfileService } from '../../src/services/profile-service.js'

const { Client } = pg
const fixtureIds = []
const config = {
   ...env,
   jwtAccessSecret: 'profile-integration-secret-longer-than-32-characters',
   authSessionTtlSeconds: 900,
   authRefreshTtlSeconds: 86400,
}

async function createUser(client, { status = 'active', firstName = null, lastName = null } = {}) {
   const result = await client.query(
      `INSERT INTO users (status, blocked_at)
       VALUES ($1::varchar, CASE WHEN $1::varchar = 'blocked' THEN CURRENT_TIMESTAMP ELSE NULL END)
       RETURNING id`,
      [status],
   )
   const userId = result.rows[0].id
   fixtureIds.push(userId)
   await client.query(
      `INSERT INTO user_profiles (user_id, first_name, last_name)
       VALUES ($1, $2, $3)`,
      [userId, firstName, lastName],
   )
   await client.query(
      `INSERT INTO user_phones
         (user_id, phone_e164, is_primary, verified_at, verification_method)
       VALUES ($1, $2, TRUE, CURRENT_TIMESTAMP, 'admin_verified')`,
      [userId, `+992${String(userId).padStart(9, '0').slice(-9)}`],
   )
   await client.query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, id FROM roles WHERE code = 'student'`,
      [userId],
   )
   return userId
}

async function issue(userId) {
   return withTransaction((client) => issueSessionService(
      {
         userId,
         requestContext: { userAgent: 'M03 integration', ipAddress: '127.0.0.1' },
         client,
      },
      { config },
   ))
}

async function api(port, path, {
   method = 'GET',
   session,
   cookieAccess = false,
   csrfToken,
   body,
} = {}) {
   const headers = {}
   if (session && cookieAccess) headers.cookie = `everest_access=${session.accessToken}`
   if (session && !cookieAccess) headers.authorization = `Bearer ${session.accessToken}`
   if (cookieAccess) headers.origin = 'http://localhost:3000'
   if (csrfToken) headers['x-csrf-token'] = csrfToken
   if (body !== undefined) headers['content-type'] = 'application/json'
   const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
   })
   return { response, body: await response.json() }
}

async function cleanup(client) {
   if (!fixtureIds.length) return
   await client.query(
      `DELETE FROM audit_events
       WHERE actor_user_id = ANY($1::bigint[]) OR subject_user_id = ANY($1::bigint[])`,
      [fixtureIds],
   )
   await client.query(
      `DELETE FROM auth_refresh_tokens WHERE session_id IN (
         SELECT id FROM auth_sessions WHERE user_id = ANY($1::bigint[])
       )`,
      [fixtureIds],
   )
   await client.query('DELETE FROM auth_sessions WHERE user_id = ANY($1::bigint[])', [fixtureIds])
   await client.query('DELETE FROM user_roles WHERE user_id = ANY($1::bigint[])', [fixtureIds])
   await client.query('DELETE FROM user_phones WHERE user_id = ANY($1::bigint[])', [fixtureIds])
   await client.query('DELETE FROM user_profiles WHERE user_id = ANY($1::bigint[])', [fixtureIds])
   await client.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [fixtureIds])
}

test('own profile and onboarding integration', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   const app = createApp({
      authProtection: { config },
      profile: {},
      telegramAuth: { config },
   })
   const server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
   })
   const port = server.address().port

   try {
      const userId = await createUser(client)
      const otherUserId = await createUser(client, { firstName: 'Other', lastName: 'User' })
      const pendingId = await createUser(client, { status: 'pending', firstName: 'Pending', lastName: 'User' })
      const blockedId = await createUser(client, { status: 'blocked', firstName: 'Blocked', lastName: 'User' })
      const session = await issue(userId)
      const otherSession = await issue(otherUserId)
      const pendingSession = await issue(pendingId)
      const blockedSession = await issue(blockedId)

      await t.test('requires authentication and returns only the authenticated safe profile', async () => {
         const missing = await api(port, '/api/v1/profile')
         assert.equal(missing.response.status, 401)
         assert.equal(missing.body.error.code, 'AUTHENTICATION_REQUIRED')

         const result = await api(port, '/api/v1/profile', { session })
         assert.equal(result.response.status, 200)
         assert.equal(result.body.data.id, userId)
         assert.equal(typeof result.body.data.id, 'string')
         assert.notEqual(result.body.data.id, otherUserId)
         assert.deepEqual(result.body.data.roles, ['student'])
         assert.equal(result.body.data.preferredLanguage, 'ru')
         for (const forbidden of [
            'passwordHash', 'tokenHash', 'sessionToken', 'csrfTokenHash',
            'providerSecret', 'permissions', 'auditMetadata',
         ]) {
            assert.equal(Object.hasOwn(result.body.data, forbidden), false)
         }
      })

      await t.test('rejects unknown, read-only, invalid language, and invalid timezone fields', async () => {
         for (const [body, field] of [
            [{ unknown: true }, 'unknown'],
            [{ id: otherUserId }, 'id'],
            [{ phone: '+992900000000' }, 'phone'],
            [{ status: 'active' }, 'status'],
            [{ roles: ['owner'] }, 'roles'],
            [{ preferredLanguage: 'tg' }, 'preferredLanguage'],
            [{ timezone: 'Not/A_Timezone' }, 'timezone'],
         ]) {
            const result = await api(port, '/api/v1/profile', {
               method: 'PATCH', session, body,
            })
            assert.equal(result.response.status, 400)
            assert.equal(result.body.error.code, 'VALIDATION_ERROR')
            assert.equal(result.body.error.details[0].field, field)
         }
      })

      await t.test('requires CSRF for cookie mutations and applies valid partial updates', async () => {
         const missingCsrf = await api(port, '/api/v1/profile', {
            method: 'PATCH', session, cookieAccess: true, body: { firstName: 'Shohrukh' },
         })
         assert.equal(missingCsrf.response.status, 403)
         assert.equal(missingCsrf.body.error.code, 'CSRF_TOKEN_INVALID')

         const updated = await api(port, '/api/v1/profile', {
            method: 'PATCH',
            session,
            cookieAccess: true,
            csrfToken: session.csrfToken,
            body: { firstName: '  Shohrukh  ', preferredLanguage: 'tj', timezone: 'Asia/Dushanbe' },
         })
         assert.equal(updated.response.status, 200)
         assert.equal(updated.body.data.firstName, 'Shohrukh')
         assert.equal(updated.body.data.lastName, null)
         assert.equal(updated.body.data.preferredLanguage, 'tj')
         assert.equal(updated.body.data.id, userId)

         const cleared = await api(port, '/api/v1/profile', {
            method: 'PATCH', session: otherSession, body: { firstName: null },
         })
         assert.equal(cleared.response.status, 200)
         assert.equal(cleared.body.data.firstName, null)
         assert.equal(cleared.body.data.lastName, 'User')
      })

      await t.test('calculates onboarding state and rejects incomplete completion safely', async () => {
         const state = await api(port, '/api/v1/profile/onboarding', { session })
         assert.deepEqual(state.body.data.completedSteps, ['firstName'])
         assert.deepEqual(state.body.data.missingRequiredFields, ['lastName'])
         assert.equal(state.body.data.canComplete, false)

         const incomplete = await api(port, '/api/v1/profile/onboarding/complete', {
            method: 'POST', session,
         })
         assert.equal(incomplete.response.status, 409)
         assert.equal(incomplete.body.error.code, 'ONBOARDING_INCOMPLETE')
         assert.deepEqual(incomplete.body.error.details[0].values, ['lastName'])
      })

      await t.test('updates onboarding, completes once, audits, and is idempotent', async () => {
         const updated = await api(port, '/api/v1/profile/onboarding', {
            method: 'PATCH', session, body: { lastName: 'Abduvakhidov' },
         })
         assert.equal(updated.response.status, 200)
         assert.equal(updated.body.data.canComplete, true)

         const completed = await api(port, '/api/v1/profile/onboarding/complete', {
            method: 'POST', session,
         })
         assert.equal(completed.response.status, 200)
         assert.equal(completed.body.data.state, 'completed')
         assert.ok(completed.body.data.completedAt)

         const retried = await api(port, '/api/v1/profile/onboarding/complete', {
            method: 'POST', session,
         })
         assert.equal(retried.response.status, 200)
         assert.equal(retried.body.data.completedAt, completed.body.data.completedAt)

         const audits = await client.query(
            `SELECT event_code, count(*)::int AS count
             FROM audit_events WHERE subject_user_id = $1
             GROUP BY event_code`,
            [userId],
         )
         const counts = Object.fromEntries(audits.rows.map((row) => [row.event_code, row.count]))
         assert.equal(counts['profile.updated'], 1)
         assert.equal(counts['profile.onboarding.updated'], 1)
         assert.equal(counts['profile.onboarding.completed'], 1)
      })

      await t.test('does not allow pending or blocked sessions to complete onboarding', async () => {
         for (const inactiveSession of [pendingSession, blockedSession]) {
            const result = await api(port, '/api/v1/profile/onboarding/complete', {
               method: 'POST', session: inactiveSession,
            })
            assert.equal(result.response.status, 401)
            assert.equal(result.body.error.code, 'SESSION_INVALID')
         }
      })

      await t.test('rolls back profile changes when audit persistence fails', async () => {
         const before = await client.query(
            'SELECT first_name FROM user_profiles WHERE user_id = $1',
            [otherUserId],
         )
         await assert.rejects(
            updateOwnProfileService(
               otherUserId,
               { firstName: 'Rolled Back' },
               {
                  auth: {
                     ...authRepository,
                     appendAuditEvent: async () => { throw new Error('injected audit failure') },
                  },
               },
            ),
            /injected audit failure/,
         )
         const after = await client.query(
            'SELECT first_name FROM user_profiles WHERE user_id = $1',
            [otherUserId],
         )
         assert.equal(after.rows[0].first_name, before.rows[0].first_name)
      })
   } finally {
      await cleanup(client)
      await client.end()
      await new Promise((resolve) => server.close(resolve))
   }
})
