import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomInt, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import pg from 'pg'

import env from '../../src/configs/env.js'
import {
   dryRunAnswerKeyImportService,
   runAnswerKeyImportService,
} from '../../src/services/answer-key-import-service.js'
import {
   archiveQuestionService,
   publishQuestionService,
   replaceAnswerKeyService,
   verifyAnswerKeyService,
} from '../../src/services/question-bank-service.js'
import { runQuestionImportService } from '../../src/services/question-import-service.js'
import AppError from '../../src/utils/app-error.js'
import { parseAnswerKeyFileBuffer } from '../../src/utils/answer-key-file.js'

// Synthetic questions only. A nested M09 package creates the draft bank, then a sidecar key
// file attaches keys to it, exactly as the real answer-key workflow does.

const { Client } = pg
const userIds = []
const directories = []
const suffix = randomUUID().slice(0, 8)
const subjectCode = `akey-${suffix}`
const bankCode = `akey-bank-${suffix}`
const failBankCode = `akey-fail-${suffix}`

function text(value) {
   return { blocks: [{ type: 'text', text: value }] }
}

function single(externalId, answerKey) {
   return {
      externalId,
      type: 'single_choice',
      content: text(`Synthetic stem ${externalId}`),
      options: ['a', 'b', 'c'].map((key) => ({ key, content: text(`${externalId} option ${key}`) })),
      ...(answerKey ? { answerKey } : {}),
   }
}

function matching(externalId, interactionSettings) {
   const items = (side, prefix) => [1, 2, 3, 4].map((number) => ({
      key: `${prefix}${number}`,
      content: text(`${externalId} ${side} ${number}`),
   }))
   return {
      externalId,
      type: 'matching',
      content: text(`Synthetic matching ${externalId}`),
      interactionSettings,
      matching: { left: items('left', 'l'), right: items('right', 'r') },
   }
}

function packageOf(code, questions) {
   return {
      sha256: randomUUID().replaceAll('-', '').padEnd(64, '0'),
      files: new Map(),
      manifest: {
         schemaVersion: 'everest.question-import.v1',
         sourceNamespace: `test:${code}`,
         subjects: [{ code: subjectCode, translations: { tg: { title: 'Synthetic' } } }],
         bank: { code, title: 'Synthetic key bank', subjectCode },
         questions,
      },
   }
}

const proposed = (optionKey) => ({ status: 'proposed', source: 'official_key', answerData: { optionKey } })
const nulls = { requireAllLeft: null, allowRightReuse: null }

const bankQuestions = [
   single('s1', { status: 'unknown', explanation: text('Author note') }),
   single('s2'),
   single('sample-s1'),
   matching('m1', { requireAllLeft: true, allowRightReuse: null }),
   matching('m2', nulls),
   matching('m3', nulls),
   matching('m4', nulls),
   matching('m5', nulls),
   matching('m6', { requireAllLeft: false, allowRightReuse: false }),
   matching('m7', { requireAllLeft: null, allowRightReuse: false }),
   single('p1', proposed('a')),
   single('a1', proposed('a')),
   single('c1', proposed('b')),
   single('u1', proposed('a')),
   single('v1', proposed('a')),
   single('n1'),
]

function pairs(list) {
   return { pairs: list.map(([leftKey, rightKey]) => ({ leftKey, rightKey })) }
}

const fullPairs = pairs([['l1', 'r3'], ['l2', 'r1'], ['l3', 'r4'], ['l4', 'r2']])

function record(code, externalId, answerDataExternal, extra = {}) {
   return {
      bankCode: code,
      questionExternalId: externalId,
      status: 'proposed',
      source: 'official_key',
      answerDataExternal,
      explanation: { blocks: [] },
      ...extra,
   }
}

function keyDocument(code = bankCode, records) {
   return {
      schemaVersion: 'everest.answer-key-import.v1',
      sourcePackage: 'synthetic-package-v1',
      bankCode: code,
      keySource: { filename: 'synthetic-key.pdf', sha256: 'ab'.repeat(32), pages: 2 },
      records: records ?? [
         record(code, 's1', { optionKeys: ['a'] }),
         record(code, 's2', { optionKeys: ['z'] }),
         record(code, 'sample-s1', { optionKeys: ['b'] }),
         record(code, 'm1', fullPairs),
         record(code, 'm2', fullPairs),
         record(code, 'm3', pairs([['l1', 'r3'], ['l2', 'r1'], ['l3', 'r4']])),
         record(code, 'm4', pairs([['l1', 'r1'], ['l9', 'r2']])),
         record(code, 'm5', pairs([['l1', 'r1'], ['l2', 'r1'], ['l3', 'r2'], ['l4', 'r3']])),
         record(code, 'm6', fullPairs),
         record(code, 'm7', fullPairs),
         record(code, 'p1', { optionKeys: ['a'] }),
         record(code, 'a1', { optionKeys: ['a'] }),
         record(code, 'c1', { optionKeys: ['a'] }),
         record(code, 'u1', { optionKeys: ['a'] }),
         record(code, 'v1', { optionKeys: ['a'] }),
         record(code, 'ghost', { optionKeys: ['a'] }),
      ],
   }
}

function keyFileOf(document) {
   return parseAnswerKeyFileBuffer(Buffer.from(JSON.stringify(document)))
}

function runCli(args) {
   return new Promise((resolve) => {
      execFile(process.execPath, ['scripts/import-answer-keys.js', ...args], { env: process.env }, (error, stdout, stderr) => {
         resolve({ code: error ? error.code : 0, stdout, stderr })
      })
   })
}

async function cleanup(client) {
   if (!userIds.length) return
   const guarded = ['questions', 'question_options', 'question_matching_items', 'question_answer_keys', 'question_assets', 'question_topics']
   const byUser = 'question_id IN (SELECT id FROM questions WHERE created_by = ANY($1::bigint[]))'
   await client.query('BEGIN')
   try {
      for (const table of guarded) await client.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`)
      await client.query('DELETE FROM question_duplicate_links WHERE marked_by = ANY($1::bigint[])', [userIds])
      for (const table of ['question_assets', 'question_topics', 'question_answer_keys', 'question_matching_items', 'question_options']) {
         await client.query(`DELETE FROM ${table} WHERE ${byUser}`, [userIds])
      }
      await client.query('DELETE FROM questions WHERE created_by = ANY($1::bigint[])', [userIds])
      for (const table of guarded) await client.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`)
      await client.query('COMMIT')
   } catch (error) {
      await client.query('ROLLBACK')
      throw error
   }
   const runs = 'SELECT id FROM question_imports WHERE initiated_by = ANY($1::bigint[])'
   await client.query(`DELETE FROM question_import_errors WHERE import_id IN (${runs})`, [userIds])
   await client.query('DELETE FROM question_imports WHERE initiated_by = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM question_banks WHERE owner_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM subject_translations WHERE subject_id IN (SELECT id FROM subjects WHERE code = $1)', [subjectCode])
   await client.query('DELETE FROM subjects WHERE code = $1', [subjectCode])
   await client.query('DELETE FROM audit_events WHERE actor_user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM user_phones WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM user_roles WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM user_profiles WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [userIds])
}

async function createUser(client, role, status = 'active') {
   const user = await client.query(
      `INSERT INTO users (status, onboarding_completed_at, blocked_at)
       VALUES ($1::varchar, CURRENT_TIMESTAMP, CASE WHEN $1::varchar = 'blocked' THEN CURRENT_TIMESTAMP END)
       RETURNING id`,
      [status],
   )
   const userId = user.rows[0].id
   userIds.push(userId)
   await client.query(`INSERT INTO user_profiles (user_id, first_name, last_name) VALUES ($1, 'Keys', 'Import')`, [userId])
   await client.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2', [userId, role])
   return userId
}

test('answer-key sidecar import integration', async (t) => {
   const client = new Client(env.database)
   await client.connect()

   async function questionIds(code) {
      const result = await client.query(
         `SELECT question.external_id, question.id FROM questions AS question
          JOIN question_banks AS bank ON bank.id = question.bank_id WHERE bank.code = $1`,
         [code],
      )
      return Object.fromEntries(result.rows.map((row) => [row.external_id, row.id]))
   }

   // Everything an import could change: keys, settings, statuses, runs and audit rows.
   async function snapshot() {
      const questions = await client.query(
         `SELECT question.external_id, question.status, question.interaction_settings, question.updated_at,
            key.status AS key_status, key.source, key.answer_data, key.explanation, key.verified_by, key.updated_at AS key_updated_at
          FROM questions AS question
          JOIN question_banks AS bank ON bank.id = question.bank_id
          LEFT JOIN question_answer_keys AS key ON key.question_id = question.id
          WHERE bank.code = ANY($1::text[]) ORDER BY question.id`,
         [[bankCode, failBankCode]],
      )
      const counts = await client.query(
         `SELECT
            (SELECT count(*)::integer FROM question_imports WHERE initiated_by = ANY($1::bigint[])) AS runs,
            (SELECT count(*)::integer FROM question_import_errors WHERE import_id IN
               (SELECT id FROM question_imports WHERE initiated_by = ANY($1::bigint[]))) AS entries,
            (SELECT count(*)::integer FROM audit_events WHERE actor_user_id = ANY($1::bigint[])) AS audits`,
         [userIds],
      )
      return { questions: questions.rows, ...counts.rows[0] }
   }

   async function keyOf(questionId) {
      return (await client.query(
         'SELECT status, source, answer_data, explanation, verified_by FROM question_answer_keys WHERE question_id = $1',
         [questionId],
      )).rows[0]
   }

   async function settingsOf(questionId) {
      return (await client.query('SELECT interaction_settings FROM questions WHERE id = $1', [questionId])).rows[0].interaction_settings
   }

   const expectedOutcomes = {
      APPLIED: 7,
      UNCHANGED: 1,
      KEY_CONFLICT: 1,
      KEY_VERIFIED_SKIPPED: 1,
      QUESTION_NOT_DRAFT: 2,
      QUESTION_NOT_FOUND: 1,
      ANSWER_KEY_INVALID: 3,
   }

   let adminId
   let teacherId
   let studentId
   let blockedId
   let ids
   const adminPhone = `+99291${randomInt(1000000, 9999999)}`
   const document = keyDocument()
   const keyFile = keyFileOf(document)
   try {
      adminId = await createUser(client, 'admin')
      teacherId = await createUser(client, 'teacher')
      studentId = await createUser(client, 'student')
      blockedId = await createUser(client, 'admin', 'blocked')
      await client.query('INSERT INTO user_phones (user_id, phone_e164, is_primary) VALUES ($1, $2, FALSE)', [adminId, adminPhone])

      const imported = await runQuestionImportService(adminId, packageOf(bankCode, bankQuestions))
      assert.equal(imported.status, 'completed', JSON.stringify(imported.errors))
      ids = await questionIds(bankCode)
      for (const externalId of ['v1', 'p1', 'a1']) {
         await verifyAnswerKeyService(adminId, ids[externalId], { source: 'official_key' })
      }
      await publishQuestionService(adminId, ids.p1)
      await publishQuestionService(adminId, ids.a1)
      await archiveQuestionService(adminId, ids.a1)
      let firstRun

      await t.test('the actor must be active, hold questions.manage and manage the bank', async () => {
         await assert.rejects(dryRunAnswerKeyImportService(studentId, keyFile), { code: 'IMPORT_ACTOR_FORBIDDEN' })
         await assert.rejects(runAnswerKeyImportService(blockedId, keyFile), { code: 'IMPORT_ACTOR_INACTIVE' })
         const before = await snapshot()
         const foreign = await runAnswerKeyImportService(teacherId, keyFile)
         assert.equal(foreign.status, 'rejected')
         assert.deepEqual(foreign.errors.map((entry) => entry.code), ['QUESTION_BANK_READ_ONLY'])
         assert.deepEqual(await snapshot(), before)
      })

      await t.test('any file-level error rejects the whole file and writes nothing', async () => {
         const before = await snapshot()
         const [first, second] = document.records
         const cases = [
            [{ ...document, schemaVersion: 'everest.answer-key-import.v0' }, 'KEY_FILE_SCHEMA_VERSION_UNSUPPORTED'],
            [{ ...document, keySource: undefined }, 'KEY_FILE_HEADER_INVALID'],
            [{ ...document, records: [...document.records, first] }, 'KEY_RECORD_DUPLICATE'],
            [{ ...document, records: [first, { ...second, source: 'ai_inference' }] }, 'ANSWER_KEY_SOURCE_REJECTED'],
            [{ ...document, records: [first, { ...second, status: 'verified' }] }, 'ANSWER_KEY_VERIFIED_REJECTED'],
            [{ ...document, records: [first, { ...second, answerDataExternal: null }] }, 'ANSWER_DATA_REQUIRED'],
            [keyDocument(`missing-${suffix}`), 'QUESTION_BANK_NOT_FOUND'],
         ]
         for (const [bad, code] of cases) {
            const result = await runAnswerKeyImportService(adminId, keyFileOf(bad))
            assert.equal(result.status, 'rejected', code)
            assert.ok(result.errors.some((entry) => entry.code === code), `${code}: ${JSON.stringify(result.errors)}`)
            assert.equal(result.counters.outcomes.APPLIED, 0)
         }
         const mismatch = await runAnswerKeyImportService(adminId, keyFile, { bankCode: `other-${suffix}` })
         assert.deepEqual(mismatch.errors.map((entry) => entry.code), ['KEY_FILE_BANK_MISMATCH'])
         assert.deepEqual(await snapshot(), before)
      })

      await t.test('a dry run classifies every record and writes nothing', async () => {
         const before = await snapshot()
         const report = await dryRunAnswerKeyImportService(adminId, keyFile, { bankCode })
         assert.equal(report.valid, true, JSON.stringify(report.errors))
         assert.equal(report.idempotencyKey, `answer-keys-${keyFile.sha256}`)
         assert.equal(report.counters.records, 16)
         assert.deepEqual(report.counters.outcomes, expectedOutcomes)
         assert.equal(report.counters.noKeyForQuestion, 1)
         const byId = Object.fromEntries(report.outcomes.map((entry) => [entry.externalId, entry]))
         assert.equal(byId.s2.code, 'ANSWER_KEY_INVALID')
         assert.equal(byId.m4.code, 'ANSWER_KEY_INVALID')
         assert.equal(byId.m5.code, 'ANSWER_KEY_INVALID')
         assert.equal(byId.p1.code, 'QUESTION_NOT_DRAFT')
         assert.equal(byId.a1.code, 'QUESTION_NOT_DRAFT')
         assert.equal(byId.v1.code, 'KEY_VERIFIED_SKIPPED')
         assert.equal(byId.ghost.code, 'QUESTION_NOT_FOUND')
         assert.equal(byId.n1.code, 'NO_KEY_FOR_QUESTION')
         assert.equal(byId.u1.code, 'UNCHANGED')
         assert.deepEqual(byId.c1.stored, { source: 'official_key', answerData: { optionKey: 'b' } })
         assert.deepEqual(byId.c1.file, { source: 'official_key', answerData: { optionKey: 'a' } })
         assert.deepEqual(report.matchingRules, [])
         assert.deepEqual(await snapshot(), before)
      })

      await t.test('a real run sets proposed keys in batches and records the run', async () => {
         firstRun = await runAnswerKeyImportService(adminId, keyFile, { bankCode, batchSize: 5 })
         assert.equal(firstRun.status, 'completed', JSON.stringify(firstRun.errors))
         assert.deepEqual(firstRun.counters.outcomes, expectedOutcomes)
         assert.deepEqual(firstRun.counters.batches, { size: 5, committed: 4, failed: 0 })
         assert.equal(firstRun.counters.recordsFailed, 0)

         assert.deepEqual(await keyOf(ids.s1), {
            status: 'proposed', source: 'official_key', answer_data: { optionKey: 'a' }, explanation: text('Author note'), verified_by: null,
         })
         assert.deepEqual((await keyOf(ids['sample-s1'])).answer_data, { optionKey: 'b' })
         assert.deepEqual((await keyOf(ids.m1)).answer_data, {
            pairs: [{ left: 'l1', right: 'r3' }, { left: 'l2', right: 'r1' }, { left: 'l3', right: 'r4' }, { left: 'l4', right: 'r2' }],
         })
         assert.deepEqual((await keyOf(ids.m3)).answer_data.pairs.length, 3)
         assert.deepEqual((await keyOf(ids.c1)).answer_data, { optionKey: 'b' })
         assert.equal((await keyOf(ids.v1)).status, 'verified')
         assert.equal((await keyOf(ids.p1)).status, 'verified')
         for (const externalId of ['s2', 'm4', 'm5', 'n1']) assert.equal((await keyOf(ids[externalId])).status, 'unknown')
         // Without --set-matching-rules the settings stay as imported.
         assert.deepEqual(await settingsOf(ids.m1), { requireAllLeft: true, allowRightReuse: null })
         assert.deepEqual(await settingsOf(ids.m2), nulls)
         const rules = firstRun.counters.matchingRules
         assert.equal(rules.enabled, false)
         assert.deepEqual(rules.requireAllLeft, { set: 0, skippedAlreadySet: 0, skippedNotCovered: 0, stillNull: 5 })
         assert.deepEqual(rules.allowRightReuse, { set: 0, skippedAlreadySet: 0, skippedNotDistinct: 0, stillNull: 5 })
         assert.equal(rules.matchingDrafts, 7)
         assert.equal(rules.publishableBySettings, 1)

         const run = (await client.query('SELECT * FROM question_imports WHERE id = $1', [firstRun.runId])).rows[0]
         assert.equal(run.status, 'completed')
         assert.equal(run.schema_version, 'everest.answer-key-import.v1')
         assert.equal(run.package_sha256, keyFile.sha256)
         assert.equal(run.is_dry_run, false)
         assert.deepEqual(run.manifest.keySource, document.keySource)
         assert.equal(run.manifest.sourcePackage, 'synthetic-package-v1')
         assert.deepEqual(run.counters, firstRun.counters)
         const entries = (await client.query(
            'SELECT error_code, external_id, message FROM question_import_errors WHERE import_id = $1 ORDER BY id',
            [firstRun.runId],
         )).rows
         assert.deepEqual([...new Set(entries.map((entry) => entry.error_code))].sort(), [
            'ANSWER_KEY_INVALID', 'KEY_CONFLICT', 'KEY_VERIFIED_SKIPPED', 'NO_KEY_FOR_QUESTION', 'QUESTION_NOT_DRAFT', 'QUESTION_NOT_FOUND',
         ])
         // Validator wording may name a field; stored values ("a", "r3", JSON fragments) never appear.
         for (const entry of entries) assert.doesNotMatch(entry.message, /"optionKey"|"pairs"|"left"|"right"|\br\d\b/)
      })

      await t.test('the same file and key replays the run without changes', async () => {
         const before = await snapshot()
         const replay = await runAnswerKeyImportService(adminId, keyFile, { bankCode })
         assert.equal(replay.replayed, true)
         assert.equal(replay.runId, firstRun.runId)
         assert.equal(replay.status, 'completed')
         assert.deepEqual(replay.counters, firstRun.counters)
         assert.deepEqual(await snapshot(), before)
      })

      await t.test('a re-run under a new key finds nothing left to apply', async () => {
         const before = (await snapshot()).questions
         const again = await runAnswerKeyImportService(adminId, keyFile, { idempotencyKey: `again-${suffix}` })
         assert.equal(again.status, 'completed')
         assert.deepEqual(again.counters.outcomes, { ...expectedOutcomes, APPLIED: 0, UNCHANGED: 8 })
         assert.deepEqual((await snapshot()).questions, before)
         const changed = keyFileOf({ ...document, records: document.records.slice(0, -1) })
         await assert.rejects(
            runAnswerKeyImportService(adminId, changed, { idempotencyKey: `again-${suffix}` }),
            { code: 'IMPORT_IDEMPOTENCY_CONFLICT' },
         )
      })

      await t.test('--set-matching-rules dry run reports per field and writes nothing', async () => {
         const before = await snapshot()
         const report = await dryRunAnswerKeyImportService(adminId, keyFile, { setMatchingRules: true })
         assert.equal(report.valid, true)
         assert.equal(report.idempotencyKey, `answer-keys-${keyFile.sha256}-matching-rules`)
         assert.equal(report.previousRunId, null)
         const rules = report.counters.matchingRules
         assert.equal(rules.enabled, true)
         assert.deepEqual(rules.requireAllLeft, { set: 2, skippedAlreadySet: 2, skippedNotCovered: 1, stillNull: 3 })
         assert.deepEqual(rules.allowRightReuse, { set: 3, skippedAlreadySet: 2, skippedNotDistinct: 0, stillNull: 2 })
         assert.equal(rules.publishableBySettings, 4)
         const byId = Object.fromEntries(report.matchingRules.map((entry) => [entry.externalId, entry]))
         assert.deepEqual(Object.keys(byId).sort(), ['m1', 'm2', 'm3', 'm6', 'm7'])
         assert.equal(byId.m3.requireAllLeft, 'REQUIRE_ALL_LEFT_SKIPPED_NOT_COVERED')
         assert.deepEqual(await snapshot(), before)
      })

      await t.test('--set-matching-rules sets only null fields that the keys support', async () => {
         const auditsBefore = (await client.query(
            `SELECT count(*)::integer AS total FROM audit_events WHERE actor_user_id = $1 AND event_code = 'question.updated'`,
            [adminId],
         )).rows[0].total
         const result = await runAnswerKeyImportService(adminId, keyFile, { setMatchingRules: true })
         assert.equal(result.status, 'completed', JSON.stringify(result.errors))
         assert.deepEqual(result.counters.outcomes, { ...expectedOutcomes, APPLIED: 0, UNCHANGED: 8 })
         const rules = result.counters.matchingRules
         assert.deepEqual(rules.requireAllLeft, { set: 2, skippedAlreadySet: 2, skippedNotCovered: 1, stillNull: 3 })
         assert.deepEqual(rules.allowRightReuse, { set: 3, skippedAlreadySet: 2, skippedNotDistinct: 0, stillNull: 2 })
         assert.equal(rules.matchingDrafts, 7)
         assert.equal(rules.publishableBySettings, 4)

         assert.deepEqual(await settingsOf(ids.m1), { requireAllLeft: true, allowRightReuse: false })
         assert.deepEqual(await settingsOf(ids.m2), { requireAllLeft: true, allowRightReuse: false })
         assert.deepEqual(await settingsOf(ids.m3), { requireAllLeft: null, allowRightReuse: false })
         assert.deepEqual(await settingsOf(ids.m4), nulls)
         assert.deepEqual(await settingsOf(ids.m5), nulls)
         assert.deepEqual(await settingsOf(ids.m6), { requireAllLeft: false, allowRightReuse: false })
         assert.deepEqual(await settingsOf(ids.m7), { requireAllLeft: true, allowRightReuse: false })
         // Keys stay proposed; nothing is verified or published by the import.
         for (const externalId of ['m1', 'm2', 'm3', 'm7']) assert.equal((await keyOf(ids[externalId])).status, 'proposed')
         const statuses = (await client.query(
            'SELECT DISTINCT status FROM questions WHERE id = ANY($1::bigint[])',
            [[ids.m1, ids.m2, ids.m3, ids.m6, ids.m7]],
         )).rows.map((row) => row.status)
         assert.deepEqual(statuses, ['draft'])
         const audits = (await client.query(
            `SELECT entity_id, metadata FROM audit_events WHERE actor_user_id = $1 AND event_code = 'question.updated' ORDER BY id`,
            [adminId],
         )).rows.slice(auditsBefore)
         assert.deepEqual(audits.map((row) => row.entity_id).sort(), [ids.m1, ids.m2, ids.m3, ids.m7].sort())
         for (const row of audits) assert.deepEqual(row.metadata.fields, ['interactionSettings'])

         const replay = await runAnswerKeyImportService(adminId, keyFile, { setMatchingRules: true })
         assert.equal(replay.replayed, true)
      })

      await t.test('audit rows of the import carry no answer data', async () => {
         const audits = (await client.query(
            `SELECT event_code AS code, metadata FROM audit_events
             WHERE actor_user_id = $1 AND (event_code LIKE 'answer_key_import.%' OR event_code LIKE 'question.answer_key.%' OR event_code = 'question.updated')`,
            [adminId],
         )).rows
         assert.ok(audits.some((row) => row.code === 'answer_key_import.completed'))
         assert.ok(audits.some((row) => row.code === 'question.answer_key.updated'))
         for (const row of audits) assert.doesNotMatch(JSON.stringify(row.metadata), /optionKey|pairs|answerData|"left"|"right"|\br\d\b/)
      })

      await t.test('a failing batch rolls back and the run is reported as failed', async () => {
         const failed = await runQuestionImportService(adminId, packageOf(failBankCode, ['r1', 'r2', 'r3', 'r4'].map((id) => single(id))))
         assert.equal(failed.status, 'completed')
         const failIds = await questionIds(failBankCode)
         const failDocument = keyDocument(failBankCode, ['r1', 'r2', 'r3', 'r4'].map((id) => record(failBankCode, id, { optionKeys: ['c'] })))
         const failFile = keyFileOf(failDocument)
         const overrides = {
            replaceAnswerKey: async (actorId, questionId, body, scoped) => {
               const result = await replaceAnswerKeyService(actorId, questionId, body, scoped)
               if (questionId === failIds.r3) throw new AppError(409, 'SIMULATED_FAILURE', 'Simulated failure')
               return result
            },
         }
         const result = await runAnswerKeyImportService(adminId, failFile, { batchSize: 2 }, overrides)
         assert.equal(result.status, 'failed')
         assert.deepEqual(result.counters.batches, { size: 2, committed: 1, failed: 1 })
         assert.equal(result.counters.outcomes.APPLIED, 2)
         assert.equal(result.counters.recordsFailed, 2)
         assert.equal(result.errors[0].code, 'SIMULATED_FAILURE')
         assert.equal(result.errors[0].externalId, 'r3')
         assert.equal((await keyOf(failIds.r1)).status, 'proposed')
         assert.equal((await keyOf(failIds.r2)).status, 'proposed')
         assert.equal((await keyOf(failIds.r3)).status, 'unknown')
         assert.equal((await keyOf(failIds.r4)).status, 'unknown')
         const run = (await client.query('SELECT status FROM question_imports WHERE id = $1', [result.runId])).rows[0]
         assert.equal(run.status, 'failed')

         const replay = await runAnswerKeyImportService(adminId, failFile)
         assert.equal(replay.replayed, true)
         assert.equal(replay.status, 'failed')
         const retry = await runAnswerKeyImportService(adminId, failFile, { idempotencyKey: `retry-${suffix}` })
         assert.equal(retry.status, 'completed')
         assert.equal(retry.counters.outcomes.APPLIED, 2)
         assert.equal(retry.counters.outcomes.UNCHANGED, 2)
      })

      await t.test('the CLI prints counts and codes only', async () => {
         const directory = await mkdtemp(path.join(os.tmpdir(), 'everest-keys-'))
         directories.push(directory)
         const file = path.join(directory, 'keys.json')
         await writeFile(file, JSON.stringify(document))
         const dry = await runCli(['--keys', file, '--actor-phone', adminPhone, '--bank', bankCode, '--dry-run', '--set-allow-right-reuse-false'])
         assert.equal(dry.code, 0, dry.stderr)
         const summary = JSON.parse(dry.stdout)
         assert.equal(summary.mode, 'dry_run')
         assert.equal(summary.counters.records, 16)
         assert.equal(summary.counters.matchingRules.enabled, true)
         assert.doesNotMatch(dry.stdout + dry.stderr, /optionKey|"pairs"|Synthetic stem/)
         const mismatch = await runCli(['--keys', file, '--actor-phone', adminPhone, '--bank', `other-${suffix}`, '--dry-run'])
         assert.equal(mismatch.code, 2)
         assert.equal(JSON.parse(mismatch.stdout).firstErrors[0].code, 'KEY_FILE_BANK_MISMATCH')
      })
   } finally {
      await cleanup(client)
      await client.end()
      for (const directory of directories) await rm(directory, { recursive: true, force: true })
   }
})
