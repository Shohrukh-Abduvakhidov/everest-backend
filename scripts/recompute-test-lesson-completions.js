import pool from '../src/configs/db.js'
import { withTransaction } from '../src/repositories/transaction-repository.js'
import { completeMissedTestLessonsService } from '../src/services/lesson-completion-service.js'

// Usage:
//   node scripts/recompute-test-lesson-completions.js [--dry-run] [--lesson <id>]
//   node scripts/recompute-test-lesson-completions.js --apply [--lesson <id>]
//
// Completes the lessons with a test that a finished attempt should have completed but did not:
// attempts finished before the completion rule existed (2026-11-07) or before the lesson was
// linked to the test. The rule is the server's own (attemptCompletesLesson in
// src/services/lesson-completion-service.js): a finished attempt; with passPercent in the
// attempt's snapshot it must reach it; an attempt closed by the timer without one saved answer
// never completes. The earliest such attempt sets completed_at. Lessons already completed are
// never touched and nothing is ever moved back, so running it twice changes nothing.
//
// --dry-run (default) lists what would change in a READ ONLY transaction and changes nothing.
// --apply writes lesson_progress and the lesson_completed activity events in ONE transaction.
// Exit codes: 0 done, 1 failure.

const usage = 'Usage: node scripts/recompute-test-lesson-completions.js [--dry-run | --apply] [--lesson <id>]'

function readArguments(argv) {
   const options = { apply: false, lessonId: null }
   for (let index = 0; index < argv.length; index += 1) {
      const flag = argv[index]
      const value = argv[index + 1]
      if (flag === '--dry-run') options.apply = false
      else if (flag === '--apply') options.apply = true
      else if (flag === '--lesson' && /^[1-9]\d{0,18}$/.test(value || '')) {
         options.lessonId = value
         index += 1
      } else throw new Error(`Unknown argument ${flag}. ${usage}`)
   }
   return options
}

async function dryRun(lessonId) {
   const client = await pool.connect()
   try {
      await client.query('BEGIN READ ONLY')
      return await completeMissedTestLessonsService({ lessonId, apply: false }, client)
   } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
   }
}

function print(items) {
   for (const item of items) {
      console.log(`lesson ${item.lessonId}  user ${item.userId}  test ${item.testId}  `
         + `attempt ${item.attemptId}  completed_at ${new Date(item.completedAt).toISOString()}`)
   }
}

async function main() {
   const options = readArguments(process.argv.slice(2))
   if (!options.apply) {
      const planned = await dryRun(options.lessonId)
      print(planned)
      console.log(`\nDry run: ${planned.length} lesson completion(s) would be written; nothing was changed.`)
      if (planned.length) console.log('Run with --apply to write them.')
      return
   }
   const written = await withTransaction((client) => completeMissedTestLessonsService(
      { lessonId: options.lessonId, apply: true },
      client,
   ))
   print(written)
   console.log(`\nApplied: ${written.length} lesson completion(s) written.`)
}

try {
   await main()
} catch (error) {
   console.error(error.message)
   process.exitCode = 1
} finally {
   await pool.end()
}
