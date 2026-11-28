import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import pg from 'pg'

import { createApp } from '../../src/app.js'
import env from '../../src/configs/env.js'
import { runNextJob } from '../../src/jobs/job-worker.js'
import { createSiteRevalidationProvider } from '../../src/providers/site/revalidation-provider.js'
import * as jobRepository from '../../src/repositories/job-repository.js'
import { withTransaction } from '../../src/repositories/transaction-repository.js'
import { createSiteJobHandlers } from '../../src/services/site-content-service.js'
import { createMemoryStorageProvider } from '../helpers/memory-storage-provider.js'
import { createSessionTestService, createTelegramAuthTestService } from '../helpers/service-factories.js'

const { Client } = pg
const suffix = randomUUID().slice(0, 8)
const slug = `algebra-${suffix}`

function pngBytes(width, height) {
   const png = Buffer.alloc(64)
   Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png)
   png.writeUInt32BE(13, 8)
   png.write('IHDR', 12, 'latin1')
   png.writeUInt32BE(width, 16)
   png.writeUInt32BE(height, 20)
   return png
}

test('marketing site: public reads, admin-only writes, validation, webhook queue', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   t.after(() => client.end())

   async function createUser(role) {
      const { rows } = await client.query(
         `INSERT INTO users (status, onboarding_completed_at) VALUES ('active', CURRENT_TIMESTAMP) RETURNING id`,
      )
      await client.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2', [rows[0].id, role])
      return rows[0].id
   }
   const adminId = await createUser('admin')
   const teacherId = await createUser('teacher')
   const studentId = await createUser('student')

   const config = { ...env, jwtAccessSecret: 'site-content-integration-secret-longer-than-32-chars' }
   const sessions = createSessionTestService({ config })
   const storage = createMemoryStorageProvider()
   const site = {
      storage,
      baseUrl: 'https://api.test',
      revalidateConfig: { url: 'https://site.test/api/revalidate', secret: 'shh' },
   }
   const app = createApp({
      telegramAuth: createTelegramAuthTestService({ config }).dependencies,
      authProtection: { config },
      site,
   })
   const server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
   })
   t.after(() => new Promise((resolve) => server.close(resolve)))
   const base = `http://127.0.0.1:${server.address().port}/api/v1`
   const token = async (userId) => (await withTransaction((transactionClient) => sessions.issueSession({
      userId, requestContext: { userAgent: 'test', ipAddress: '127.0.0.1' }, client: transactionClient,
   }))).accessToken
   const tokens = { admin: await token(adminId), teacher: await token(teacherId), student: await token(studentId) }

   async function call(method, path, { as, body, headers = {}, raw } = {}) {
      const response = await fetch(`${base}${path}`, {
         method,
         redirect: 'manual',
         headers: {
            ...(as ? { authorization: `Bearer ${tokens[as]}` } : {}),
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...headers,
         },
         body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
      })
      const text = await response.text()
      const json = (response.headers.get('content-type') || '').includes('application/json')
      return { status: response.status, headers: response.headers, body: json && text ? JSON.parse(text) : null }
   }
   const siteJobs = async () => (await client.query(
      `SELECT id, payload, status, attempts, last_error_code FROM background_jobs
       WHERE job_type = 'site.revalidate' ORDER BY id`,
   )).rows

   await t.test('the seed: 4 published courses, drafts hidden, stats off', async () => {
      const courses = await call('GET', '/public/site/courses')
      assert.equal(courses.status, 200)
      const seeded = courses.body.data.courses.filter((course) => ['biology', 'chemistry', 'physics', 'tajik'].includes(course.slug))
      assert.deepEqual(seeded.map((course) => course.slug), ['biology', 'chemistry', 'physics', 'tajik'])
      for (const course of seeded) {
         assert.equal(course.audience, 'Школьники и абитуриенты')
         assert.equal(course.format, 'hybrid')
         assert.equal(course.subjectKey, course.slug)
         assert.ok(course.program.length && Array.isArray(course.program[0].items))
         assert.equal(course.lang, 'ru')
      }
      const tajik = await call('GET', '/public/site/courses/tajik?lang=tj')
      assert.equal(tajik.body.data.title, 'Забони тоҷикӣ')
      assert.equal(tajik.body.data.lang, 'tj')
      assert.ok(!JSON.stringify(courses.body).includes('Student Platform'))
      assert.ok(!JSON.stringify(courses.body).includes('AI-помощник'))
      assert.deepEqual((await call('GET', '/public/site/vacancies')).body.data.vacancies, [])
      assert.deepEqual((await call('GET', '/public/site/events')).body.data.events, [])
      const settings = (await call('GET', '/public/site/settings')).body.data
      assert.deepEqual(settings.stats, { enabled: false, items: [] })
      assert.equal(settings.whyEverest.length, 6)
      assert.equal(settings.stages.length, 6)
      assert.equal(settings.whatsapp, null)
      assert.deepEqual(settings.phones, [])
      const adminSettings = (await call('GET', '/admin/site/settings', { as: 'admin' })).body.data
      assert.equal(adminSettings.stats.items.length, 4, 'the figures are kept for the admin')
   })

   await t.test('only owner and admin reach the admin routes', async () => {
      assert.equal((await call('GET', '/admin/site/courses')).status, 401)
      for (const as of ['student', 'teacher']) {
         for (const [method, path, body] of [
            ['GET', '/admin/site/courses'],
            ['POST', '/admin/site/courses', { slug: `x-${suffix}`, subjectKey: 'biology', title: { ru: 'X' } }],
            ['GET', '/admin/site/settings'],
            ['PUT', '/admin/site/settings', { showStats: true }],
            ['PATCH', '/admin/site/videos/order', { ids: ['1'] }],
            ['POST', '/admin/site/events/1/publish'],
         ]) {
            const response = await call(method, path, { as, body })
            assert.equal(response.status, 403, `${as} ${method} ${path}`)
            assert.equal(response.body.error.code, 'ACTION_FORBIDDEN')
         }
         const upload = await call('POST', '/admin/site/images', { as, raw: pngBytes(10, 10), headers: { 'content-type': 'image/png' } })
         assert.equal(upload.status, 403)
      }
      assert.equal((await call('GET', '/admin/site/courses', { as: 'admin' })).status, 200)
   })

   let courseId
   await t.test('drafts stay private; published texts fall back to Russian per field', async () => {
      const jobsBefore = (await siteJobs()).length
      const created = await call('POST', '/admin/site/courses', {
         as: 'admin',
         body: {
            slug, subjectKey: 'physics', format: 'online',
            title: { ru: 'Алгебра', en: 'Algebra' },
            summary: { ru: 'Кратко' },
            topics: { ru: ['Уравнения'], en: [] },
            program: { ru: [{ title: 'Модуль 1', items: ['Тема 1'] }] },
            seo: { title: { ru: 'Алгебра — SEO' } },
         },
      })
      assert.equal(created.status, 201, JSON.stringify(created.body))
      courseId = created.body.data.id
      assert.equal(created.body.data.status, 'draft')
      assert.deepEqual(created.body.data.title, { ru: 'Алгебра', tj: null, en: 'Algebra' })
      assert.deepEqual(created.body.data.seo.title, { ru: 'Алгебра — SEO', tj: null, en: null })
      assert.equal((await siteJobs()).length, jobsBefore, 'a draft change queues no webhook')

      assert.equal((await call('GET', `/public/site/courses/${slug}`)).status, 404)
      assert.ok(!(await call('GET', '/public/site/courses')).body.data.courses.some((course) => course.slug === slug))

      const published = await call('POST', `/admin/site/courses/${courseId}/publish`, { as: 'admin' })
      assert.equal(published.status, 200)
      const jobs = await siteJobs()
      assert.equal(jobs.length, jobsBefore + 1)
      assert.deepEqual(jobs.at(-1).payload.tags, ['site', 'site:courses', `site:course:${slug}`])

      const en = (await call('GET', `/public/site/courses/${slug}?lang=en`)).body.data
      assert.equal(en.lang, 'en')
      assert.equal(en.title, 'Algebra')
      assert.equal(en.summary, 'Кратко')
      assert.deepEqual(en.topics, ['Уравнения'])
      assert.deepEqual(en.seo, { title: 'Алгебра — SEO', description: null })
      const tj = (await call('GET', `/public/site/courses/${slug}?lang=tj`)).body.data
      assert.equal(tj.lang, 'ru', 'no Tajik title: shown in Russian')
      assert.equal(tj.title, 'Алгебра')
      assert.equal((await call('GET', '/public/site/courses?lang=de')).status, 400)
      assert.equal((await call('GET', '/public/site/courses/no-such-course')).status, 404)
      assert.equal((await call('GET', '/public/site/courses/Not_A_Slug')).status, 404)

      const duplicate = await call('POST', '/admin/site/courses', { as: 'admin', body: { slug, subjectKey: 'physics', title: { ru: 'Дубль' } } })
      assert.equal(duplicate.status, 409)
      assert.equal(duplicate.body.error.code, 'SITE_COURSE_SLUG_CONFLICT')
      const noTitle = await call('POST', '/admin/site/courses', { as: 'admin', body: { slug: `t-${suffix}`, subjectKey: 'physics', title: { en: 'Only English' } } })
      assert.equal(noTitle.status, 400)
   })

   await t.test('Cache-Control and ETag on public reads', async () => {
      const first = await call('GET', '/public/site/courses')
      assert.match(first.headers.get('cache-control'), /public, max-age=\d+/)
      const etag = first.headers.get('etag')
      assert.ok(etag)
      // fetch adds Cache-Control: no-cache to a conditional request unless one is given.
      const second = await fetch(`${base}/public/site/courses`, { headers: { 'if-none-match': etag, 'cache-control': 'max-age=0' } })
      assert.equal(second.status, 304)
   })

   await t.test('video links and phones are validated', async () => {
      for (const url of ['https://evil.test/watch?v=dQw4w9WgXcQ', 'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ', 'not a url']) {
         const response = await call('POST', '/admin/site/videos', { as: 'admin', body: { url, title: { ru: 'Видео' } } })
         assert.equal(response.status, 400, url)
         assert.equal(response.body.error.details[0].field, 'url')
      }
      const video = await call('POST', '/admin/site/videos', {
         as: 'admin',
         body: { url: 'https://youtu.be/dQw4w9WgXcQ?si=x', title: { ru: 'Видео' }, placement: 'course', courseSlug: slug, duration: 'PT3M33S' },
      })
      assert.equal(video.status, 201, JSON.stringify(video.body))
      assert.equal(video.body.data.provider, 'youtube')
      assert.equal(video.body.data.url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
      const badPlacement = await call('POST', '/admin/site/videos', { as: 'admin', body: { url: 'https://vimeo.com/76979871', title: { ru: 'В' }, placement: 'course' } })
      assert.equal(badPlacement.status, 400)

      for (const phones of [[{ number: '+99290123' }], [{ number: 'abc' }], ['901234567']]) {
         assert.equal((await call('PUT', '/admin/site/settings', { as: 'admin', body: { phones } })).status, 400, JSON.stringify(phones))
      }
      assert.equal((await call('PUT', '/admin/site/settings', { as: 'admin', body: { whatsapp: '12' } })).status, 400)
      const saved = await call('PUT', '/admin/site/settings', {
         as: 'admin',
         body: {
            phones: [{ number: '90 123 45 67', label: { ru: 'Ресепшн', tj: 'Қабулгоҳ' } }, { number: '992901234568' }],
            whatsapp: '+992 90 123 45 67',
            telegram: '@everest_lc',
            hours: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], opens: '09:00', closes: '18:00' }],
            geo: { lat: 38.5598, lng: 68.787 },
            address: { ru: 'Душанбе, ул. Примерная 1' },
         },
      })
      assert.equal(saved.status, 200, JSON.stringify(saved.body))
      assert.deepEqual(saved.body.data.phones.map((phone) => phone.number), ['+992901234567', '+992901234568'])
      assert.deepEqual(saved.body.data.phones[0].label, { ru: 'Ресепшн', tj: 'Қабулгоҳ', en: null })
      assert.equal(saved.body.data.whatsapp, '+992901234567')
      assert.equal(saved.body.data.telegram, 'https://t.me/everest_lc')
      const pub = (await call('GET', '/public/site/settings?lang=tj')).body.data
      assert.equal(pub.phones[0].label, 'Қабулгоҳ')
      assert.equal(pub.address, 'Душанбе, ул. Примерная 1', 'falls back to Russian')
      assert.ok(pub.whatsappUrl.startsWith('https://wa.me/992901234567?text='))
      assert.equal(pub.stats.enabled, false)
   })

   await t.test('a failing webhook never breaks the save and is retried by the queue', async () => {
      const updated = await call('PATCH', `/admin/site/courses/${courseId}`, { as: 'admin', body: { summary: { ru: 'Новое описание' } } })
      assert.equal(updated.status, 200)
      const failing = createSiteRevalidationProvider({ url: 'https://site.test/api/revalidate', secret: 'shh' }, async () => {
         throw new TypeError('fetch failed')
      })
      const handlers = createSiteJobHandlers(failing)
      const workerId = `site-test-${suffix}`
      while (await runNextJob({ handlers, workerId, leaseSeconds: 30, repository: jobRepository, log: () => {} }));
      const jobs = await siteJobs()
      assert.ok(jobs.length >= 2)
      for (const job of jobs) {
         assert.equal(job.status, 'pending', 'scheduled for a retry')
         assert.equal(job.attempts, 1)
         assert.equal(job.last_error_code, 'SITE_REVALIDATE_FAILED')
      }
      assert.equal((await call('GET', `/public/site/courses/${slug}`)).body.data.summary, 'Новое описание')

      // Without SITE_REVALIDATE_URL / _SECRET nothing is queued and saving works.
      const quiet = createApp({
         telegramAuth: createTelegramAuthTestService({ config }).dependencies,
         authProtection: { config },
         site: { ...site, revalidateConfig: { url: null, secret: null } },
      })
      const quietServer = await new Promise((resolve) => {
         const listener = quiet.listen(0, '127.0.0.1', () => resolve(listener))
      })
      try {
         const before = (await siteJobs()).length
         const response = await fetch(`http://127.0.0.1:${quietServer.address().port}/api/v1/admin/site/courses/${courseId}`, {
            method: 'PATCH',
            headers: { authorization: `Bearer ${tokens.admin}`, 'content-type': 'application/json' },
            body: JSON.stringify({ summary: { en: 'Short' } }),
         })
         assert.equal(response.status, 200)
         assert.equal((await siteJobs()).length, before)
      } finally {
         await new Promise((resolve) => quietServer.close(resolve))
      }
   })

   await t.test('images: upload with size, absolute URL with alt, public redirect', async () => {
      const rejected = await call('POST', '/admin/site/images', { as: 'admin', raw: Buffer.from('not an image'), headers: { 'content-type': 'image/png' } })
      assert.equal(rejected.status, 422)
      assert.equal((await call('POST', '/admin/site/images', { as: 'admin', raw: Buffer.from('x'), headers: { 'content-type': 'image/gif' } })).status, 415)
      const upload = await call('POST', '/admin/site/images', { as: 'admin', raw: pngBytes(1200, 630), headers: { 'content-type': 'image/png', 'x-file-name': 'cover.png' } })
      assert.equal(upload.status, 201, JSON.stringify(upload.body))
      assert.equal(upload.body.data.width, 1200)
      assert.equal(upload.body.data.height, 630)
      const { assetId } = upload.body.data
      assert.equal((await call('PATCH', `/admin/site/courses/${courseId}`, { as: 'admin', body: { coverAssetId: '999999999' } })).status, 400)
      assert.equal((await call('PATCH', `/admin/site/courses/${courseId}`, { as: 'admin', body: { coverAssetId: assetId } })).status, 200)
      const course = (await call('GET', `/public/site/courses/${slug}?lang=en`)).body.data
      assert.deepEqual(course.cover, { url: `https://api.test/api/v1/public/site/images/${assetId}`, width: 1200, height: 630, alt: 'Algebra' })
      const image = await call('GET', `/public/site/images/${assetId}`)
      assert.equal(image.status, 302)
      assert.match(image.headers.get('location'), /^https:\/\/storage\.test\/signed\//)
      const lessonAsset = (await client.query(
         `INSERT INTO assets (storage_key, mime_type, size_bytes, status, kind) VALUES ($1, 'image/png', 64, 'ready', 'material') RETURNING id`,
         [`courses/1/materials/${suffix}.png`],
      )).rows[0].id
      assert.equal((await call('GET', `/public/site/images/${lessonAsset}`)).status, 404, 'a non-site asset is not served')
      assert.equal((await call('PATCH', `/admin/site/courses/${courseId}`, { as: 'admin', body: { coverAssetId: lessonAsset } })).status, 400)
   })

   await t.test('order, events and vacancies', async () => {
      const list = (await call('GET', '/admin/site/courses', { as: 'admin' })).body.data.items
      const reversed = list.map((item) => item.id).reverse()
      const reordered = await call('PATCH', '/admin/site/courses/order', { as: 'admin', body: { ids: reversed } })
      assert.equal(reordered.status, 200)
      assert.deepEqual(reordered.body.data.items.map((item) => item.id), reversed)
      assert.deepEqual(reordered.body.data.items.map((item) => item.order), reversed.map((_, index) => index + 1))
      assert.equal((await call('PATCH', '/admin/site/courses/order', { as: 'admin', body: { ids: reversed.slice(1) } })).status, 400)

      const event = await call('POST', '/admin/site/events', { as: 'admin', body: { type: 'open-lesson', title: { ru: 'Открытый урок' } } })
      assert.equal(event.status, 201)
      const early = await call('POST', `/admin/site/events/${event.body.data.id}/publish`, { as: 'admin' })
      assert.equal(early.status, 409)
      assert.equal(early.body.error.code, 'SITE_EVENT_START_REQUIRED')
      await call('PATCH', `/admin/site/events/${event.body.data.id}`, { as: 'admin', body: { startsAt: '2026-12-05T10:00', endsAt: '2026-12-05T12:00' } })
      assert.equal((await call('POST', `/admin/site/events/${event.body.data.id}/publish`, { as: 'admin' })).status, 200)
      const publicEvent = (await call('GET', '/public/site/events')).body.data.events[0]
      assert.equal(publicEvent.startsAt, '2026-12-05T10:00:00+05:00')
      assert.equal(publicEvent.type, 'open-lesson')

      const vacancy = await call('POST', '/admin/site/vacancies', {
         as: 'admin',
         body: { slug: `math-${suffix}`, employmentType: 'PART_TIME', salary: { min: 3000, currency: 'TJS' }, title: { ru: 'Преподаватель математики' } },
      })
      assert.equal(vacancy.status, 201, JSON.stringify(vacancy.body))
      await call('POST', `/admin/site/vacancies/${vacancy.body.data.id}/publish`, { as: 'admin' })
      const publicVacancy = (await call('GET', '/public/site/vacancies')).body.data.vacancies.find((item) => item.slug === `math-${suffix}`)
      assert.match(publicVacancy.datePosted, /^\d{4}-\d{2}-\d{2}$/, 'filled on publish')
      assert.deepEqual(publicVacancy.salary, { min: 3000, max: null, currency: 'TJS' })

      const removed = await call('DELETE', `/admin/site/vacancies/${vacancy.body.data.id}`, { as: 'admin' })
      assert.deepEqual(removed.body.data, { id: vacancy.body.data.id, status: 'deleted' })
      assert.equal((await call('GET', `/admin/site/vacancies/${vacancy.body.data.id}`, { as: 'admin' })).status, 404)
   })

   await client.query(`DELETE FROM background_jobs WHERE job_type = 'site.revalidate'`)
})
