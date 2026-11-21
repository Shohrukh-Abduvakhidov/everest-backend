import assert from 'node:assert/strict'
import test from 'node:test'

import {
   formatDateTime,
   notificationEventCodes,
   renderNotification,
   resolveLanguage,
} from '../../src/utils/notification-texts.js'

test('notification language: database tg and API tj both select Tajik; unknown falls back to ru', () => {
   assert.equal(resolveLanguage('tg'), 'tg')
   assert.equal(resolveLanguage('tj'), 'tg')
   assert.equal(resolveLanguage('ru'), 'ru')
   assert.equal(resolveLanguage('en'), 'en')
   assert.equal(resolveLanguage('de'), 'ru')
   assert.equal(resolveLanguage(undefined), 'ru')
   const fromDb = renderNotification('course.enrolled', { course: 'Физика' }, { languageCode: 'tg' })
   const fromApi = renderNotification('course.enrolled', { course: 'Физика' }, { languageCode: 'tj' })
   assert.deepEqual(fromDb, fromApi)
   assert.deepEqual(fromDb, { title: 'Курси нав', body: 'Ба шумо курси «Физика» кушода шуд.' })
})

test('every event has a title and a body in ru, tg and en', () => {
   const params = { test: 'T', closesAt: '2030-01-15T10:00:00Z', group: 'G', title: 'A', count: 2, course: 'C', module: 'M' }
   for (const eventCode of notificationEventCodes) {
      const bodies = new Set()
      for (const languageCode of ['ru', 'tg', 'en']) {
         const rendered = renderNotification(eventCode, params, { languageCode })
         assert.ok(rendered.title.length > 0, `${eventCode} ${languageCode} title`)
         assert.ok(rendered.body.length > 0, `${eventCode} ${languageCode} body`)
         assert.equal(rendered.body.includes('undefined'), false, `${eventCode} ${languageCode}`)
         bodies.add(rendered.body)
      }
      assert.equal(bodies.size, 3, `${eventCode} has three different texts`)
   }
   assert.ok(notificationEventCodes.includes('module.opened'))
})

test('PR 3 events: texts, Tajik for tg and tj, Telegram only for the reminder and the answers', async () => {
   const { telegramEventCodes, notificationExpiresAt } = await import('../../src/utils/notification-texts.js')
   assert.equal(renderNotification('test.closing_24h', { test: 'Q' }, { languageCode: 'tj' }).body, 'То пӯшидани санҷиши «Q» 24 соат монд.')
   assert.equal(renderNotification('test.closing_24h', { test: 'Q' }, { languageCode: 'tg' }).title, 'Санҷиш ба наздикӣ пӯшида мешавад')
   assert.equal(renderNotification('test.answers_available', { test: 'Q' }, { languageCode: 'ru' }).body, 'Открыты ответы теста «Q».')
   assert.equal(renderNotification('test.result_updated', { test: 'Q' }, { languageCode: 'en' }).body, 'Your result for “Q” was updated.')
   assert.equal(renderNotification('attempt.expired', { test: 'Q' }, { languageCode: 'tg' }).body, 'Вақт тамом шуд, кӯшиш дар санҷиши «Q» анҷом ёфт.')
   assert.ok(telegramEventCodes.includes('test.closing_24h'))
   assert.ok(telegramEventCodes.includes('test.answers_available'))
   assert.equal(telegramEventCodes.includes('test.result_updated'), false)
   assert.equal(telegramEventCodes.includes('attempt.expired'), false)
   assert.equal(
      notificationExpiresAt('test.closing_24h', 'test.closing_24h:12:2030-01-15T10:00:00.000Z').toISOString(),
      '2030-01-15T10:00:00.000Z',
   )
   assert.equal(notificationExpiresAt('test.assigned', 'test.assigned:12'), null)
   assert.equal(notificationExpiresAt('test.closing_24h', 'test.closing_24h:12:not-a-date'), null)
})

test('module.opened texts', () => {
   const params = { module: 'Дроби', course: 'Алгебра' }
   assert.equal(renderNotification('module.opened', params, { languageCode: 'ru' }).body, 'Вам открыт модуль «Дроби» курса «Алгебра».')
   assert.equal(renderNotification('module.opened', params, { languageCode: 'tg' }).body, 'Ба шумо модули «Дроби»-и курси «Алгебра» кушода шуд.')
   assert.equal(renderNotification('module.opened', params, { languageCode: 'en' }).body, 'Module “Дроби” of “Алгебра” is now open to you.')
})

test('dates are shown in the recipient time zone; invalid zones fall back to Asia/Dushanbe', () => {
   assert.equal(formatDateTime('2030-01-15T10:00:00Z', 'Asia/Dushanbe'), '15.01.2030 15:00')
   assert.equal(formatDateTime('2030-01-15T22:30:00Z', 'UTC'), '15.01.2030 22:30')
   assert.equal(formatDateTime('2030-01-15T22:30:00Z', 'Asia/Dushanbe'), '16.01.2030 03:30')
   assert.equal(formatDateTime('2030-01-15T10:00:00Z', 'Not/AZone'), '15.01.2030 15:00')
   const withoutClose = renderNotification('test.assigned', { test: 'Quiz', closesAt: null }, { languageCode: 'en' })
   assert.equal(withoutClose.body, 'New test “Quiz”.')
})

test('long titles are shortened and whitespace collapsed; unknown events throw', () => {
   const long = 'x'.repeat(300)
   const rendered = renderNotification('course.enrolled', { course: `  ${long}\n` }, { languageCode: 'en' })
   assert.ok(rendered.body.length < 160)
   assert.ok(rendered.body.includes('…'))
   assert.throws(() => renderNotification('nope', {}, {}), /Unknown notification event/)
})
