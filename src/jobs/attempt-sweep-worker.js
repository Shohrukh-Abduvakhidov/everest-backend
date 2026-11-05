import env from '../configs/env.js'
import { finalizeNextExpiredAttemptService } from '../services/test-attempt-service.js'

// Started explicitly (npm run worker:attempts), never by importing the app. Row claims use
// SKIP LOCKED, so several PM2 processes can run this safely.
function startAttemptSweepWorker({ intervalMs = env.attemptSweepIntervalMs, overrides, log = () => {} } = {}) {
   let stopped = false
   let timer = null
   let running = null

   async function tick() {
      try {
         while (!stopped && await finalizeNextExpiredAttemptService({}, overrides));
      } catch (error) {
         log('attempt sweep tick failed', { code: error.code })
      }
      if (!stopped) timer = setTimeout(() => { running = tick() }, intervalMs)
   }

   running = tick()
   return {
      async stop() {
         stopped = true
         clearTimeout(timer)
         await running
      },
   }
}

export { startAttemptSweepWorker }
