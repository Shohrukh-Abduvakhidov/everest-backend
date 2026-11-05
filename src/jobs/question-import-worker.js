import env from '../configs/env.js'
import { processNextQuestionImportService } from '../services/question-import-upload-service.js'

// Started explicitly (npm run worker:imports), never by importing the app. Row claims use
// SKIP LOCKED and leases, so several PM2 processes can run this safely.
function startQuestionImportWorker({ intervalMs = env.questionImportWorkerIntervalMs, overrides, log = () => {} } = {}) {
   let stopped = false
   let timer = null
   let running = null

   async function tick() {
      try {
         // Drain the queue, then wait for the next interval.
         while (!stopped && await processNextQuestionImportService(overrides));
      } catch (error) {
         log('question import worker tick failed', { code: error.code })
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

export { startQuestionImportWorker }
