import pool from '../src/configs/db.js'
import {
   bulkPublishQuestionsService,
   resolveReviewerService,
} from '../src/services/question-bulk-review-service.js'
import { fail, finish, readArguments } from './bulk-review-cli.js'

// Usage:
//   npm run publish:questions -- --bank <code> --actor-phone +992... [--dry-run]
//     [--report <file>] [--batch-size <1-100>]
// Publishes draft questions with a verified key that pass the same check as the admin
// "publish" button. Questions that fail it are reported with a reason code, never published.
// Exit codes: 0 success, 1 failure.

const usage = 'Usage: npm run publish:questions -- --bank <code> --actor-phone +992... [--dry-run] '
   + '[--report <file>] [--batch-size <n>]'

try {
   const options = readArguments(process.argv.slice(2), usage)
   const actorId = await resolveReviewerService(options.actorPhone)
   const result = await bulkPublishQuestionsService(actorId, {
      bankCode: options.bankCode,
      batchSize: options.batchSize,
      dryRun: options.dryRun,
   }, { log: (message, details) => console.error(message, details) })
   await finish(options, result)
} catch (error) {
   fail('Bulk publication failed', error)
} finally {
   await pool.end()
}
