import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import pg from 'pg'

import env from '../../src/configs/env.js'
import { retryDelayMs, runNextJob } from '../../src/jobs/job-worker.js'
import * as jobRepository from '../../src/repositories/job-repository.js'
import { withTransaction } from '../../src/repositories/transaction-repository.js'

const { Client } = pg
const suffix = randomUUID().slice(0, 8)
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

test('background job queue (worker:jobs)', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   t.after(() => client.end())

   let typeIndex = 0
   const jobType = () => `qa.${suffix}.${(typeIndex += 1)}`
   const enqueue = (type, key, extra = {}) => withTransaction((tx) => jobRepository.enqueueJob({
      jobType: type, payload: { key }, dedupeKey: `qa:${suffix}:${key}`, ...extra,
   }, tx))
   const row = async (jobId) => (await client.query(
      `SELECT status, attempts, max_attempts, last_error_code, locked_by, lease_expires_at,
          available_at, finished_at, (available_at > CURRENT_TIMESTAMP) AS deferred
       FROM background_jobs WHERE id = $1`,
      [jobId],
   )).rows[0]
   const run = (handlers, workerId = `w-${suffix}`, extra = {}) => runNextJob({
      handlers, workerId, leaseSeconds: 30, repository: jobRepository, log: () => {}, ...extra,
   })

   await t.test('retry delay doubles from 30 s and stops at one hour', () => {
      assert.deepEqual([1, 2, 3, 4].map((attempt) => retryDelayMs(attempt)), [30000, 60000, 120000, 240000])
      assert.equal(retryDelayMs(20), 3600000)
   })

   await t.test('the same dedupe key is enqueued once', async () => {
      const type = jobType()
      const first = await enqueue(type, 'dedupe')
      const second = await enqueue(type, 'dedupe')
      assert.ok(first)
      assert.equal(second, null)
      const { rows } = await client.query('SELECT count(*)::integer AS count FROM background_jobs WHERE job_type = $1', [type])
      assert.equal(rows[0].count, 1)
   })

   await t.test('a rolled-back transaction leaves no job (outbox)', async () => {
      const type = jobType()
      await assert.rejects(withTransaction(async (tx) => {
         await jobRepository.enqueueJob({ jobType: type, payload: {}, dedupeKey: `qa:${suffix}:rollback` }, tx)
         throw new Error('domain change failed')
      }), /domain change failed/)
      const { rows } = await client.query('SELECT count(*)::integer AS count FROM background_jobs WHERE job_type = $1', [type])
      assert.equal(rows[0].count, 0)
   })

   await t.test('two workers never run the same job', async () => {
      const type = jobType()
      const ids = []
      for (let index = 0; index < 6; index += 1) ids.push(await enqueue(type, `concurrent-${index}`))
      const seen = []
      const handlers = {
         [type]: async (payload) => {
            seen.push(payload.key)
            await sleep(20)
         },
      }
      const drain = async (workerId) => { while (await run(handlers, workerId)); }
      await Promise.all([drain(`a-${suffix}`), drain(`b-${suffix}`)])
      assert.equal(seen.length, 6)
      assert.equal(new Set(seen).size, 6)
      for (const jobId of ids) {
         const job = await row(jobId)
         assert.equal(job.status, 'completed')
         assert.equal(job.attempts, 1)
         assert.equal(job.locked_by, null)
         assert.ok(job.finished_at)
      }
   })

   await t.test('a job whose worker died is taken over after its lease expires', async () => {
      const type = jobType()
      const jobId = await enqueue(type, 'lease')
      const claimed = await jobRepository.claimNextJob({ workerId: `dead-${suffix}`, leaseSeconds: 30, jobTypes: [type] })
      assert.equal(claimed.id, jobId)
      // Lease still valid: nobody else can take it.
      let ran = 0
      const handlers = { [type]: async () => { ran += 1 } }
      assert.equal(await run(handlers, `alive-${suffix}`), false)
      await client.query("UPDATE background_jobs SET lease_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = $1", [jobId])
      assert.equal(await run(handlers, `alive-${suffix}`), true)
      assert.equal(ran, 1)
      const job = await row(jobId)
      assert.equal(job.status, 'completed')
      assert.equal(job.attempts, 2)
      // The dead worker coming back cannot overwrite the result.
      assert.equal(await jobRepository.completeJob({ jobId, workerId: `dead-${suffix}` }), false)
      assert.equal(await jobRepository.failJob({ jobId, workerId: `dead-${suffix}`, errorCode: 'LATE', retryAt: null }), null)
   })

   await t.test('a running job extends its lease', async () => {
      const type = jobType()
      const jobId = await enqueue(type, 'heartbeat')
      let leaseAtStart = null
      let leaseLater = null
      await run({
         [type]: async () => {
            leaseAtStart = (await row(jobId)).lease_expires_at
            await sleep(1400)
            leaseLater = (await row(jobId)).lease_expires_at
         },
      }, `hb-${suffix}`, { leaseSeconds: 3 })
      const job = await row(jobId)
      assert.equal(job.status, 'completed')
      assert.ok(leaseLater > leaseAtStart, 'the heartbeat moved the lease forward')
   })

   await t.test('failures retry with backoff, then the job is failed (dead letter)', async () => {
      const type = jobType()
      const jobId = await enqueue(type, 'retry', { maxAttempts: 2 })
      const failing = { [type]: async () => { const error = new Error('secret detail'); error.code = 'BOOM'; throw error } }
      assert.equal(await run(failing), true)
      let job = await row(jobId)
      assert.equal(job.status, 'pending')
      assert.equal(job.attempts, 1)
      assert.equal(job.last_error_code, 'BOOM')
      assert.equal(job.deferred, true, 'retry is scheduled in the future')
      assert.equal(job.locked_by, null)
      // Not due yet.
      assert.equal(await run(failing), false)
      await client.query("UPDATE background_jobs SET available_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = $1", [jobId])
      assert.equal(await run(failing), true)
      job = await row(jobId)
      assert.equal(job.status, 'failed')
      assert.equal(job.attempts, 2)
      assert.ok(job.finished_at)
      const stored = await client.query('SELECT payload::text, last_error_code FROM background_jobs WHERE id = $1', [jobId])
      assert.equal(stored.rows[0].payload.includes('secret detail'), false)
   })

   await t.test('a permanent error fails the job at once; an unsafe code is replaced', async () => {
      const type = jobType()
      const permanentId = await enqueue(type, 'permanent')
      await run({ [type]: async () => { const error = new Error('x'); error.code = 'NOT_RETRYABLE'; error.permanent = true; throw error } })
      const permanent = await row(permanentId)
      assert.equal(permanent.status, 'failed')
      assert.equal(permanent.attempts, 1)
      assert.equal(permanent.last_error_code, 'NOT_RETRYABLE')

      const otherType = jobType()
      const unsafeId = await enqueue(otherType, 'unsafe')
      await run({ [otherType]: async () => { const error = new Error('x'); error.code = 'has spaces; DROP'; throw error } })
      assert.equal((await row(unsafeId)).last_error_code, 'JOB_FAILED')
   })

   await t.test('a running job past its last attempt and lease is marked failed', async () => {
      const type = jobType()
      const jobId = await enqueue(type, 'exhausted', { maxAttempts: 1 })
      await jobRepository.claimNextJob({ workerId: `dead-${suffix}`, leaseSeconds: 30, jobTypes: [type] })
      await client.query("UPDATE background_jobs SET lease_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = $1", [jobId])
      let ran = 0
      assert.equal(await run({ [type]: async () => { ran += 1 } }), false)
      assert.equal(ran, 0)
      const job = await row(jobId)
      assert.equal(job.status, 'failed')
      assert.equal(job.last_error_code, 'LEASE_EXPIRED')
   })

   await t.test('a deferred job waits for available_at', async () => {
      const type = jobType()
      const jobId = await enqueue(type, 'deferred', { availableAt: new Date(Date.now() + 3600000) })
      let ran = 0
      const handlers = { [type]: async () => { ran += 1 } }
      assert.equal(await run(handlers), false)
      await client.query("UPDATE background_jobs SET available_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = $1", [jobId])
      assert.equal(await run(handlers), true)
      assert.equal(ran, 1)
   })
})
