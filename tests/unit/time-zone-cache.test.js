import assert from 'node:assert/strict'
import test from 'node:test'

import { createTimeZoneCache, dayMs } from '../../src/utils/time-zone-cache.js'

function fixture(lists) {
   let now = 0
   let loads = 0
   const cache = createTimeZoneCache({
      load: async () => {
         const next = lists[Math.min(loads, lists.length - 1)]
         loads += 1
         if (next instanceof Error) throw next
         return next
      },
      clock: () => now,
   })
   return {
      cache,
      loads: () => loads,
      advance: (ms) => { now += ms },
   }
}

test('time zone cache', async (t) => {
   await t.test('accepts a listed zone and rejects an unlisted one', async () => {
      const { cache } = fixture([['UTC', 'Asia/Dushanbe']])
      assert.equal(await cache.has('Asia/Dushanbe'), true)
      assert.equal(await cache.has('Nowhere/Zone'), false)
      assert.equal(await cache.has('asia/dushanbe'), false)
      assert.equal(await cache.has('+05:00'), false)
      assert.equal(await cache.has(''), false)
      assert.equal(await cache.has(null), false)
   })

   await t.test('loads on the first lookup only, then once a day', async () => {
      const { cache, loads, advance } = fixture([['UTC'], ['UTC', 'Asia/Dushanbe']])
      assert.equal(loads(), 0)
      assert.equal(await cache.has('Asia/Dushanbe'), false)
      await cache.has('UTC')
      advance(dayMs - 1)
      await cache.has('UTC')
      assert.equal(loads(), 1)
      advance(1)
      assert.equal(await cache.has('Asia/Dushanbe'), true)
      assert.equal(loads(), 2)
   })

   await t.test('concurrent first lookups share one load', async () => {
      const { cache, loads } = fixture([['UTC']])
      const results = await Promise.all(Array.from({ length: 5 }, () => cache.has('UTC')))
      assert.deepEqual(results, [true, true, true, true, true])
      assert.equal(loads(), 1)
   })

   await t.test('a failed reload keeps the old list and retries on the next lookup', async () => {
      const { cache, loads, advance } = fixture([['UTC'], new Error('db down'), ['UTC', 'Asia/Dushanbe']])
      await cache.has('UTC')
      advance(dayMs)
      assert.equal(await cache.has('UTC'), true)
      assert.equal(loads(), 2)
      assert.equal(await cache.has('Asia/Dushanbe'), true)
      assert.equal(loads(), 3)
   })

   await t.test('a failed first load is thrown', async () => {
      const { cache } = fixture([new Error('db down'), ['UTC']])
      await assert.rejects(cache.has('UTC'), /db down/)
      assert.equal(await cache.has('UTC'), true)
   })
})
