import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import pg from 'pg'

import { createApp } from '../../src/app.js'
import env from '../../src/configs/env.js'
import { TelegramRateLimiter } from '../../src/jobs/telegram-rate-limiter.js'
import { withTransaction } from '../../src/repositories/transaction-repository.js'
import { issueSessionService } from '../../src/services/auth/session-service.js'
import { runNotificationFanoutService } from '../../src/services/notification-service.js'
import {
   blockTelegramConnectionService,
   sendTelegramBatchService,
} from '../../src/services/telegram-delivery-service.js'
import { unlinkTelegramService } from '../../src/services/telegram-auth-service.js'
import AppError from '../../src/utils/app-error.js'

const { Client } = pg
const suffix = randomUUID().slice(0, 8)
const botToken = `mock-bot-token-${suffix}-secret`
const config = {
   ...env,
   appUrl: 'https://app.example.test',
   jwtAccessSecret: 'telegram-delivery-integration-secret-longer-than-32',
   authSessionTtlSeconds: 900,
   authRefreshTtlSeconds: 86400,
   telegram: {
      ...env.telegram,
      clientId: `delivery-bot-${suffix}`,
      clientSecret: 'delivery-client-secret-long-enough',
      redirectUri: 'https://example.test/api/v1/auth/telegram/callback',
      botUsername: 'everest_delivery_test_bot',
      botToken,
      webhookSecret: 'mock-webhook-secret',
   },
}

function telegramFailure(fields) {
   return Object.assign(new AppError(502, 'TELEGRAM_MESSAGE_FAILED', 'Telegram test message could not be delivered'), {
      telegramAccessUnavailable: false, ...fields,
   })
}

// Telegram double: records every call; respond(chatId, callIndex) returns a result or throws.
class FakeBot {
   calls = []
   respond = () => ({ messageId: String(1000 + this.calls.length) })
   async sendMessage(chatId, text) {
      this.calls.push({ chatId, text })
      return this.respond(chatId, this.calls.length)
   }
}

test('M14 PR 2: Telegram delivery, limits, failures, settings', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   t.after(() => client.end())

   let chatSeed = 8_100_000_000 + (Date.now() % 100_000_000)
   // quiet: 'off' (saved settings without quiet hours, so results do not depend on the time of
   // day), 'default' (no settings row: 22:00–08:00 applies).
   async function createUser({
      connected = true, identity = true, timezone = 'UTC', language = 'ru', connection = 'active', quiet = 'off',
   } = {}) {
      const { rows } = await client.query(
         `INSERT INTO users (status, onboarding_completed_at) VALUES ('active', CURRENT_TIMESTAMP) RETURNING id`,
      )
      const userId = rows[0].id
      await client.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2', [userId, 'student'])
      await client.query('INSERT INTO user_passwords (user_id, password_hash) VALUES ($1, $2)', [userId, 'test-hash'])
      await client.query(
         'INSERT INTO user_profiles (user_id, first_name, language_code, timezone) VALUES ($1, $2, $3, $4)',
         [userId, 'Delivery', language, timezone],
      )
      if (quiet === 'off') {
         await client.query('INSERT INTO notification_settings (user_id, quiet_start, quiet_end) VALUES ($1, NULL, NULL)', [userId])
      }
      if (identity) {
         await client.query(
            `INSERT INTO auth_identities (user_id, provider, issuer, provider_subject)
             VALUES ($1, 'telegram', 'https://oauth.telegram.org', $2)`,
            [userId, `delivery-${suffix}-${userId}`],
         )
      }
      let chatId = null
      if (connected) {
         chatSeed += 1
         chatId = String(chatSeed)
         await client.query(
            `INSERT INTO telegram_connections (user_id, bot_id, chat_id, status, blocked_at)
             VALUES ($1, $2, $3::bigint, $4::varchar, CASE WHEN $4::varchar = 'blocked' THEN CURRENT_TIMESTAMP END)`,
            [userId, config.telegram.clientId, chatId, connection],
         )
      }
      return { userId, chatId }
   }

   let auditSeed = 900_000_000
   const notify = (userId) => runNotificationFanoutService(
      { event: 'account.approved', userId: String(userId), auditId: String((auditSeed += 1)) },
      { config },
   )
   async function deliveries(userId) {
      const { rows } = await client.query(
         `SELECT delivery.id, delivery.status, delivery.attempt_count, delivery.last_error_code,
             delivery.provider_message_id, delivery.next_attempt_at,
             EXTRACT(EPOCH FROM (delivery.next_attempt_at - CURRENT_TIMESTAMP)) AS wait_seconds
          FROM notification_deliveries AS delivery
          JOIN notifications AS notification ON notification.id = delivery.notification_id
          WHERE notification.user_id = $1 ORDER BY delivery.id`,
         [userId],
      )
      return rows
   }
   const makeDue = (userId) => client.query(
      `UPDATE notification_deliveries SET next_attempt_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
       WHERE status = 'pending' AND notification_id IN (SELECT id FROM notifications WHERE user_id = $1)`,
      [userId],
   )

   const logs = []
   const clockState = { current: Date.now() }
   const limiterSleeps = []
   const limiter = () => new TelegramRateLimiter({
      perSecond: 20,
      perChatIntervalMs: 1000,
      now: () => clockState.current,
      sleep: async (ms) => { limiterSleeps.push(ms); clockState.current += ms },
   })
   async function send(bot, sharedLimiter = limiter()) {
      let total = 0
      for (;;) {
         const claimed = await sendTelegramBatchService({ limiter: sharedLimiter, batchSize: 50, leaseSeconds: 60 }, {
            config, botProvider: bot, log: (message, details) => logs.push(JSON.stringify({ message, details })),
         })
         if (!claimed) return total
         total += claimed
      }
   }

   // Nothing from other suites should be waiting for this bot.
   await send(new FakeBot())

   await t.test('who gets a Telegram copy: connection, identity, switches, in-app-only events', async () => {
      const connected = await createUser()
      const switchedOff = await createUser()
      await client.query('UPDATE notification_settings SET telegram_enabled = FALSE WHERE user_id = $1', [switchedOff.userId])
      const eventOff = await createUser()
      await client.query(
         `INSERT INTO notification_preferences (user_id, event_code, channel, enabled)
          VALUES ($1, 'account.approved', 'telegram', FALSE)`,
         [eventOff.userId],
      )
      const blocked = await createUser({ connection: 'blocked' })
      const noIdentity = await createUser({ identity: false })
      const notConnected = await createUser({ connected: false })
      for (const user of [connected, switchedOff, eventOff, blocked, noIdentity, notConnected]) {
         const result = await notify(user.userId)
         assert.equal(result.created, 1)
      }
      const [row] = await deliveries(connected.userId)
      assert.equal(row.status, 'pending')
      assert.equal(row.attempt_count, 0)
      assert.ok(Number(row.wait_seconds) <= 1)
      for (const user of [switchedOff, eventOff, blocked, noIdentity, notConnected]) {
         assert.deepEqual(await deliveries(user.userId), [], String(user.userId))
      }
      // Running the same event again adds no second delivery.
      const again = await notify(connected.userId)
      assert.equal(again.telegram, 1, 'a new audit id is a new event')
      assert.equal((await deliveries(connected.userId)).length, 2)
      // Clean slate for the next subtests.
      await send(new FakeBot())
   })

   await t.test('200: sent with the APP_URL link as plain text and the message id stored', async () => {
      const user = await createUser({ language: 'en' })
      await notify(user.userId)
      const bot = new FakeBot()
      assert.equal(await send(bot), 1)
      assert.deepEqual(bot.calls, [{
         chatId: user.chatId,
         text: 'Account approved\n\nYour EVEREST account is approved. You can sign in.\n\nhttps://app.example.test/',
      }])
      const [row] = await deliveries(user.userId)
      assert.equal(row.status, 'sent')
      assert.equal(row.provider_message_id, '1001')
      assert.equal(row.attempt_count, 1)
      assert.equal(await send(bot), 0, 'a sent delivery is not sent again')
      assert.equal(bot.calls.length, 1)
   })

   await t.test('200 recipients: 20 per second overall, 1 per second per chat (fake clock)', async () => {
      const { rows } = await client.query(
         `INSERT INTO users (status, onboarding_completed_at)
          SELECT 'active', CURRENT_TIMESTAMP FROM generate_series(1, 200) RETURNING id`,
      )
      const ids = rows.map((row) => row.id)
      await client.query(
         `INSERT INTO user_profiles (user_id, timezone) SELECT id, 'UTC' FROM unnest($1::bigint[]) AS id`, [ids],
      )
      await client.query(
         `INSERT INTO auth_identities (user_id, provider, issuer, provider_subject)
          SELECT id, 'telegram', 'https://oauth.telegram.org', $2::text || id::text FROM unnest($1::bigint[]) AS id`,
         [ids, `bulk-${suffix}-`],
      )
      await client.query(
         `INSERT INTO telegram_connections (user_id, bot_id, chat_id)
          SELECT id, $2::text, $3::bigint + row_number() OVER () FROM unnest($1::bigint[]) AS id`,
         [ids, config.telegram.clientId, String(chatSeed + 10_000)],
      )
      // Nobody is in quiet hours in this subtest.
      await client.query(
         `INSERT INTO notification_settings (user_id, quiet_start, quiet_end)
          SELECT id, NULL, NULL FROM unnest($1::bigint[]) AS id`, [ids],
      )
      const author = await createUser()
      const groupId = (await client.query(
         `INSERT INTO groups (code, title, created_by) VALUES ($1, 'Bulk', $2) RETURNING id`,
         [`td-${suffix}`, author.userId],
      )).rows[0].id
      await client.query(
         'INSERT INTO group_members (group_id, user_id, added_by) SELECT $1, id, $2 FROM unnest($3::bigint[]) AS id',
         [groupId, author.userId, ids],
      )
      const announcementId = (await client.query(
         `INSERT INTO group_announcements (group_id, author_id, title, status, published_at)
          VALUES ($1, $2, 'Bulk news', 'published', CURRENT_TIMESTAMP) RETURNING id`,
         [groupId, author.userId],
      )).rows[0].id
      const result = await runNotificationFanoutService({ event: 'group.announcement', announcementId: String(announcementId) }, { config })
      assert.deepEqual(result, { created: 200, telegram: 200 })

      const sendTimes = []
      const bot = new FakeBot()
      bot.respond = (chatId) => {
         sendTimes.push({ chatId, at: clockState.current })
         return { messageId: '1' }
      }
      const startedAt = clockState.current
      assert.equal(await send(bot), 200)
      assert.equal(bot.calls.length, 200)
      assert.equal(new Set(bot.calls.map((call) => call.chatId)).size, 200)
      assert.ok(clockState.current - startedAt >= 199 * 50, 'at least 9.95 s of (fake) time')
      for (let index = 0; index + 20 < sendTimes.length; index += 1) {
         assert.ok(sendTimes[index + 20].at - sendTimes[index].at >= 1000, 'never more than 20 in one second')
      }
      const sent = await client.query(
         `SELECT count(*)::integer AS count FROM notification_deliveries AS delivery
          JOIN notifications AS notification ON notification.id = delivery.notification_id
          WHERE notification.user_id = ANY($1::bigint[]) AND delivery.status = 'sent'`,
         [ids],
      )
      assert.equal(sent.rows[0].count, 200)

      // Three messages for one chat are a second apart.
      const busy = await createUser()
      for (let index = 0; index < 3; index += 1) await notify(busy.userId)
      const busyTimes = []
      const busyBot = new FakeBot()
      busyBot.respond = () => { busyTimes.push(clockState.current); return { messageId: '1' } }
      await send(busyBot)
      assert.equal(busyTimes.length, 3)
      assert.ok(busyTimes[1] - busyTimes[0] >= 1000 && busyTimes[2] - busyTimes[1] >= 1000)
   })

   await t.test('429: everything waits retry_after, no attempt is used, then it is sent', async () => {
      const first = await createUser()
      const second = await createUser()
      await notify(first.userId)
      await notify(second.userId)
      const bot = new FakeBot()
      bot.respond = () => { throw telegramFailure({ telegramStatus: 429, retryAfter: 7 }) }
      const sharedLimiter = limiter()
      const pausedFrom = clockState.current
      await send(bot, sharedLimiter)
      assert.equal(bot.calls.length, 1, 'the rest of the batch is not tried during the pause')
      for (const user of [first, second]) {
         const [row] = await deliveries(user.userId)
         assert.equal(row.status, 'pending')
         assert.equal(row.attempt_count, 0)
         assert.equal(row.last_error_code, 'TELEGRAM_RATE_LIMITED')
         assert.ok(Number(row.wait_seconds) > 5 && Number(row.wait_seconds) <= 7.5, String(row.wait_seconds))
      }
      assert.equal(sharedLimiter.pausedUntil, pausedFrom + 7000)
      await makeDue(first.userId)
      await makeDue(second.userId)
      bot.respond = () => ({ messageId: '9' })
      await send(bot, sharedLimiter)
      assert.equal((await deliveries(first.userId))[0].status, 'sent')
      assert.equal((await deliveries(second.userId))[0].status, 'sent')
   })

   await t.test('403: delivery failed, connection blocked, the rest cancelled, one in-app notice', async () => {
      const user = await createUser({ language: 'en' })
      for (let index = 0; index < 3; index += 1) await notify(user.userId)
      const bot = new FakeBot()
      bot.respond = () => { throw telegramFailure({ telegramStatus: 403, telegramAccessUnavailable: true }) }
      await send(bot)
      assert.equal(bot.calls.length, 1, 'the other deliveries to this chat are not tried')
      const rows = await deliveries(user.userId)
      assert.deepEqual(rows.map((row) => [row.status, row.last_error_code]), [
         ['failed', 'BOT_BLOCKED'], ['cancelled', 'BOT_BLOCKED'], ['cancelled', 'BOT_BLOCKED'],
      ])
      const connection = await client.query('SELECT status, blocked_at FROM telegram_connections WHERE user_id = $1', [user.userId])
      assert.equal(connection.rows[0].status, 'blocked')
      assert.ok(connection.rows[0].blocked_at)
      const notices = await client.query(
         `SELECT title, body, target_path FROM notifications WHERE user_id = $1 AND event_code = 'telegram.disconnected'`,
         [user.userId],
      )
      assert.deepEqual(notices.rows, [{
         title: 'Telegram disconnected',
         body: "The bot can't message you on Telegram. Reconnect it in your profile.",
         target_path: '/profile',
      }])
      // A second report of the same block writes nothing; the notice has no Telegram copy.
      const connectionId = (await client.query('SELECT id FROM telegram_connections WHERE user_id = $1', [user.userId])).rows[0].id
      assert.deepEqual(await blockTelegramConnectionService(connectionId), { blocked: false, cancelled: 0 })
      assert.equal((await client.query(
         "SELECT count(*)::integer AS count FROM notifications WHERE user_id = $1 AND event_code = 'telegram.disconnected'",
         [user.userId],
      )).rows[0].count, 1)
      assert.equal((await deliveries(user.userId)).length, 3)
      // New events are not queued for a blocked connection.
      await notify(user.userId)
      assert.equal((await deliveries(user.userId)).length, 3)
   })

   await t.test('5xx retries with backoff, then fails; no response is unknown and never resent', async () => {
      const flaky = await createUser()
      await notify(flaky.userId)
      const bot = new FakeBot()
      bot.respond = () => { throw telegramFailure({ telegramStatus: 502 }) }
      await send(bot)
      let [row] = await deliveries(flaky.userId)
      assert.deepEqual([row.status, row.attempt_count, row.last_error_code], ['pending', 1, 'TELEGRAM_UNAVAILABLE'])
      assert.ok(Number(row.wait_seconds) > 25 && Number(row.wait_seconds) <= 31, String(row.wait_seconds))
      await client.query('UPDATE notification_deliveries SET attempt_count = 4 WHERE id = $1', [row.id])
      await makeDue(flaky.userId)
      await send(bot)
      ;[row] = await deliveries(flaky.userId)
      assert.deepEqual([row.status, row.attempt_count, row.last_error_code], ['failed', 5, 'TELEGRAM_UNAVAILABLE'])

      const rejected = await createUser()
      await notify(rejected.userId)
      bot.respond = () => { throw telegramFailure({ telegramStatus: 400 }) }
      await send(bot)
      assert.deepEqual((await deliveries(rejected.userId)).map((item) => [item.status, item.last_error_code]), [['failed', 'TELEGRAM_REJECTED']])

      const silent = await createUser()
      await notify(silent.userId)
      bot.respond = () => { throw telegramFailure({ networkError: true }) }
      const callsBefore = bot.calls.length
      await send(bot)
      assert.equal(bot.calls.length, callsBefore + 1)
      ;[row] = await deliveries(silent.userId)
      assert.deepEqual([row.status, row.last_error_code], ['unknown', 'TELEGRAM_NO_RESPONSE'])
      bot.respond = () => ({ messageId: '1' })
      await send(bot)
      assert.equal(bot.calls.length, callsBefore + 1, 'unknown is never resent')
   })

   await t.test('a delivery stuck in sending after its lease becomes unknown and is not resent', async () => {
      const user = await createUser()
      await notify(user.userId)
      const [row] = await deliveries(user.userId)
      await client.query(
         `UPDATE notification_deliveries SET status = 'sending', attempt_count = 1,
             lease_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = $1`,
         [row.id],
      )
      const bot = new FakeBot()
      await send(bot)
      assert.equal(bot.calls.length, 0)
      const [after] = await deliveries(user.userId)
      assert.deepEqual([after.status, after.last_error_code], ['unknown', 'LEASE_EXPIRED'])
   })

   await t.test('quiet hours: queued until they end; checked again at send time without using an attempt', async () => {
      const now = new Date()
      const hhmm = (date) => date.toISOString().slice(11, 16)
      const quietStart = hhmm(new Date(now.getTime() - 3600000))
      const quietEnd = hhmm(new Date(now.getTime() + 3600000))

      const sleeper = await createUser({ timezone: 'UTC' })
      await client.query(
         'UPDATE notification_settings SET quiet_start = $2, quiet_end = $3 WHERE user_id = $1',
         [sleeper.userId, quietStart, quietEnd],
      )
      await notify(sleeper.userId)
      const [queued] = await deliveries(sleeper.userId)
      assert.equal(queued.status, 'pending')
      assert.ok(Number(queued.wait_seconds) > 3000 && Number(queued.wait_seconds) <= 3600, String(queued.wait_seconds))
      const bot = new FakeBot()
      await send(bot)
      assert.equal(bot.calls.length, 0, 'not due yet')

      // Already queued, then the user turns quiet hours on: the sender postpones it.
      const late = await createUser({ timezone: 'UTC' })
      await notify(late.userId)
      await client.query('UPDATE notification_settings SET quiet_start = $2, quiet_end = $3 WHERE user_id = $1', [late.userId, quietStart, quietEnd])
      await send(bot)
      assert.equal(bot.calls.length, 0)
      const [postponed] = await deliveries(late.userId)
      assert.deepEqual([postponed.status, postponed.attempt_count, postponed.last_error_code], ['pending', 0, 'QUIET_HOURS'])
      assert.ok(Number(postponed.wait_seconds) > 3000)

      // The default 22:00–08:00 applies in the profile time zone when nothing is saved.
      const dushanbe = await createUser({ timezone: 'Asia/Dushanbe', quiet: 'default' })
      await notify(dushanbe.userId)
      const [defaultRow] = await deliveries(dushanbe.userId)
      const localHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dushanbe', hour: '2-digit', hourCycle: 'h23' }).format(now))
      const inQuiet = localHour >= 22 || localHour < 8
      assert.equal(Number(defaultRow.wait_seconds) > 60, inQuiet)
      // Send whatever is due so the next subtest starts empty.
      await send(new FakeBot())
   })

   await t.test('switches, account state and unlink cancel queued deliveries', async () => {
      const off = await createUser()
      const eventOff = await createUser()
      const inactive = await createUser()
      const unlinker = await createUser()
      for (const user of [off, eventOff, inactive, unlinker]) await notify(user.userId)
      await client.query('UPDATE notification_settings SET telegram_enabled = FALSE WHERE user_id = $1', [off.userId])
      await client.query(
         `INSERT INTO notification_preferences (user_id, event_code, channel, enabled) VALUES ($1, 'account.approved', 'telegram', FALSE)`,
         [eventOff.userId],
      )
      await client.query("UPDATE users SET status = 'blocked', blocked_at = CURRENT_TIMESTAMP WHERE id = $1", [inactive.userId])
      const unlinked = await unlinkTelegramService(unlinker.userId, { config })
      assert.equal(unlinked.status, 'unlinked')
      assert.deepEqual((await deliveries(unlinker.userId)).map((row) => [row.status, row.last_error_code]), [['cancelled', 'TELEGRAM_UNLINKED']])
      const audit = await client.query(
         "SELECT metadata FROM audit_events WHERE subject_user_id = $1 AND event_code = 'auth.telegram.unlinked'",
         [unlinker.userId],
      )
      assert.deepEqual(audit.rows[0].metadata, { cancelledDeliveries: 1 })

      const bot = new FakeBot()
      await send(bot)
      assert.equal(bot.calls.length, 0)
      assert.deepEqual((await deliveries(off.userId)).map((row) => row.last_error_code), ['TELEGRAM_DISABLED'])
      assert.deepEqual((await deliveries(eventOff.userId)).map((row) => row.last_error_code), ['TELEGRAM_EVENT_DISABLED'])
      assert.deepEqual((await deliveries(inactive.userId)).map((row) => row.last_error_code), ['ACCOUNT_NOT_ACTIVE'])
      for (const user of [off, eventOff, inactive]) {
         assert.equal((await deliveries(user.userId))[0].status, 'cancelled')
      }
   })

   await t.test('settings API: defaults, partial updates, validation, effect on new deliveries', async () => {
      const app = createApp({ telegramAuth: { config }, passwordAuth: { config }, authProtection: { config }, notifications: { config } })
      const server = await new Promise((resolve) => {
         const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
      })
      t.after(() => new Promise((resolve) => { server.close(resolve) }))
      const { port } = server.address()
      async function api(method, path, actor, body) {
         const headers = { 'content-type': 'application/json' }
         if (actor) headers.authorization = `Bearer ${actor.accessToken}`
         const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
            method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
         })
         return { status: response.status, body: await response.json() }
      }
      const user = await createUser({ timezone: 'Asia/Dushanbe', quiet: 'default' })
      const other = await createUser({ quiet: 'default' })
      const session = await withTransaction((tx) => issueSessionService({
         userId: user.userId, requestContext: { userAgent: 'Delivery integration', ipAddress: '127.0.0.1' }, client: tx,
      }, { config }))

      assert.equal((await api('GET', '/me/notification-settings', null)).status, 401)
      const defaults = await api('GET', '/me/notification-settings', session)
      assert.equal(defaults.status, 200)
      assert.deepEqual({ ...defaults.body.data, events: undefined }, {
         telegramEnabled: true,
         quietHours: { start: '22:00', end: '08:00' },
         timeZone: 'Asia/Dushanbe',
         messagingConnected: true,
         events: undefined,
      })
      assert.deepEqual(defaults.body.data.events['test.assigned'], { telegram: true })
      assert.equal('telegram.disconnected' in defaults.body.data.events, false)

      const updated = await api('PUT', '/me/notification-settings', session, {
         quietHours: { start: '23:30', end: '06:00' },
         events: { 'account.approved': { telegram: false }, 'test.assigned': { telegram: true } },
      })
      assert.equal(updated.status, 200)
      assert.deepEqual(updated.body.data.quietHours, { start: '23:30', end: '06:00' })
      assert.equal(updated.body.data.events['account.approved'].telegram, false)
      assert.equal(updated.body.data.telegramEnabled, true, 'untouched fields keep their value')

      const quietOff = await api('PUT', '/me/notification-settings', session, { quietHours: null, telegramEnabled: false })
      assert.deepEqual([quietOff.body.data.quietHours, quietOff.body.data.telegramEnabled], [null, false])
      assert.equal(quietOff.body.data.events['account.approved'].telegram, false, 'event switches are kept')

      for (const bad of [{}, { quietHours: { start: '22:00', end: '22:00' } }, { events: { 'telegram.disconnected': { telegram: true } } }, { inApp: false }]) {
         const response = await api('PUT', '/me/notification-settings', session, bad)
         assert.equal(response.status, 400, JSON.stringify(bad))
         assert.equal(response.body.error.code, 'VALIDATION_ERROR')
      }

      // Master switch off: a new event gets no Telegram copy; on again with the event off: still none.
      await notify(user.userId)
      assert.deepEqual(await deliveries(user.userId), [])
      await api('PUT', '/me/notification-settings', session, { telegramEnabled: true })
      await notify(user.userId)
      assert.deepEqual(await deliveries(user.userId), [], 'account.approved is off on Telegram')
      await api('PUT', '/me/notification-settings', session, { events: { 'account.approved': { telegram: true } } })
      await notify(user.userId)
      assert.equal((await deliveries(user.userId)).length, 1)

      const audit = await client.query(
         "SELECT count(*)::integer AS count FROM audit_events WHERE subject_user_id = $1 AND event_code = 'notification.settings_updated'",
         [user.userId],
      )
      assert.equal(audit.rows[0].count, 4)
      const untouched = await client.query('SELECT count(*)::integer AS count FROM notification_settings WHERE user_id = $1', [other.userId])
      assert.equal(untouched.rows[0].count, 0)
   })

   await t.test('logs and stored errors hold codes only: no token, chat id or text', async () => {
      const stored = await client.query(
         `SELECT DISTINCT last_error_code FROM notification_deliveries WHERE last_error_code IS NOT NULL`,
      )
      for (const row of stored.rows) assert.match(row.last_error_code, /^[A-Z_]+$/)
      const haystack = logs.join('\n')
      assert.ok(logs.length > 0)
      assert.equal(haystack.includes(botToken), false)
      assert.equal(haystack.includes(String(chatSeed)), false)
      assert.equal(haystack.includes('EVEREST'), false)
      assert.equal(haystack.includes('app.example.test'), false)
   })
})
