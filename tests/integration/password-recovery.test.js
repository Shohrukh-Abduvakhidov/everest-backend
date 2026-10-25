import assert from 'node:assert/strict'
import test from 'node:test'

import pg from 'pg'

import { createApp } from '../../src/app.js'
import env from '../../src/configs/env.js'
import * as authRepository from '../../src/repositories/auth-repository.js'
import { withTransaction } from '../../src/repositories/transaction-repository.js'
import { createSessionService } from '../../src/services/auth/session-service.js'
import { createPasswordAuthService } from '../../src/services/password-auth-service.js'
import { createPasswordRecoveryService } from '../../src/services/password-recovery-service.js'
import { createTelegramAuthService } from '../../src/services/telegram-auth-service.js'
import { hashPassword, verifyPassword } from '../../src/utils/password.js'
import { hashOpaqueToken } from '../../src/utils/recovery-token.js'

const { Client } = pg
const fixtureIds = []
const secret = 'password-recovery-integration-secret-longer-than-32-characters'
const config = {
  ...env,
  jwtAccessSecret: 'password-recovery-jwt-secret-longer-than-32-characters',
  otpHmacSecret: secret,
  authSessionTtlSeconds: 900,
  authRefreshTtlSeconds: 86400,
  recoveryChallengeTtlSeconds: 600,
  recoveryResetTtlSeconds: 600,
  recoveryResendCooldownSeconds: 60,
  recoveryMaxAttempts: 5,
  recoveryMaxRequestsPerHour: 20,
  telegram: {
    clientId: 'recovery-test-bot', clientSecret: 'test-secret',
    redirectUri: 'http://localhost/callback', botUsername: 'test_bot',
    botToken: 'test-token', webhookSecret: 'test-webhook',
  },
}

class RecoveryProviderDouble {
  constructor(available = true) {
    this.available = available
    this.deliveries = []
  }

  isAvailable() { return this.available }

  async sendRecoveryCode(target, code) {
    this.deliveries.push({ target, code })
    return { delivered: true }
  }
}

async function createUser(client, suffix, { linked = true, status = 'active' } = {}) {
  const password = `Original-password-${suffix}`
  const phone = `+99291${String(suffix).padStart(7, '0')}`
  const user = await client.query(
    `INSERT INTO users (status, blocked_at)
     VALUES ($1::varchar, CASE WHEN $1::varchar = 'blocked' THEN CURRENT_TIMESTAMP ELSE NULL END)
     RETURNING id`,
    [status]
  )
  const userId = user.rows[0].id
  fixtureIds.push(userId)
  const phoneRow = await client.query(
    'INSERT INTO user_phones (user_id, phone_e164) VALUES ($1, $2) RETURNING id',
    [userId, phone]
  )
  await client.query(
    'INSERT INTO user_passwords (user_id, password_hash) VALUES ($1, $2)',
    [userId, await hashPassword(password)]
  )
  await client.query(
    `INSERT INTO user_roles (user_id, role_id)
     SELECT $1, id FROM roles WHERE code = 'student'`,
    [userId]
  )
  if (linked) {
    await client.query(
      `INSERT INTO auth_identities (user_id, provider, issuer, provider_subject)
       VALUES ($1, 'telegram', 'https://oauth.telegram.org', $2)`,
      [userId, `recovery-${suffix}`]
    )
    await client.query(
      `INSERT INTO telegram_connections (user_id, bot_id, chat_id, status)
       VALUES ($1, $2, $3, 'active')`,
      [userId, config.telegram.clientId, String(8000000 + suffix)]
    )
  }
  return { password, phone, phoneId: phoneRow.rows[0].id, userId }
}

async function api(port, path, body, { accessToken, refreshToken, method = 'POST' } = {}) {
  const cookies = []
  if (refreshToken) cookies.push(`everest_refresh=${encodeURIComponent(refreshToken)}`)
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(cookies.length ? { cookie: cookies.join('; ') } : {}),
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  })
  return { response, body: await response.json() }
}

async function cleanup(client) {
  if (!fixtureIds.length) return
  await client.query('DELETE FROM audit_events WHERE actor_user_id = ANY($1::bigint[]) OR subject_user_id = ANY($1::bigint[])', [fixtureIds])
  await client.query('DELETE FROM auth_challenges WHERE user_id = ANY($1::bigint[])', [fixtureIds])
  await client.query('DELETE FROM auth_refresh_tokens WHERE session_id IN (SELECT id FROM auth_sessions WHERE user_id = ANY($1::bigint[]))', [fixtureIds])
  await client.query('DELETE FROM auth_sessions WHERE user_id = ANY($1::bigint[])', [fixtureIds])
  await client.query('DELETE FROM telegram_connections WHERE user_id = ANY($1::bigint[])', [fixtureIds])
  await client.query('DELETE FROM auth_identities WHERE user_id = ANY($1::bigint[])', [fixtureIds])
  await client.query('DELETE FROM user_roles WHERE user_id = ANY($1::bigint[])', [fixtureIds])
  await client.query('DELETE FROM user_passwords WHERE user_id = ANY($1::bigint[])', [fixtureIds])
  await client.query('DELETE FROM user_phones WHERE user_id = ANY($1::bigint[])', [fixtureIds])
  await client.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [fixtureIds])
}

test('password recovery integration', async (t) => {
  const client = new Client(env.database)
  await client.connect()
  const telegram = new RecoveryProviderDouble()
  const sms = new RecoveryProviderDouble(false)
  const recovery = createPasswordRecoveryService({ config, telegramProvider: telegram, smsProvider: sms })
  const authService = createTelegramAuthService({ config })
  const passwordService = createPasswordAuthService({ config })
  const app = createApp(authService, passwordService, undefined, undefined, recovery)
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  const port = server.address().port
  const account = await createUser(client, 101)
  const unlinked = await createUser(client, 102, { linked: false })
  const rejected = await createUser(client, 103, { status: 'rejected' })
  const blocked = await createUser(client, 104, { status: 'blocked' })

  async function requestCode(target = account, channel = 'telegram') {
    const before = telegram.deliveries.length
    const result = await api(port, '/api/v1/auth/password-recovery/request', {
      phone: target.phone, channel,
    })
    return { ...result, delivery: telegram.deliveries[before] }
  }

  async function allowResend(userId = account.userId) {
    await client.query(
      `UPDATE auth_challenges SET created_at = created_at - INTERVAL '2 minutes'
       WHERE user_id = $1`,
      [userId]
    )
  }

  async function createResetAuthorization() {
    await allowResend()
    const requested = await requestCode()
    assert.ok(requested.delivery)
    const verified = await api(port, '/api/v1/auth/password-recovery/verify', {
      challengeId: requested.body.data.challengeId, code: requested.delivery.code,
    })
    assert.equal(verified.response.status, 200)
    return { requested, resetAuthorization: verified.body.data.resetAuthorization }
  }

  try {
    await t.test('returns indistinguishable accepted responses without account or channel leakage', async () => {
      const existing = await requestCode()
      const unknown = await api(port, '/api/v1/auth/password-recovery/request', {
        phone: '+992919999999', channel: 'telegram',
      })
      const unavailable = await api(port, '/api/v1/auth/password-recovery/request', {
        phone: unlinked.phone, channel: 'telegram',
      })
      const rejectedResult = await api(port, '/api/v1/auth/password-recovery/request', {
        phone: rejected.phone, channel: 'telegram',
      })
      const smsDisabled = await api(port, '/api/v1/auth/password-recovery/request', {
        phone: account.phone, channel: 'sms',
      })
      for (const result of [existing, unknown, unavailable, rejectedResult, smsDisabled]) {
        assert.equal(result.response.status, 202)
        assert.equal(result.body.data.status, 'accepted')
        assert.match(result.body.data.challengeId, /^[A-Za-z0-9_-]{43}$/)
      }
      assert.equal(sms.deliveries.length, 0)
    })

    await t.test('normalizes E.164, stores only hashes, enforces cooldown, and supports provider doubles', async () => {
      await allowResend()
      const before = telegram.deliveries.length
      const requested = await api(port, '/api/v1/auth/password-recovery/request', {
        phone: account.phone.replace('+992', '+992 '), channel: 'telegram',
      })
      assert.equal(telegram.deliveries.length, before + 1)
      const delivery = telegram.deliveries.at(-1)
      const stored = await client.query(
        `SELECT public_id_hash, secret_hash FROM auth_challenges
         WHERE public_id_hash = $1`,
        [hashOpaqueToken(requested.body.data.challengeId)]
      )
      assert.equal(stored.rowCount, 1)
      assert.notEqual(stored.rows[0].public_id_hash, requested.body.data.challengeId)
      assert.equal(stored.rows[0].secret_hash.includes(delivery.code), false)
      assert.equal(JSON.stringify(requested.body).includes(delivery.code), false)
      const second = await requestCode()
      assert.equal(second.response.status, 202)
      assert.equal(second.delivery, undefined)

      const enabledSms = new RecoveryProviderDouble(true)
      const smsRecovery = createPasswordRecoveryService({
        config, telegramProvider: telegram, smsProvider: enabledSms,
      })
      await smsRecovery.request({ phone: account.phone, channel: 'sms' })
      assert.equal(enabledSms.deliveries.length, 1)
    })

    await t.test('enforces expiry, failed-attempt limit, single use, and concurrent verification', async () => {
      await allowResend()
      const expired = await requestCode()
      await client.query(
        `UPDATE auth_challenges
         SET created_at = CURRENT_TIMESTAMP - INTERVAL '2 days',
           expires_at = CURRENT_TIMESTAMP - INTERVAL '1 day'
         WHERE public_id_hash = $1`,
        [hashOpaqueToken(expired.body.data.challengeId)]
      )
      assert.equal((await api(port, '/api/v1/auth/password-recovery/verify', {
        challengeId: expired.body.data.challengeId, code: expired.delivery.code,
      })).response.status, 401)

      await allowResend()
      const limited = await requestCode()
      const wrongCode = limited.delivery.code === '000000' ? '000001' : '000000'
      for (let attempt = 0; attempt < config.recoveryMaxAttempts; attempt += 1) {
        const wrong = await api(port, '/api/v1/auth/password-recovery/verify', {
          challengeId: limited.body.data.challengeId, code: wrongCode,
        })
        assert.equal(wrong.response.status, 401)
      }
      assert.equal((await api(port, '/api/v1/auth/password-recovery/verify', {
        challengeId: limited.body.data.challengeId, code: limited.delivery.code,
      })).response.status, 401)

      await allowResend()
      const concurrent = await requestCode()
      const results = await Promise.all([
        api(port, '/api/v1/auth/password-recovery/verify', {
          challengeId: concurrent.body.data.challengeId, code: concurrent.delivery.code,
        }),
        api(port, '/api/v1/auth/password-recovery/verify', {
          challengeId: concurrent.body.data.challengeId, code: concurrent.delivery.code,
        }),
      ])
      assert.deepEqual(results.map(({ response }) => response.status).sort(), [200, 401])
      const resetAuthorization = results.find(({ response }) => response.status === 200).body.data.resetAuthorization
      const stored = await client.query(
        'SELECT reset_token_hash FROM auth_challenges WHERE public_id_hash = $1',
        [hashOpaqueToken(concurrent.body.data.challengeId)]
      )
      assert.notEqual(stored.rows[0].reset_token_hash, resetAuthorization)
      assert.equal(stored.rows[0].reset_token_hash, hashOpaqueToken(resetAuthorization))
    })

    await t.test('rejects weak, expired, reused, and concurrently reused reset authorizations', async () => {
      const weak = await createResetAuthorization()
      const weakResult = await api(port, '/api/v1/auth/password-recovery/reset', {
        resetAuthorization: weak.resetAuthorization, newPassword: 'weak',
      })
      assert.equal(weakResult.response.status, 400)

      const expired = await createResetAuthorization()
      await client.query(
        `UPDATE auth_challenges SET reset_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
         WHERE reset_token_hash = $1`,
        [hashOpaqueToken(expired.resetAuthorization)]
      )
      assert.equal((await api(port, '/api/v1/auth/password-recovery/reset', {
        resetAuthorization: expired.resetAuthorization, newPassword: 'Valid-new-password-22',
      })).response.status, 401)

      const concurrent = await createResetAuthorization()
      const results = await Promise.all([
        api(port, '/api/v1/auth/password-recovery/reset', {
          resetAuthorization: concurrent.resetAuthorization, newPassword: 'Concurrent-password-31',
        }),
        api(port, '/api/v1/auth/password-recovery/reset', {
          resetAuthorization: concurrent.resetAuthorization, newPassword: 'Concurrent-password-31',
        }),
      ])
      assert.deepEqual(results.map(({ response }) => response.status).sort(), [200, 401])
      assert.equal((await api(port, '/api/v1/auth/password-recovery/reset', {
        resetAuthorization: concurrent.resetAuthorization, newPassword: 'Another-password-32',
      })).response.status, 401)
    })

    await t.test('resets atomically, revokes all sessions, and preserves identity, role, and status', async () => {
      const currentPassword = 'Concurrent-password-31'
      const sessionService = createSessionService({ config })
      const first = await withTransaction((db) => sessionService.issueSession({
        userId: account.userId, requestContext: {}, client: db,
      }))
      await withTransaction((db) => sessionService.issueSession({
        userId: account.userId, requestContext: {}, client: db,
      }))
      const authorization = await createResetAuthorization()
      const newPassword = 'Final-secure-password-42'
      const reset = await api(port, '/api/v1/auth/password-recovery/reset', {
        resetAuthorization: authorization.resetAuthorization, newPassword,
      })
      assert.equal(reset.response.status, 200)
      assert.deepEqual(reset.body, { data: { status: 'password_reset' } })

      const state = await client.query(
        `SELECT account.status, credential.password_hash,
           (SELECT count(*)::int FROM user_roles WHERE user_id = account.id) AS roles,
           (SELECT count(*)::int FROM auth_identities WHERE user_id = account.id AND provider = 'telegram') AS identities,
           (SELECT count(*)::int FROM auth_sessions WHERE user_id = account.id AND revoked_at IS NULL) AS live_sessions,
           (SELECT count(*)::int FROM auth_refresh_tokens AS token JOIN auth_sessions AS session
             ON session.id = token.session_id WHERE session.user_id = account.id AND token.revoked_at IS NULL) AS live_refresh
         FROM users AS account JOIN user_passwords AS credential ON credential.user_id = account.id
         WHERE account.id = $1`,
        [account.userId]
      )
      assert.equal(state.rows[0].status, 'active')
      assert.equal(state.rows[0].roles, 1)
      assert.equal(state.rows[0].identities, 1)
      assert.equal(state.rows[0].live_sessions, 0)
      assert.equal(state.rows[0].live_refresh, 0)
      assert.equal(await verifyPassword(newPassword, state.rows[0].password_hash), true)
      assert.equal(await verifyPassword(currentPassword, state.rows[0].password_hash), false)
      assert.equal((await api(port, '/api/v1/auth/sessions', {}, {
        accessToken: first.accessToken, method: 'GET',
      })).response.status, 401)
      assert.equal((await api(port, '/api/v1/auth/refresh', {}, { refreshToken: first.refreshToken })).response.status, 401)
      assert.equal((await api(port, '/api/v1/auth/login/password', {
        phone: account.phone, password: currentPassword,
      })).response.status, 401)
      assert.equal((await api(port, '/api/v1/auth/login/password', {
        phone: account.phone, password: newPassword,
      })).response.status, 200)
      const audit = await client.query(
        `SELECT count(*)::int AS count FROM audit_events
         WHERE subject_user_id = $1 AND event_code = 'auth.password_recovery.completed'`,
        [account.userId]
      )
      assert.ok(audit.rows[0].count > 0)
    })

    await t.test('allows blocked-account credential reset without unblocking the account', async () => {
      const before = telegram.deliveries.length
      const requested = await api(port, '/api/v1/auth/password-recovery/request', {
        phone: blocked.phone, channel: 'telegram',
      })
      const delivery = telegram.deliveries[before]
      const verified = await api(port, '/api/v1/auth/password-recovery/verify', {
        challengeId: requested.body.data.challengeId, code: delivery.code,
      })
      const reset = await api(port, '/api/v1/auth/password-recovery/reset', {
        resetAuthorization: verified.body.data.resetAuthorization,
        newPassword: 'Blocked-new-password-77',
      })
      assert.equal(reset.response.status, 200)
      const status = await client.query('SELECT status FROM users WHERE id = $1', [blocked.userId])
      assert.equal(status.rows[0].status, 'blocked')
      const login = await api(port, '/api/v1/auth/login/password', {
        phone: blocked.phone, password: 'Blocked-new-password-77',
      })
      assert.equal(login.response.status, 403)
    })

    await t.test('rolls back password, authorization, sessions, and audit-dependent reset changes', async () => {
      const authorization = await createResetAuthorization()
      const before = await client.query(
        'SELECT password_hash FROM user_passwords WHERE user_id = $1', [account.userId]
      )
      const sessionService = createSessionService({ config })
      const session = await withTransaction((db) => sessionService.issueSession({
        userId: account.userId, requestContext: {}, client: db,
      }))
      const failing = createPasswordRecoveryService({
        config,
        telegramProvider: telegram,
        smsProvider: sms,
        auth: {
          ...authRepository,
          appendAuditEvent: async () => { throw new Error('injected recovery audit failure') },
        },
      })
      await assert.rejects(failing.reset({
        resetAuthorization: authorization.resetAuthorization,
        newPassword: 'Rollback-password-55',
      }), /injected recovery audit failure/)
      const after = await client.query(
        `SELECT credential.password_hash, challenge.reset_consumed_at, session.revoked_at
         FROM user_passwords AS credential
         JOIN auth_challenges AS challenge ON challenge.reset_token_hash = $2
         JOIN auth_sessions AS session ON session.id = $3
         WHERE credential.user_id = $1`,
        [account.userId, hashOpaqueToken(authorization.resetAuthorization), session.sessionId]
      )
      assert.equal(after.rows[0].password_hash, before.rows[0].password_hash)
      assert.equal(after.rows[0].reset_consumed_at, null)
      assert.equal(after.rows[0].revoked_at, null)
    })
  } finally {
    await cleanup(client)
    await client.end()
    await new Promise((resolve) => server.close(resolve))
  }
})
