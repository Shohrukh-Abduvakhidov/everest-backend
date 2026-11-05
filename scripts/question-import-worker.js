import pool from '../src/configs/db.js'
import { startQuestionImportWorker } from '../src/jobs/question-import-worker.js'

// Background runner for packages confirmed over HTTP. Output has ids and codes only.
const log = (message, details) => console.log(message, details)
const worker = startQuestionImportWorker({ overrides: { log }, log })
console.log('Question import worker started')

async function shutdown(signal) {
   console.log(`Received ${signal}; stopping the question import worker`)
   await worker.stop()
   await pool.end()
}

process.once('SIGTERM', () => shutdown('SIGTERM'))
process.once('SIGINT', () => shutdown('SIGINT'))
