import { writeFile } from 'node:fs/promises'

// Argument parsing and output shared by verify-answer-keys.js and publish-questions.js.
// Output contains counts and codes only; question text and key values are never printed.

function readArguments(argv, usage, extra = {}) {
   const options = { dryRun: false }
   for (let index = 0; index < argv.length; index += 1) {
      const name = argv[index]
      const value = () => {
         const next = argv[index + 1]
         if (next === undefined || next.startsWith('--')) throw new Error(`${name} needs a value. ${usage}`)
         index += 1
         return next
      }
      if (name === '--bank') options.bankCode = value()
      else if (name === '--actor-phone') options.actorPhone = value()
      else if (name === '--batch-size') options.batchSize = Number(value())
      else if (name === '--report') options.reportPath = value()
      else if (name === '--dry-run') options.dryRun = true
      else if (extra[name]) options[extra[name]] = value()
      else throw new Error(`Unknown argument ${name}. ${usage}`)
   }
   if (!options.bankCode || !options.actorPhone) throw new Error(usage)
   return options
}

function summary(result, extra = {}) {
   return {
      mode: result.mode,
      status: result.status,
      runId: result.runId,
      bankCode: result.bankCode,
      ...extra,
      counters: result.counters,
      errors: result.errors.map(({ code, questionId, externalId }) => ({ code, questionId, externalId })),
   }
}

async function finish(options, result, extra) {
   if (options.reportPath) await writeFile(options.reportPath, JSON.stringify(result, null, 2))
   console.log(JSON.stringify(summary(result, extra), null, 2))
   if (result.status === 'failed') process.exitCode = 1
}

function fail(label, error) {
   console.error(label, { code: error.code || 'BULK_FAILED', message: error.message })
   process.exitCode = 1
}

export { fail, finish, readArguments }
