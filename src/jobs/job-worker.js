import { randomUUID } from 'node:crypto'
import os from 'node:os'

import env from '../configs/env.js'
import * as jobRepository from '../repositories/job-repository.js'

// Backoff after a failed attempt n (1-based): 30 s · 2^(n-1), at most one hour.
function retryDelayMs(attempt, baseMs = 30000) {
   return Math.min(baseMs * 2 ** Math.max(attempt - 1, 0), 3600000)
}

// Runs one due job. Returns true when a job was processed (so the loop drains the queue).
// A handler error with permanent: true fails the job at once; any other error retries it with
// backoff until max_attempts, then the job stays failed (dead letter). Only error codes are
// stored and logged, never messages or payloads.
async function runNextJob({ handlers, workerId, leaseSeconds, repository, log, now = () => new Date() }) {
   await repository.failExhaustedLeases()
   const job = await repository.claimNextJob({ workerId, leaseSeconds, jobTypes: Object.keys(handlers) })
   if (!job) return false
   const heartbeat = setInterval(() => {
      repository.extendJobLease({ jobId: job.id, workerId, leaseSeconds })
         .catch((error) => log('job lease extension failed', { jobId: job.id, code: error.code }))
   }, Math.max(leaseSeconds * 1000 / 3, 1000))
   heartbeat.unref?.()
   try {
      await handlers[job.job_type](job.payload, { job, now })
      await repository.completeJob({ jobId: job.id, workerId })
   } catch (error) {
      const errorCode = typeof error.code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(error.code)
         ? error.code
         : 'JOB_FAILED'
      const retryAt = error.permanent ? null : new Date(now().getTime() + retryDelayMs(job.attempts))
      const status = await repository.failJob({ jobId: job.id, workerId, errorCode, retryAt })
      log('job failed', { jobId: job.id, jobType: job.job_type, attempt: job.attempts, code: errorCode, status })
   } finally {
      clearInterval(heartbeat)
   }
   return true
}

// Started explicitly (npm run worker:jobs), never by importing the app. Claims use SKIP LOCKED
// and leases, so several processes can run it; a job whose worker died is picked up again
// when its lease expires.
function startJobWorker({
   handlers,
   intervalMs = env.jobWorkerIntervalMs,
   leaseSeconds = env.jobLeaseSeconds,
   workerId = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
   repository = jobRepository,
   log = () => {},
} = {}) {
   let stopped = false
   let timer = null
   let running = null

   async function tick() {
      try {
         while (!stopped && await runNextJob({ handlers, workerId, leaseSeconds, repository, log }));
      } catch (error) {
         log('job worker tick failed', { code: error.code })
      }
      if (!stopped) timer = setTimeout(() => { running = tick() }, intervalMs)
   }

   running = tick()
   return {
      workerId,
      async stop() {
         stopped = true
         clearTimeout(timer)
         await running
      },
   }
}

export { retryDelayMs, runNextJob, startJobWorker }
