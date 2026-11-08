import pool from '../src/configs/db.js'
import {
   bulkVerifyAnswerKeysService,
   resolveReviewerService,
} from '../src/services/question-bulk-review-service.js'
import { loadExcludeFile } from '../src/utils/exclude-file.js'
import { fail, finish, readArguments } from './bulk-review-cli.js'

// Usage:
//   npm run verify:keys -- --bank <code> --actor-phone +992... [--dry-run]
//     [--only-source <official_key|expert_review>] [--exclude <file.json>] [--report <file>]
//     [--batch-size <1-100>]
// Moves proposed keys of draft questions to verified through the same service as the admin
// "verify key" button. Exit codes: 0 success, 1 failure.

const usage = 'Usage: npm run verify:keys -- --bank <code> --actor-phone +992... [--dry-run] '
   + '[--only-source <keySource>] [--exclude <file.json>] [--report <file>] [--batch-size <n>]'

try {
   const options = readArguments(process.argv.slice(2), usage, {
      '--only-source': 'onlySource',
      '--exclude': 'excludePath',
   })
   const exclude = options.excludePath ? await loadExcludeFile(options.excludePath) : []
   const actorId = await resolveReviewerService(options.actorPhone)
   const result = await bulkVerifyAnswerKeysService(actorId, {
      bankCode: options.bankCode,
      batchSize: options.batchSize,
      dryRun: options.dryRun,
      onlySource: options.onlySource,
      exclude,
   }, { log: (message, details) => console.error(message, details) })
   await finish(options, result, { onlySource: result.onlySource, exclude: result.exclude })
} catch (error) {
   fail('Bulk key verification failed', error)
} finally {
   await pool.end()
}
