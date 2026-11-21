import assert from 'node:assert/strict'
import test from 'node:test'

import { TelegramRateLimiter } from '../../src/jobs/telegram-rate-limiter.js'
import { TelegramBotProvider } from '../../src/services/auth/telegram-bot-provider.js'
import { parseSettingsBody } from '../../src/services/notification-settings-service.js'
import { telegramEventCodes, telegramMessageText } from '../../src/utils/notification-texts.js'
import { quietUntil } from '../../src/utils/quiet-hours.js'

function fakeClock(start = 1_000_000) {
   let current = start
   const sleeps = []
   return {
      now: () => current,
      sleep: async (ms) => { sleeps.push(ms); current += ms },
      advance: (ms) => { current += ms },
      sleeps,
   }
}

test('rate limiter: 20 per second for the bot, evenly spaced', async () => {
   const clock = fakeClock()
   const limiter = new TelegramRateLimiter({ perSecond: 20, perChatIntervalMs: 1000, now: clock.now, sleep: clock.sleep })
   const times = []
   for (let chat = 0; chat < 200; chat += 1) times.push(await limiter.acquire(`chat-${chat}`))
   for (let index = 1; index < times.length; index += 1) assert.ok(times[index] - times[index - 1] >= 50)
   assert.ok(times.at(-1) - times[0] >= 199 * 50, '200 messages take at least 9.95 s')
   // Never more than 20 inside any one-second window.
   for (let index = 0; index + 20 < times.length; index += 1) assert.ok(times[index + 20] - times[index] >= 1000)
})

test('rate limiter: one message per second to the same chat, others are not held back', async () => {
   const clock = fakeClock()
   const limiter = new TelegramRateLimiter({ perSecond: 20, perChatIntervalMs: 1000, now: clock.now, sleep: clock.sleep })
   const first = await limiter.acquire('a')
   const other = await limiter.acquire('b')
   const second = await limiter.acquire('a')
   const third = await limiter.acquire('a')
   assert.equal(other - first, 50)
   assert.equal(second - first, 1000)
   assert.equal(third - second, 1000)
})

test('rate limiter: pause holds every chat until the given time', async () => {
   const clock = fakeClock()
   const limiter = new TelegramRateLimiter({ now: clock.now, sleep: clock.sleep })
   await limiter.acquire('a')
   limiter.pause(7000)
   const next = await limiter.acquire('b')
   assert.ok(next >= 1_000_000 + 7000)
})

test('quiet hours: across midnight, inside one day, time zones, off', () => {
   const at = (iso) => new Date(iso)
   const night = { start: '22:00', end: '08:00', timeZone: 'Asia/Dushanbe' }
   // 23:30 Dushanbe = 18:30 UTC -> ends 08:00 Dushanbe = 03:00 UTC next day.
   assert.equal(quietUntil(at('2030-01-15T18:30:00Z'), night).toISOString(), '2030-01-16T03:00:00.000Z')
   // 03:15 Dushanbe = 22:15 UTC.
   assert.equal(quietUntil(at('2030-01-15T22:15:40Z'), night).toISOString(), '2030-01-16T03:00:00.000Z')
   // 12:00 Dushanbe: allowed.
   assert.equal(quietUntil(at('2030-01-15T07:00:00Z'), night), null)
   // Exactly at the end minute: allowed; one minute before: waits one minute.
   assert.equal(quietUntil(at('2030-01-15T03:00:00Z'), night), null)
   assert.equal(quietUntil(at('2030-01-15T02:59:10Z'), night).toISOString(), '2030-01-15T03:00:00.000Z')
   const day = { start: '13:00', end: '14:00', timeZone: 'UTC' }
   assert.equal(quietUntil(at('2030-01-15T13:20:00Z'), day).toISOString(), '2030-01-15T14:00:00.000Z')
   assert.equal(quietUntil(at('2030-01-15T14:00:00Z'), day), null)
   assert.equal(quietUntil(at('2030-01-15T12:59:00Z'), day), null)
   // Values from PostgreSQL TIME come as HH:MM:SS.
   assert.ok(quietUntil(at('2030-01-15T13:20:00Z'), { start: '13:00:00', end: '14:00:00', timeZone: 'UTC' }))
   assert.equal(quietUntil(at('2030-01-15T13:20:00Z'), { start: null, end: null, timeZone: 'UTC' }), null)
   assert.equal(quietUntil(at('2030-01-15T13:20:00Z'), { start: '13:00', end: '13:00', timeZone: 'UTC' }), null)
})

test('Telegram text: title, body and APP_URL link, plain text', () => {
   const message = { title: 'Новый тест', body: 'Новый тест «Q».', targetPath: '/courses/12' }
   assert.equal(telegramMessageText(message, 'https://app.example.test'), 'Новый тест\n\nНовый тест «Q».\n\nhttps://app.example.test/courses/12')
   assert.equal(telegramMessageText(message, null), 'Новый тест\n\nНовый тест «Q».')
   assert.equal(telegramMessageText({ ...message, targetPath: null }, 'https://app.example.test'), 'Новый тест\n\nНовый тест «Q».')
   assert.equal(telegramMessageText({ ...message, targetPath: 'https://evil.test' }, 'https://app.example.test').includes('evil'), false)
   assert.ok(telegramMessageText({ ...message, body: 'x'.repeat(5000) }, null).length <= 4000)
   assert.equal(telegramEventCodes.includes('telegram.disconnected'), false)
   assert.ok(telegramEventCodes.includes('module.opened'))
})

function fakeFetch(respond) {
   const calls = []
   const fetchImplementation = async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body), signal: options.signal })
      return respond(calls.length)
   }
   return { calls, fetchImplementation }
}
const reply = (status, body) => ({ ok: status < 300, status, json: async () => body })

test('bot provider: plain text request, message id, 429 retry_after, 403, 5xx, no response', async () => {
   const ok = fakeFetch(() => reply(200, { ok: true, result: { message_id: 77 } }))
   const provider = new TelegramBotProvider({ botToken: 'token-x' }, ok.fetchImplementation)
   assert.deepEqual(await provider.sendMessage('123', 'Hello'), { messageId: '77' })
   assert.deepEqual(ok.calls[0].body, { chat_id: '123', text: 'Hello' })
   assert.equal('parse_mode' in ok.calls[0].body, false)
   assert.ok(ok.calls[0].signal, 'request has a timeout')

   const limited = new TelegramBotProvider({ botToken: 't' }, fakeFetch(() => reply(429, {
      ok: false, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 },
   })).fetchImplementation)
   await assert.rejects(limited.sendMessage('1', 'x'), (error) => error.retryAfter === 7
      && error.telegramStatus === 429 && error.telegramAccessUnavailable === false)

   const blocked = new TelegramBotProvider({ botToken: 't' }, fakeFetch(() => reply(403, {
      ok: false, description: 'Forbidden: bot was blocked by the user',
   })).fetchImplementation)
   await assert.rejects(blocked.sendMessage('1', 'x'), (error) => error.telegramAccessUnavailable === true && error.retryAfter === null)

   const notFound = new TelegramBotProvider({ botToken: 't' }, fakeFetch(() => reply(400, {
      ok: false, description: 'Bad Request: chat not found',
   })).fetchImplementation)
   await assert.rejects(notFound.sendMessage('1', 'x'), (error) => error.telegramAccessUnavailable === true)

   const down = new TelegramBotProvider({ botToken: 't' }, fakeFetch(() => reply(502, { ok: false })).fetchImplementation)
   await assert.rejects(down.sendMessage('1', 'x'), (error) => error.telegramStatus === 502 && !error.networkError)

   const silent = new TelegramBotProvider({ botToken: 't' }, async () => { throw new Error('socket hang up') })
   await assert.rejects(silent.sendMessage('1', 'x'), (error) => error.networkError === true
      && error.code === 'TELEGRAM_MESSAGE_FAILED' && !String(error.message).includes('socket'))
})

test('settings body validation', () => {
   assert.deepEqual(parseSettingsBody({ telegramEnabled: false }).telegramEnabled, false)
   const quiet = parseSettingsBody({ quietHours: { start: '23:00', end: '07:30' } })
   assert.deepEqual([quiet.hasQuietHours, quiet.quietStart, quiet.quietEnd], [true, '23:00', '07:30'])
   const off = parseSettingsBody({ quietHours: null })
   assert.deepEqual([off.hasQuietHours, off.quietStart, off.quietEnd], [true, null, null])
   assert.deepEqual(parseSettingsBody({ events: { 'test.assigned': { telegram: false } } }).preferences, [
      { eventCode: 'test.assigned', enabled: false },
   ])
   for (const bad of [
      null, [], {}, { other: 1 }, { telegramEnabled: 'yes' },
      { quietHours: { start: '24:00', end: '07:00' } }, { quietHours: { start: '7:00', end: '08:00' } },
      { quietHours: { start: '22:00', end: '22:00' } }, { quietHours: { start: '22:00' } },
      { quietHours: { start: '22:00', end: '08:00', zone: 'UTC' } },
      { events: { 'telegram.disconnected': { telegram: true } } }, { events: { nope: { telegram: true } } },
      { events: { 'test.assigned': { telegram: 'no' } } }, { events: { 'test.assigned': { telegram: true, inApp: false } } },
      { events: [] },
   ]) {
      assert.throws(() => parseSettingsBody(bad), { code: 'VALIDATION_ERROR' }, JSON.stringify(bad))
   }
})
