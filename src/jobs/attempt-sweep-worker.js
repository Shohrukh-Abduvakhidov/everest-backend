import env from '../configs/env.js'
import { expireNextAbandonedUploadService } from '../services/asset-upload-service.js'
import { finalizeNextExpiredAttemptService } from '../services/test-attempt-service.js'

// Repeats one step until it reports nothing left, then waits intervalMs. Errors are logged
// by code only and the loop goes on.
function startLoop(step, intervalMs, label, log) {
   let stopped = false
   let timer = null
   let running = null

   async function tick() {
      try {
         while (!stopped && await step());
      } catch (error) {
         log(`${label} tick failed`, { code: error.code })
      }
      if (!stopped) timer = setTimeout(() => { running = tick() }, intervalMs)
   }

   running = tick()
   return async () => {
      stopped = true
      clearTimeout(timer)
      await running
   }
}

// Started explicitly (npm run worker:attempts), never by importing the app. Row claims use
// SKIP LOCKED, so several PM2 processes can run this safely. The same worker expires
// abandoned asset uploads (aborts them in storage) when sweepUploads is set.
function startAttemptSweepWorker({
   intervalMs = env.attemptSweepIntervalMs,
   uploadIntervalMs = env.storage.uploadSweepIntervalMs,
   sweepUploads = false,
   overrides,
   log = () => {},
} = {}) {
   const stops = [
      startLoop(() => finalizeNextExpiredAttemptService({}, overrides), intervalMs, 'attempt sweep', log),
   ]
   if (sweepUploads) {
      stops.push(startLoop(() => expireNextAbandonedUploadService(overrides), uploadIntervalMs, 'upload sweep', log))
   }
   return {
      async stop() {
         await Promise.all(stops.map((stop) => stop()))
      },
   }
}

export { startAttemptSweepWorker }
