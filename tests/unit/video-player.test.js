import assert from 'node:assert/strict'
import test from 'node:test'

import { createS3StorageProvider } from '../../src/providers/storage/s3-storage-provider.js'
import { playbackSigning } from '../../src/services/lesson-service.js'
import { computeLease, deriveContentKey } from '../../src/services/offline-license-service.js'
import { saveLessonProgressService } from '../../src/services/learner-lesson-service.js'
import { mergeRanges, normalizeRanges, totalSeconds } from '../../src/utils/watched-ranges.js'
import { maskPhone, watermarkLabel } from '../../src/utils/watermark.js'

const hour = 60 * 60 * 1000
const day = 24 * hour

test('watched ranges merge overlaps and count unique seconds', () => {
   assert.deepEqual(mergeRanges([[0, 10], [20, 30]], [[5, 22], [30, 31], [40, 41]]), [[0, 31], [40, 41]])
   assert.equal(totalSeconds(mergeRanges([[0, 10]], [[0, 10]], [[5, 10]])), 10)
   // A seek to the end adds only what was played there.
   assert.equal(totalSeconds(mergeRanges([[0, 5]], [[95, 100]])), 10)
   assert.deepEqual(normalizeRanges([[80, 120]], 100), [[80, 100]])
   assert.deepEqual(normalizeRanges([[150, 160]], 100), [])
   for (const bad of [[[5, 5]], [[6, 5]], [[-1, 2]], [[0, 1.5]], [[0]], 'x', Array.from({ length: 51 }, () => [0, 1])]) {
      assert.equal(normalizeRanges(bad, 100), null, JSON.stringify(bad))
   }
})

test('watermark shows a first name and a masked phone only', () => {
   assert.equal(maskPhone('+992901234545'), '+992 *** 45')
   assert.equal(maskPhone('+79161234567'), '+7 *** 67')
   assert.equal(maskPhone('12345'), null)
   assert.equal(watermarkLabel({ first_name: ' Али ', phone_e164: '+992901234545' }, '7'), 'Али +992 *** 45')
   assert.equal(watermarkLabel({ first_name: null, phone_e164: null }, '7'), 'ID 7')
   assert.equal(watermarkLabel({ first_name: 'A‮B', phone_e164: null }, '7'), 'AB')
})

test('playback signing is stable inside a window and changes after it', () => {
   const window = 6 * 60 * 60
   const ttl = 2 * 60 * 60
   const start = new Date('2026-11-13T06:00:00.000Z')
   const early = playbackSigning(new Date(start.getTime() + 1000), window, ttl)
   const late = playbackSigning(new Date(start.getTime() + window * 1000 - 1), window, ttl)
   const next = playbackSigning(new Date(start.getTime() + window * 1000), window, ttl)
   assert.equal(early.signingDate.toISOString(), start.toISOString())
   assert.equal(late.signingDate.toISOString(), start.toISOString())
   assert.equal(next.signingDate.getTime(), start.getTime() + window * 1000)
   assert.equal(early.expiresIn, window + ttl)
   assert.equal(early.cacheControl, `private, max-age=${window + ttl}`)
   // Issued at the very end of a window, the URL still lives the TTL.
   assert.equal(late.expiresAt.getTime() - (start.getTime() + window * 1000 - 1), ttl * 1000 + 1)
})

test('real S3 presigner returns the same URL for one window and signs only host', async () => {
   const storage = createS3StorageProvider({
      endpoint: 'http://storage.invalid:8333',
      publicEndpoint: 'https://files.example.test',
      region: 'us-east-1',
      bucket: 'everest',
      accessKeyId: 'test-key',
      secretAccessKey: 'test-secret',
      forcePathStyle: true,
   })
   const window = 21600
   const sign = (now) => {
      const signing = playbackSigning(now, window, 7200)
      return storage.presignDownload({
         key: 'courses/1/videos/a.mp4',
         expiresIn: signing.expiresIn,
         contentType: 'video/mp4',
         disposition: 'inline',
         signingDate: signing.signingDate,
         cacheControl: signing.cacheControl,
      })
   }
   const base = Date.parse('2026-11-13T00:00:00.000Z')
   const first = await sign(new Date(base + 10 * 1000))
   const second = await sign(new Date(base + 5 * hour))
   const after = await sign(new Date(base + window * 1000 + 1000))
   assert.equal(first, second)
   assert.notEqual(first, after)
   const url = new URL(first)
   assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'host')
   assert.equal(url.searchParams.get('response-cache-control'), `private, max-age=${window + 7200}`)
   assert.equal(url.searchParams.get('X-Amz-Expires'), String(window + 7200))
   assert.equal(url.searchParams.get('X-Amz-Date'), '20261113T000000Z')
})

test('offline content keys are deterministic and differ per user, device, video and license', () => {
   const secret = 'a-test-secret-that-is-longer-than-32-chars'
   const identity = { userId: '1', deviceKey: '6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7', assetId: '5', licenseId: '9' }
   const key = deriveContentKey(secret, identity)
   assert.equal(key.length, 32)
   assert.deepEqual(deriveContentKey(secret, { ...identity }), key)
   for (const change of [{ userId: '2' }, { deviceKey: '7a2b3c4d-5e6f-4a71-8b82-a3c4d5e6f708' }, { assetId: '6' }, { licenseId: '10' }]) {
      assert.notDeepEqual(deriveContentKey(secret, { ...identity, ...change }), key, JSON.stringify(change))
   }
   assert.notDeepEqual(deriveContentKey(`${secret}x`, identity), key)
})

test('offline lease uses the configured days and never outlives the access grants', () => {
   const now = new Date('2026-11-13T00:00:00.000Z')
   assert.equal(computeLease(now, {}, 14).getTime(), now.getTime() + 14 * day)
   const grant = new Date(now.getTime() + 3 * day)
   assert.equal(computeLease(now, { grant_expires_at: grant }, 14).getTime(), grant.getTime())
   const enrollment = new Date(now.getTime() + day)
   assert.equal(computeLease(now, { grant_expires_at: grant, enrollment_expires_at: enrollment }, 14).getTime(), enrollment.getTime())
})

test('progress reports are throttled and complete only at 90 percent unique time', async () => {
   const lesson = { id: '3', module_id: '2', course_id: '1', video_asset_id: '4', test_id: null }
   let row = null
   const writes = []
   const watch = []
   const completions = []
   const transactionClient = { fake: true }
   const overrides = {
      progressMinIntervalSeconds: 10,
      transaction: async (work) => work(transactionClient),
      activity: {
         addWatchSeconds: async (values, db) => {
            assert.equal(db, transactionClient)
            watch.push(values.seconds)
         },
         recordActivityEvent: async (event, db) => {
            assert.equal(db, transactionClient)
            completions.push(event.sourceEventKey)
         },
      },
      requireAccess: async () => {},
      repository: { findAsset: async () => ({ duration_seconds: 100 }) },
      learner: {
         findLearnerLesson: async () => lesson,
         findProgress: async () => row,
         writeProgress: async (progress) => {
            writes.push(progress)
            row = {
               status: progress.status,
               playback_seconds: progress.playbackSeconds,
               watched_seconds: progress.watchedSeconds,
               watched_ranges: progress.watchedRanges,
               completed_at: progress.completed ? new Date() : null,
               revision: progress.revision + 1,
               seconds_since_report: 0,
            }
            return row
         },
      },
   }
   const save = (body) => saveLessonProgressService('5', '1', '3', body, overrides)
   const first = await save({ revision: 0, playbackSeconds: 99, watchedSeconds: 99, watchedRanges: [[0, 5], [95, 100]] })
   assert.equal(first.progress.status, 'in_progress')
   await assert.rejects(save({ revision: 1, playbackSeconds: 20, watchedRanges: [[5, 20]] }), { code: 'PROGRESS_TOO_FREQUENT', status: 429 })
   row.seconds_since_report = 9.5
   await assert.rejects(save({ revision: 1, playbackSeconds: 20, watchedRanges: [[5, 20]] }), { code: 'PROGRESS_TOO_FREQUENT' })
   row.seconds_since_report = 10
   const middle = await save({ revision: 1, playbackSeconds: 85, watchedRanges: [[5, 84]] })
   assert.equal(middle.progress.status, 'in_progress')
   assert.equal(middle.progress.watchedSeconds, 89)
   row.seconds_since_report = 12
   const done = await save({ revision: 2, playbackSeconds: 90, watchedRanges: [[84, 85]] })
   assert.equal(done.progress.status, 'completed')
   assert.equal(writes.length, 3)
   assert.ok(writes.every((write) => write.reported === true))
   // Only the growth of unique watched time is recorded, and completion once.
   assert.deepEqual(watch, [10, 79, 1])
   assert.deepEqual(completions, ['lesson_completed:3'])
})
