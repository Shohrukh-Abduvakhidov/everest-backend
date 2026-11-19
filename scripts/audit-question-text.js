import { writeFile } from 'node:fs/promises'

import pool from '../src/configs/db.js'
import { auditQuestion } from '../src/utils/question-text-audit.js'
import { loadQuestions } from './question-text-data.js'

// Usage:
//   node scripts/audit-question-text.js [--bank <code>] [--json <file>] [--examples <n>]
// Read-only. Walks every question of every bank (or one bank) and reports damaged text:
// words split across table cells, stray letters, empty cells, uneven rows, double spaces,
// spaces before punctuation, replacement/control/invisible characters, duplicate options and
// missing or broken answer keys. Prints a summary per bank and finding type; --json writes
// the full report. Runs inside a READ ONLY transaction. Exit codes: 0 done, 1 failure.

const usage = 'Usage: node scripts/audit-question-text.js [--bank <code>] [--json <file>] [--examples <n>]'

function readArguments(argv) {
   const options = { bankCode: null, jsonPath: null, examples: 3 }
   for (let index = 0; index < argv.length; index += 1) {
      const flag = argv[index]
      const value = argv[index + 1]
      if (flag === '--bank' && value) options.bankCode = value
      else if (flag === '--json' && value) options.jsonPath = value
      else if (flag === '--examples' && /^[0-9]+$/.test(value ?? '')) options.examples = Number(value)
      else throw new Error(usage)
      index += 1
   }
   return options
}

function summarize(questions) {
   const banks = {}
   for (const question of questions) {
      banks[question.bankCode] ||= { questions: 0, withFindings: 0, types: {} }
      const bank = banks[question.bankCode]
      bank.questions += 1
      const findings = auditQuestion(question)
      if (findings.length) bank.withFindings += 1
      for (const finding of findings) {
         bank.types[finding.type] ||= { count: 0, questionIds: [], examples: [] }
         const entry = bank.types[finding.type]
         entry.count += 1
         if (!entry.questionIds.includes(question.id)) entry.questionIds.push(question.id)
         entry.examples.push({
            questionId: question.id,
            externalId: question.externalId,
            status: question.status,
            attemptUses: question.attemptUses,
            path: finding.path,
            sample: finding.sample,
            ...(finding.fix !== undefined ? { autoFix: finding.fix, reason: finding.reason } : {}),
         })
      }
   }
   return banks
}

function printSummary(banks, examples) {
   for (const [bankCode, bank] of Object.entries(banks)) {
      console.log(`\n${bankCode}: ${bank.questions} questions, ${bank.withFindings} with findings`)
      const types = Object.entries(bank.types).sort(([, left], [, right]) => right.count - left.count)
      if (!types.length) console.log('   no findings')
      for (const [type, entry] of types) {
         const ids = entry.questionIds.slice(0, 15).join(', ') + (entry.questionIds.length > 15 ? ', …' : '')
         console.log(`   ${type}: ${entry.count} in ${entry.questionIds.length} questions [${ids}]`)
         for (const example of entry.examples.slice(0, examples)) {
            console.log(`      #${example.questionId} ${example.path}: ${JSON.stringify(example.sample)}`)
         }
      }
   }
}

let client
try {
   const options = readArguments(process.argv.slice(2))
   client = await pool.connect()
   await client.query('BEGIN READ ONLY')
   const questions = await loadQuestions(client, { bankCode: options.bankCode })
   await client.query('COMMIT')
   const banks = summarize(questions)
   printSummary(banks, options.examples)
   if (options.jsonPath) {
      await writeFile(options.jsonPath, `${JSON.stringify({
         generatedAt: new Date().toISOString(),
         bankCode: options.bankCode,
         banks,
      }, null, 2)}\n`)
      console.log(`\nFull report: ${options.jsonPath}`)
   }
} catch (error) {
   if (client) await client.query('ROLLBACK').catch(() => {})
   console.error('Question text audit failed', { code: error.code, message: error.message })
   process.exitCode = 1
} finally {
   client?.release()
   await pool.end()
}
