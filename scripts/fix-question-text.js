import { readFile, writeFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'

import pool from '../src/configs/db.js'
import { loadIntegritySnapshot, loadQuestions } from './question-text-data.js'
import { planChanges as planQuestionChanges } from './question-text-plan.js'

// Usage:
//   node scripts/fix-question-text.js [--dry-run] [--bank <code>] [--log <file|->]
//   node scripts/fix-question-text.js --apply --log <file|-> [--bank <code>]
//   node scripts/fix-question-text.js --rollback <log.json> [--log <file|->]
//
// Repairs damaged question text left by PDF extraction, only where the repair is certain
// (utils/question-text-audit.js): a letter stranded between matching column headers
// ("Тоҷикистон С | оли" -> "Тоҷикистон | Соли") and a capital cut off a short item
// ("З анбӯруғҳо" -> "Занбӯруғҳо"). Cosmetic spacing everywhere: double spaces collapsed, no space
// before , . ; : ! ? ). A word cut by a line-end hyphen ("электро- магнитӣ") is joined only in
// the questions listed in question-text-plan.js; the questions excluded there are never changed.
// Everything else the audit still finds after the changes is printed for manual review.
//
// --dry-run (default) prints before/after in a READ ONLY transaction and changes nothing.
// --apply changes question, option and matching-item content in ONE transaction and writes a
//    log with every changed row and its old value. --log is required: without it there is no
//    rollback. "-" writes the log JSON to stdout (messages go to stderr).
// --rollback restores the old values from such a log, only where the current value is still
//    the value the fix wrote.
//
// Only content JSON changes. Ids, option/item keys and positions, answer keys, test links,
// attempt orders, grading snapshots and student answers are compared before and after inside
// the transaction; any difference rolls everything back. Published questions are immutable
// by trigger, so the three content guards are disabled inside the transaction only (as in
// migration 20261109010000000) and enabled again before COMMIT. Needs the table owner role
// (the application role that runs migrations). Exit codes: 0 done, 1 failure.

const usage = 'Usage: node scripts/fix-question-text.js [--dry-run | --apply | --rollback <log.json>] '
   + '[--bank <code>] [--log <file|->]'

const tables = {
   question: { table: 'questions', guard: 'questions_guard', touch: true },
   option: { table: 'question_options', guard: 'question_options_guard', touch: false },
   matching: { table: 'question_matching_items', guard: 'question_matching_guard', touch: false },
}

function readArguments(argv) {
   const options = { mode: 'dry-run', bankCode: null, logPath: null, rollbackPath: null }
   for (let index = 0; index < argv.length; index += 1) {
      const flag = argv[index]
      const value = argv[index + 1]
      if (flag === '--dry-run') options.mode = 'dry-run'
      else if (flag === '--apply') options.mode = 'apply'
      else if (flag === '--rollback' && value) {
         options.mode = 'rollback'
         options.rollbackPath = value
         index += 1
      } else if (flag === '--bank' && value) {
         options.bankCode = value
         index += 1
      } else if (flag === '--log' && value) {
         options.logPath = value
         index += 1
      } else throw new Error(usage)
   }
   if (options.mode === 'apply' && !options.logPath) throw new Error(`--apply needs --log <file|-> to keep old values. ${usage}`)
   if (options.mode === 'rollback' && options.bankCode) throw new Error(`--rollback takes the banks from the log. ${usage}`)
   return options
}

const say = (message) => console.error(message)

// One planned change per content row (scripts/question-text-plan.js), with its table.
function planChanges(questions, bankCode) {
   const plan = planQuestionChanges(questions, { bankCode })
   return {
      ...plan,
      changes: plan.changes.map((change) => ({ ...change, table: tables[change.kind].table })),
   }
}

function printChanges(changes, verb) {
   say(`\n${verb}: ${changes.length} content rows in ${new Set(changes.map((change) => change.questionId)).size} questions`)
   for (const change of changes) {
      say(`   #${change.questionId} ${change.externalId} (${change.bankCode}, ${change.status}, attempts: ${change.attemptUses}) ${change.label}`)
      for (const edit of change.edits) {
         say(`      ${edit.path}${edit.rules ? ` [${edit.rules.join(', ')}]` : ''}`)
         say(`         было:  ${JSON.stringify(edit.before)}`)
         say(`         стало: ${JSON.stringify(edit.after)}`)
      }
   }
}

function printPlanNotes({ excluded, joinNotApplied }) {
   say(`
Excluded from automatic changes: ${excluded.length} questions`)
   for (const item of excluded) say(`   #${item.questionId} ${item.externalId ?? '(no externalId)'} (${item.bankCode})`)
   if (joinNotApplied.length) {
      say(`
WARNING: hyphen join listed but not applied: ${joinNotApplied.length}`)
      for (const item of joinNotApplied) {
         say(`   ${item.externalId} (${item.bankCode}, local id ${item.id}): ${item.loaded ? 'no hyphen wrap found' : 'question not found'}`)
      }
   }
}

function printReview(review) {
   say(`\nManual review (not changed): ${review.length} findings in ${new Set(review.map((item) => item.questionId)).size} questions`)
   for (const item of review) {
      say(`   #${item.questionId} ${item.externalId} (${item.bankCode}) ${item.type}${item.reason ? `/${item.reason}` : ''} ${item.path}: ${JSON.stringify(item.sample)}`)
   }
}

async function writeLog(path, log) {
   const text = `${JSON.stringify(log, null, 2)}\n`
   if (path === '-') process.stdout.write(text)
   else await writeFile(path, text)
}

async function setGuards(client, kinds, enabled) {
   // Identifiers come from the fixed `tables` map above, never from input.
   for (const kind of kinds) {
      const { table, guard } = tables[kind]
      await client.query(`ALTER TABLE ${table} ${enabled ? 'ENABLE' : 'DISABLE'} TRIGGER ${guard}`)
   }
}

// Writes `to` where the row still holds `from`; returns false when the row changed meanwhile.
async function updateContent(client, change, from, to) {
   const { table, touch } = tables[change.kind]
   const result = await client.query(`
      UPDATE ${table} SET content = $2::jsonb${touch ? ', updated_at = CURRENT_TIMESTAMP' : ''}
      WHERE id = $1 AND content = $3::jsonb
   `, [change.rowId, JSON.stringify(to), JSON.stringify(from)])
   return result.rowCount === 1
}

async function writeChanges(client, changes, direction) {
   const questionIds = [...new Set(changes.map((change) => change.questionId))]
   const before = await loadIntegritySnapshot(client, questionIds)
   const kinds = [...new Set(changes.map((change) => change.kind))]
   await setGuards(client, kinds, false)
   for (const change of changes) {
      const [from, to] = direction === 'apply' ? [change.before, change.after] : [change.after, change.before]
      if (!await updateContent(client, change, from, to)) {
         throw new Error(`${change.table} row ${change.rowId} (question ${change.questionId}) no longer holds the expected content; nothing was changed`)
      }
   }
   await setGuards(client, kinds, true)
   const after = await loadIntegritySnapshot(client, questionIds)
   if (!isDeepStrictEqual(before, after)) {
      throw new Error('ids, keys, positions, answer keys or attempt data changed; nothing was changed')
   }
   for (const questionId of questionIds) {
      await client.query(`
         INSERT INTO audit_events (event_code, metadata) VALUES ($1, $2::jsonb)
      `, [direction === 'apply' ? 'question.text_repaired' : 'question.text_repair_reverted', JSON.stringify({
         questionId,
         rows: changes.filter((change) => change.questionId === questionId).map((change) => `${change.table}:${change.rowId}`),
         script: 'scripts/fix-question-text.js',
      })])
   }
   return questionIds
}

async function readRollbackLog(path) {
   const log = JSON.parse(await readFile(path, 'utf8'))
   if (log?.mode !== 'apply' || log.committed !== true || !Array.isArray(log.changes)) {
      throw new Error('--rollback needs a committed log written by --apply')
   }
   for (const change of log.changes) {
      if (!tables[change.kind] || tables[change.kind].table !== change.table || !/^[0-9]+$/.test(String(change.rowId))) {
         throw new Error('the rollback log contains an unknown row')
      }
   }
   return log
}

let client
try {
   const options = readArguments(process.argv.slice(2))
   client = await pool.connect()
   const { rows: [{ database }] } = await client.query('SELECT current_database() AS database')
   say(`Database: ${database}; mode: ${options.mode}${options.bankCode ? `; bank: ${options.bankCode}` : ''}`)

   if (options.mode === 'rollback') {
      const log = await readRollbackLog(options.rollbackPath)
      if (log.database !== database) throw new Error(`the log was written for database ${log.database}`)
      await client.query('BEGIN')
      await client.query("SET LOCAL lock_timeout = '5s'")
      const questionIds = await writeChanges(client, log.changes, 'rollback')
      await client.query('COMMIT')
      printChanges(log.changes.map((change) => ({
         ...change,
         edits: change.edits.map((edit) => ({ ...edit, before: edit.after, after: edit.before })),
      })), 'Reverted')
      if (options.logPath) {
         await writeLog(options.logPath, {
            mode: 'rollback', database, revertedAt: new Date().toISOString(), source: options.rollbackPath, questionIds,
         })
      }
   } else if (options.mode === 'dry-run') {
      await client.query('BEGIN READ ONLY')
      const questions = await loadQuestions(client, { bankCode: options.bankCode })
      await client.query('COMMIT')
      const plan = planChanges(questions, options.bankCode)
      const { changes, review } = plan
      printChanges(changes, 'Would change')
      printPlanNotes(plan)
      printReview(review)
      if (options.logPath) {
         await writeLog(options.logPath, {
            mode: 'dry-run', database, generatedAt: new Date().toISOString(), bankCode: options.bankCode, changes, review, excluded: plan.excluded, joinNotApplied: plan.joinNotApplied,
         })
      }
      say('\nDry run: nothing was changed. Run with --apply --log <file> to apply.')
   } else {
      await client.query('BEGIN')
      await client.query("SET LOCAL lock_timeout = '5s'")
      const questions = await loadQuestions(client, { bankCode: options.bankCode, lock: true })
      const plan = planChanges(questions, options.bankCode)
      const { changes, review } = plan
      const log = {
         mode: 'apply', database, appliedAt: new Date().toISOString(), bankCode: options.bankCode, committed: false, changes, review, excluded: plan.excluded, joinNotApplied: plan.joinNotApplied,
      }
      if (changes.length) {
         await writeChanges(client, changes, 'apply')
         // The log with the old values exists before COMMIT, so a crash cannot lose them.
         if (options.logPath !== '-') await writeLog(options.logPath, log)
      }
      await client.query('COMMIT')
      log.committed = true
      await writeLog(options.logPath, log)
      printChanges(changes, 'Changed')
      printPlanNotes(plan)
      printReview(review)
      say(`\nCommitted. Log with old values: ${options.logPath === '-' ? 'stdout' : options.logPath}`)
   }
} catch (error) {
   if (client) await client.query('ROLLBACK').catch(() => {})
   console.error('Question text fix failed', { code: error.code, message: error.message })
   process.exitCode = 1
} finally {
   client?.release()
   await pool.end()
}
