import pool from '../src/configs/db.js'
import { startAttemptSweepWorker } from '../src/jobs/attempt-sweep-worker.js'

// Background runner that submits expired attempts. Output has codes only.
const worker = startAttemptSweepWorker({ log: (message, details) => console.log(message, details) })
console.log('Attempt sweep worker started')

async function shutdown(signal) {
   console.log(`Received ${signal}; stopping the attempt sweep worker`)
   await worker.stop()
   await pool.end()
}

process.once('SIGTERM', () => shutdown('SIGTERM'))
process.once('SIGINT', () => shutdown('SIGINT'))
