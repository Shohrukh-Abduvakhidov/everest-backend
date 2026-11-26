import pool from '../src/configs/db.js'
import { backfillAchievementsService } from '../src/services/achievement-service.js'

// Usage:
//   node scripts/backfill-achievements.js [--dry-run] [--user <id>]
//   node scripts/backfill-achievements.js --apply [--notify] [--user <id>]
//
// Awards the M13 achievements for activity before they existed (decisions.md 2026-11-26). The
// rules are the server's own (src/utils/achievement-rules.js over the learner's whole history),
// so a later live evaluation finds nothing more to award. Awards that exist are never touched;
// running it twice changes nothing.
//
// --dry-run (default) evaluates every candidate in READ ONLY transactions and prints who would
//   get what; nothing is written.
// --apply writes the awards, one transaction per learner. Without --notify no notification is
//   queued and the awards are marked seen (seen_at = now), so the frontend shows no
//   congratulation for old activity. With --notify each award queues achievement.unlocked
//   (worker:jobs delivers it) and stays unseen.
// --user <id> limits the run to one learner.
// Exit codes: 0 done, 1 failure.

const usage = 'Usage: node scripts/backfill-achievements.js [--dry-run | --apply [--notify]] [--user <id>]'

function readArguments(argv) {
   const options = { apply: false, notify: false, userIds: null }
   for (let index = 0; index < argv.length; index += 1) {
      const flag = argv[index]
      const value = argv[index + 1]
      if (flag === '--dry-run') options.apply = false
      else if (flag === '--apply') options.apply = true
      else if (flag === '--notify') options.notify = true
      else if (flag === '--user' && /^[1-9]\d{0,18}$/.test(value || '')) {
         options.userIds = [value]
         index += 1
      } else throw new Error(`Unknown argument ${flag}. ${usage}`)
   }
   if (options.notify && !options.apply) throw new Error(`--notify needs --apply. ${usage}`)
   return options
}

// The dry run never writes: every learner is evaluated in its own READ ONLY transaction that
// is rolled back.
async function readOnlyTransaction(callback) {
   const client = await pool.connect()
   try {
      await client.query('BEGIN READ ONLY')
      return await callback(client)
   } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
   }
}

function print(results, key) {
   for (const result of results) {
      const items = result[key]
      if (!items.length) continue
      console.log(`user ${result.userId}: ${items.map((item) => `${item.code} (${new Date(item.awardedAt).toISOString()})`).join(', ')}`)
   }
}

function countByCode(results, key) {
   const counts = new Map()
   for (const result of results) {
      for (const item of result[key]) counts.set(item.code, (counts.get(item.code) ?? 0) + 1)
   }
   return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right))
}

async function main() {
   const options = readArguments(process.argv.slice(2))
   const overrides = options.apply ? undefined : { transaction: readOnlyTransaction }
   const report = await backfillAchievementsService(options, overrides)
   const key = options.apply ? 'awarded' : 'planned'
   print(report.results, key)
   const total = report.results.reduce((sum, result) => sum + result[key].length, 0)
   const learners = report.results.filter((result) => result[key].length).length
   console.log('')
   for (const [code, count] of countByCode(report.results, key)) console.log(`${code}: ${count}`)
   if (!options.apply) {
      console.log(`\nDry run: ${report.candidates} learner(s) checked; ${total} award(s) for ${learners} learner(s) would be written; nothing was changed.`)
      if (total) console.log('Run with --apply (optionally --notify) to write them.')
      return
   }
   console.log(`\nApplied: ${total} award(s) for ${learners} learner(s) written`
      + (options.notify ? ', notifications queued.' : ', marked seen, no notifications.'))
}

try {
   await main()
} catch (error) {
   console.error(error.message)
   process.exitCode = 1
} finally {
   await pool.end()
}
