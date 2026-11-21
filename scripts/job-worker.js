import pool from '../src/configs/db.js'
import { startJobWorker } from '../src/jobs/job-worker.js'
import { notificationJobHandlers } from '../src/services/notification-service.js'

// General background job runner (background_jobs): notification fan-out now, Telegram delivery
// and scheduled reminders in later PRs. Output has codes only, never payloads.
const worker = startJobWorker({
   handlers: { ...notificationJobHandlers },
   log: (message, details) => console.log(message, details),
})
console.log('Job worker started', { workerId: worker.workerId })

async function shutdown(signal) {
   console.log(`Received ${signal}; stopping the job worker`)
   await worker.stop()
   await pool.end()
}

process.once('SIGTERM', () => shutdown('SIGTERM'))
process.once('SIGINT', () => shutdown('SIGINT'))
