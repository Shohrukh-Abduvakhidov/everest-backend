import assert from 'node:assert/strict'
import test from 'node:test'

import { createSiteRevalidationProvider } from '../../src/providers/site/revalidation-provider.js'
import { createSiteJobHandlers } from '../../src/services/site-content-service.js'
import {
   adminTranslatables,
   imageDimensions,
   isPastEvent,
   localize,
   mergeTranslations,
   normalizeSitePhone,
   parseApiLanguage,
   parseDushanbeDateTime,
   parseHours,
   parseIsoDuration,
   parsePhones,
   parseSalary,
   parseTelegram,
   parseTranslatableInput,
   parseVideoUrl,
   rejectUnknownPaths,
   resolvedLanguage,
   toDushanbeIso,
   translatableFields,
   whatsappUrl,
} from '../../src/utils/site-content.js'

const rejectsWith = (fn, field) => assert.throws(fn, (error) => error.code === 'VALIDATION_ERROR'
   && (!field || error.details[0].field === field))

test('site: video links are YouTube, Vimeo or an https file; everything else is refused', () => {
   const id = 'dQw4w9WgXcQ'
   for (const url of [
      `https://www.youtube.com/watch?v=${id}`,
      `https://youtube.com/watch?v=${id}&t=42s`,
      `https://m.youtube.com/watch?v=${id}`,
      `https://youtu.be/${id}?si=abc`,
      `https://www.youtube.com/embed/${id}`,
      `https://www.youtube.com/shorts/${id}`,
      `http://www.youtube.com/live/${id}`,
   ]) {
      assert.deepEqual(parseVideoUrl(url), { provider: 'youtube', videoId: id, url: `https://www.youtube.com/watch?v=${id}` }, url)
   }
   assert.deepEqual(parseVideoUrl('https://vimeo.com/76979871'), { provider: 'vimeo', videoId: '76979871', url: 'https://vimeo.com/76979871' })
   assert.equal(parseVideoUrl('https://player.vimeo.com/video/76979871').videoId, '76979871')
   assert.equal(parseVideoUrl('https://cdn.example.test/intro.mp4').provider, 'file')
   for (const url of [
      `https://youtube.com.evil.test/watch?v=${id}`,
      `https://evilyoutube.com/watch?v=${id}`,
      'https://www.youtube.com/watch?v=short',
      'https://www.youtube.com/channel/UC1234567890',
      'https://vimeo.com/channels/staff',
      'http://cdn.example.test/intro.mp4',
      'https://cdn.example.test/intro.mov',
      `ftp://youtu.be/${id}`,
      `https://user:pass@youtu.be/${id}`,
      `https://youtu.be:8443/${id}`,
      `javascript:alert(1)//youtu.be/${id}`,
      'not a url',
      42,
   ]) {
      rejectsWith(() => parseVideoUrl(url), 'url')
   }
   assert.equal(parseIsoDuration('PT4M13S'), 'PT4M13S')
   rejectsWith(() => parseIsoDuration('4:13'), 'duration')
   rejectsWith(() => parseIsoDuration('PT'), 'duration')
})

test('site: phones are { number, label } with numbers normalized to E.164 (+992 for local)', () => {
   assert.equal(normalizeSitePhone('901234567', 'p'), '+992901234567')
   assert.equal(normalizeSitePhone('+992 (90) 123-45-67', 'p'), '+992901234567')
   assert.equal(normalizeSitePhone('992 90 123 45 67', 'p'), '+992901234567')
   assert.equal(normalizeSitePhone('00992901234567', 'p'), '+992901234567')
   assert.equal(normalizeSitePhone('+7 912 345 67 89', 'p'), '+79123456789')
   assert.deepEqual(parsePhones([
      { number: '901234567', label: { ru: 'Ресепшн', tj: 'Қабулгоҳ' } },
      { number: '+992 90 123 45 68' },
   ]), [
      { number: '+992901234567', label: { ru: 'Ресепшн', tg: 'Қабулгоҳ' } },
      { number: '+992901234568', label: {} },
   ])
   for (const bad of ['+99290123', '+9929012345678', '12345', 'phone', '', '+0123456789']) {
      rejectsWith(() => normalizeSitePhone(bad, 'phones[0].number'), 'phones[0].number')
   }
   rejectsWith(() => parsePhones(['901234567']), 'phones[0]')
   rejectsWith(() => parsePhones([{ number: '901234567' }, { number: '+992901234567' }]), 'phones[1].number')
})

test('site: { ru, tj, en } fields, storage rows and the fallback to Russian', () => {
   assert.equal(parseApiLanguage(undefined), 'ru')
   assert.equal(parseApiLanguage('tj'), 'tg')
   rejectsWith(() => parseApiLanguage('de'), 'lang')

   const changes = parseTranslatableInput('courses', {
      title: { ru: 'Химия', en: 'Chemistry' },
      summary: { ru: 'Описание' },
      topics: { ru: ['Атом'] },
      seo: { title: { tj: 'Химия — ММТ' } },
   })
   assert.deepEqual(changes.tg, { seoTitle: 'Химия — ММТ' }, 'tj is stored as tg')
   const stored = mergeTranslations('courses', {}, changes)
   assert.deepEqual(Object.keys(stored).sort(), ['en', 'ru', 'tg'])

   const admin = adminTranslatables('courses', stored)
   assert.deepEqual(admin.title, { ru: 'Химия', tj: null, en: 'Chemistry' })
   assert.deepEqual(admin.topics, { ru: ['Атом'], tj: [], en: [] })
   assert.deepEqual(admin.seo.title, { ru: null, tj: 'Химия — ММТ', en: null })

   const en = localize('courses', stored, 'en')
   assert.equal(en.title, 'Chemistry')
   assert.equal(en.summary, 'Описание', 'an empty field falls back to Russian')
   assert.deepEqual(en.topics, ['Атом'], 'an empty list falls back to Russian')
   assert.equal(resolvedLanguage(stored, 'en'), 'en')
   assert.equal(resolvedLanguage(stored, 'tg'), 'ru', 'no own title: the object is shown in ru')

   const cleared = mergeTranslations('courses', stored, parseTranslatableInput('courses', { title: { en: null } }))
   assert.equal(cleared.en, undefined, 'a language with nothing left is dropped')
   rejectsWith(() => parseTranslatableInput('courses', { title: { de: 'x' } }), 'title.de')
   rejectsWith(() => parseTranslatableInput('courses', { title: 'Химия' }), 'title')
   rejectsWith(() => parseTranslatableInput('courses', { program: { ru: [{ items: ['x'] }] } }), 'program.ru[0].title')
   rejectsWith(() => parseTranslatableInput('settings', { whatsappTemplate: { ru: 'Курс {price}' } }), 'whatsappTemplate.ru')
   assert.equal(parseTranslatableInput('settings', { whatsappTemplate: { ru: '{course} {vacancy} {event}' } }).ru.whatsappTemplate, '{course} {vacancy} {event}')

   const paths = translatableFields.courses.map((spec) => spec.path)
   rejectUnknownPaths({ title: {}, seo: { title: {} } }, paths)
   rejectsWith(() => rejectUnknownPaths({ seo: { keywords: {} } }, paths), 'seo.keywords')
   rejectsWith(() => rejectUnknownPaths({ price: 1 }, paths), 'price')
})

test('site: Dushanbe times, hours, salary, usernames and WhatsApp links', () => {
   assert.equal(parseDushanbeDateTime('2026-12-05T10:00', 'startsAt'), '2026-12-05T05:00:00.000Z')
   assert.equal(parseDushanbeDateTime('2026-12-05T10:00:00+05:00', 'startsAt'), '2026-12-05T05:00:00.000Z')
   assert.equal(toDushanbeIso('2026-12-05T05:00:00.000Z'), '2026-12-05T10:00:00+05:00')
   rejectsWith(() => parseDushanbeDateTime('2026-02-30T10:00', 'startsAt'), 'startsAt')
   rejectsWith(() => parseDushanbeDateTime('tomorrow', 'startsAt'), 'startsAt')
   assert.deepEqual(parseHours([{ days: ['sat', 'mon'], opens: '09:00', closes: '18:00' }]), [{ days: ['mon', 'sat'], opens: '09:00', closes: '18:00' }])
   rejectsWith(() => parseHours([{ days: ['mon'], opens: '18:00', closes: '09:00' }]), 'hours[0].closes')
   rejectsWith(() => parseHours([{ days: ['mon'], opens: '9:00', closes: '18:00' }]), 'hours[0].opens')
   rejectsWith(() => parseHours([{ days: ['mon'], opens: '09:00', closes: '13:00' }, { days: ['mon'], opens: '14:00', closes: '18:00' }]), 'hours[1].days')
   assert.deepEqual(parseSalary({ min: 3000, currency: 'TJS' }), { min: 3000, max: null, currency: 'TJS' })
   rejectsWith(() => parseSalary({ min: 3000, currency: 'USD' }), 'salary.currency')
   rejectsWith(() => parseSalary({ min: 5000, max: 3000, currency: 'TJS' }), 'salary.max')
   assert.equal(parseTelegram('@everest_lc'), 'everest_lc')
   assert.equal(parseTelegram('https://t.me/everest_lc'), 'everest_lc')
   rejectsWith(() => parseTelegram('https://evil.test/everest_lc'), 'telegram')
   assert.equal(whatsappUrl('+992901234567', 'Салом! Курс «Химия»'),
      `https://wa.me/992901234567?text=${encodeURIComponent('Салом! Курс «Химия»')}`)
})

test('site: image width and height are read from PNG and JPEG bytes', () => {
   const png = Buffer.alloc(33)
   Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png)
   png.writeUInt32BE(13, 8)
   png.write('IHDR', 12, 'latin1')
   png.writeUInt32BE(1200, 16)
   png.writeUInt32BE(630, 20)
   assert.deepEqual(imageDimensions(png, 'image/png'), { width: 1200, height: 630 })
   // SOI, an APP0 segment, then SOF0 with height 400 and width 640.
   const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x90, 0x02, 0x80, 0x03, 0x01, 0x22, 0x00,
   ])
   assert.deepEqual(imageDimensions(jpeg, 'image/jpeg'), { width: 640, height: 400 })
   assert.equal(imageDimensions(Buffer.from([0xff, 0xd8, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0]), 'image/jpeg'), null)
})

test('site: the revalidation webhook sends x-revalidate-secret, never throws, and the job retries', async () => {
   let calls = 0
   const fetchSpy = async () => {
      calls += 1
      return { ok: true, status: 200 }
   }
   assert.deepEqual(await createSiteRevalidationProvider({ url: null, secret: 's' }, fetchSpy).revalidate({ tags: ['site'] }), { skipped: true })
   assert.deepEqual(await createSiteRevalidationProvider({ url: 'https://site.test/api/revalidate', secret: null }, fetchSpy).revalidate({ tags: ['site'] }), { skipped: true })
   assert.equal(calls, 0)

   let request
   const ok = createSiteRevalidationProvider({ url: 'https://site.test/api/revalidate', secret: 'shh', timeoutMs: 500 }, async (url, init) => {
      request = { url, init }
      return { ok: true, status: 200 }
   })
   assert.deepEqual(await ok.revalidate({ tags: ['site', 'site:courses', 'site:course:biology'] }), { ok: true, status: 200 })
   assert.equal(request.url, 'https://site.test/api/revalidate')
   assert.equal(request.init.headers['x-revalidate-secret'], 'shh')
   assert.equal(request.init.headers.authorization, undefined)
   assert.deepEqual(JSON.parse(request.init.body), { tags: ['site', 'site:courses', 'site:course:biology'] })

   const failing = createSiteRevalidationProvider({ url: 'https://site.test/x', secret: 's' }, async () => {
      throw new TypeError('fetch failed')
   })
   assert.deepEqual(await failing.revalidate({ tags: ['site'] }), { ok: false, error: 'TypeError' })
   const refused = createSiteRevalidationProvider({ url: 'https://site.test/x', secret: 's' }, async () => ({ ok: false, status: 500 }))
   assert.deepEqual(await refused.revalidate({ tags: ['site'] }), { ok: false, status: 500 })

   // A redirect is not followed: it would turn the POST into a GET and pass the secret to another host.
   assert.equal(request.init.redirect, 'manual')
   const redirected = createSiteRevalidationProvider({ url: 'https://site.test/x', secret: 's' }, async () => ({ ok: false, status: 301 }))
   assert.deepEqual(await redirected.revalidate({ tags: ['site'] }), { ok: false, status: 301 })
   await assert.rejects(createSiteJobHandlers(redirected)['site.revalidate']({ tags: ['site'] }), (error) => error.code === 'SITE_REVALIDATE_FAILED')

   // The job handler turns a failure into an error, which worker:jobs retries with backoff.
   const failingJob = createSiteJobHandlers(refused)['site.revalidate']
   await assert.rejects(failingJob({ tags: ['site'] }), (error) => error.code === 'SITE_REVALIDATE_FAILED')
   await createSiteJobHandlers(ok)['site.revalidate']({ tags: ['site:settings'] })
   await createSiteJobHandlers(createSiteRevalidationProvider({ url: null, secret: null }))['site.revalidate']({ tags: ['site'] })
})

test('site: an event is past once it ended; without an end it stays through its Dushanbe day', () => {
   const at = (value) => new Date(value)
   // With an end: over from that moment.
   const timed = { startsAt: '2026-12-05T10:00:00+05:00', endsAt: '2026-12-05T12:00:00+05:00' }
   assert.equal(isPastEvent(timed, at('2026-12-05T11:59:59+05:00')), false)
   assert.equal(isPastEvent(timed, at('2026-12-05T12:00:00+05:00')), true)
   assert.equal(isPastEvent(timed, at('2026-12-06T09:00:00+05:00')), true)
   // The start passed but the event is not over yet.
   assert.equal(isPastEvent(timed, at('2026-12-05T11:00:00+05:00')), false)
   // Without an end: until 00:00 of the next day in Asia/Dushanbe (UTC+5), whatever the server zone.
   const open = { startsAt: '2026-12-05T10:00:00+05:00', endsAt: null }
   assert.equal(isPastEvent(open, at('2026-12-05T23:59:59+05:00')), false)
   assert.equal(isPastEvent(open, at('2026-12-06T00:00:00+05:00')), true)
   assert.equal(isPastEvent(open, at('2026-12-04T10:00:00+05:00')), false)
   // An evening start is judged by its Dushanbe day, not the UTC day: 23:30 +05:00 is 18:30 UTC.
   const late = { startsAt: new Date('2026-12-05T18:30:00Z'), endsAt: null }
   assert.equal(isPastEvent(late, at('2026-12-05T18:59:00Z')), false)
   assert.equal(isPastEvent(late, at('2026-12-05T19:00:00Z')), true)
   // pg returns Date objects; a draft without a start is never past.
   assert.equal(isPastEvent({ startsAt: null, endsAt: null }, at('2030-01-01T00:00:00Z')), false)
})
