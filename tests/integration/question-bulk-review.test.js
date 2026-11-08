import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomInt, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import pg from 'pg'

import env from '../../src/configs/env.js'
import { dryRunAnswerKeyImportService } from '../../src/services/answer-key-import-service.js'
import {
   createQuestionBankService,
   createQuestionService,
   publishQuestionService,
   replaceAnswerKeyService,
   verifyAnswerKeyService,
} from '../../src/services/question-bank-service.js'
import {
   bulkPublishQuestionsService,
   bulkVerifyAnswerKeysService,
} from '../../src/services/question-bulk-review-service.js'
import { runQuestionImportService } from '../../src/services/question-import-service.js'
import { parseAnswerKeyFileBuffer } from '../../src/utils/answer-key-file.js'

// Synthetic questions only. A nested M09 package creates the draft banks; proposed keys are set
// through the admin service, then the bulk verify/publish services and CLIs run on them.

const { Client } = pg
const userIds = []
const directories = []
const suffix = randomUUID().slice(0, 8)
const subjectCode = `bulk-${suffix}`
const bankCode = `bulk-bank-${suffix}`
const otherBankCode = `bulk-other-${suffix}`

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
   const items = (side, prefix) => [1, 2, 3].map((number) => ({
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
         bank: { code, title: 'Synthetic bulk bank', subjectCode },
         questions,
      },
   }
}

const proposed = (optionKey, source = 'official_key') => ({ status: 'proposed', source, answerData: { optionKey } })

const bankQuestions = [
   single('k1', proposed('a')),
   single('k2', proposed('b')),
   single('x1', proposed('a')),
   single('e1', proposed('a', 'expert_review')),
   single('v1', proposed('a')),
   single('p1', proposed('a')),
   single('u1'),
   matching('m-ok', { requireAllLeft: true, allowRightReuse: false }),
   matching('m-null', { requireAllLeft: null, allowRightReuse: null }),
]

function runCli(script, args) {
   return new Promise((resolve) => {
      execFile(process.execPath, [`scripts/${script}`, ...args], { env: process.env }, (error, stdout, stderr) => {
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
   await client.query('DELETE FROM assets WHERE uploaded_by = ANY($1::bigint[])', [userIds])
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
   await client.query(`INSERT INTO user_profiles (user_id, first_name, last_name) VALUES ($1, 'Bulk', 'Review')`, [userId])
   await client.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2', [userId, role])
   return userId
}

function outcomesOf(result) {
   return Object.fromEntries(result.entries.map((entry) => [entry.externalId, entry.outcome]))
}

test('bulk key verification and publication integration', async (t) => {
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

   async function snapshot(codes = [bankCode, otherBankCode]) {
      const questions = await client.query(
         `SELECT question.external_id, question.status, question.updated_at,
            key.status AS key_status, key.source, key.verified_by, key.verified_at
          FROM questions AS question
          JOIN question_banks AS bank ON bank.id = question.bank_id
          LEFT JOIN question_answer_keys AS key ON key.question_id = question.id
          WHERE bank.code = ANY($1::text[]) ORDER BY question.id`,
         [codes],
      )
      const audits = await client.query(
         'SELECT count(*)::integer AS count FROM audit_events WHERE actor_user_id = ANY($1::bigint[])',
         [userIds],
      )
      return { questions: questions.rows, audits: audits.rows[0].count }
   }

   async function stateOf(questionId) {
      return (await client.query(
         `SELECT question.status, key.status AS key_status, key.source, key.verified_by
          FROM questions AS question JOIN question_answer_keys AS key ON key.question_id = question.id
          WHERE question.id = $1`,
         [questionId],
      )).rows[0]
   }

   let adminId
   let reviewerId
   let teacherId
   let blockedId
   let ids
   const adminPhone = `+99292${randomInt(1000000, 9999999)}`
   try {
      adminId = await createUser(client, 'admin')
      reviewerId = await createUser(client, 'owner')
      teacherId = await createUser(client, 'teacher')
      blockedId = await createUser(client, 'admin', 'blocked')
      await client.query('INSERT INTO user_phones (user_id, phone_e164, is_primary) VALUES ($1, $2, FALSE)', [reviewerId, adminPhone])

      const imported = await runQuestionImportService(adminId, packageOf(bankCode, bankQuestions))
      assert.equal(imported.status, 'completed', JSON.stringify(imported.errors))
      const other = await runQuestionImportService(adminId, packageOf(otherBankCode, [single('k1', proposed('a'))]))
      assert.equal(other.status, 'completed', JSON.stringify(other.errors))
      ids = await questionIds(bankCode)
      const matchingKey = { pairs: [{ left: 'l1', right: 'r2' }, { left: 'l2', right: 'r3' }, { left: 'l3', right: 'r1' }] }
      for (const externalId of ['m-ok', 'm-null']) {
         await replaceAnswerKeyService(adminId, ids[externalId], { answerData: matchingKey, source: 'official_key' })
      }
      await verifyAnswerKeyService(adminId, ids.v1, { source: 'official_key' })
      await verifyAnswerKeyService(adminId, ids.p1, { source: 'official_key' })
      await publishQuestionService(adminId, ids.p1)

      await t.test('the actor must be active and hold questions.review', async () => {
         const before = await snapshot()
         await assert.rejects(bulkVerifyAnswerKeysService(teacherId, { bankCode }), { code: 'BULK_ACTOR_FORBIDDEN' })
         await assert.rejects(bulkPublishQuestionsService(teacherId, { bankCode }), { code: 'BULK_ACTOR_FORBIDDEN' })
         await assert.rejects(bulkVerifyAnswerKeysService(blockedId, { bankCode }), { code: 'BULK_ACTOR_INACTIVE' })
         await assert.rejects(
            bulkVerifyAnswerKeysService(reviewerId, { bankCode: `missing-${suffix}` }),
            { code: 'QUESTION_BANK_NOT_FOUND' },
         )
         assert.deepEqual(await snapshot(), before)
      })

      await t.test('a dry run classifies every question and writes nothing', async () => {
         const before = await snapshot()
         const report = await bulkVerifyAnswerKeysService(reviewerId, {
            bankCode, dryRun: true, exclude: ['x1', 'not-in-bank'], onlySource: 'official_key',
         })
         assert.equal(report.mode, 'dry_run')
         assert.equal(report.runId, null)
         assert.deepEqual(outcomesOf(report), {
            k1: 'VERIFIED',
            k2: 'VERIFIED',
            x1: 'SKIPPED_EXCLUDED',
            e1: 'SKIPPED_SOURCE_FILTERED',
            v1: 'SKIPPED_NOT_PROPOSED',
            p1: 'SKIPPED_NOT_DRAFT',
            u1: 'SKIPPED_NOT_PROPOSED',
            'm-ok': 'VERIFIED',
            'm-null': 'VERIFIED',
         })
         assert.deepEqual(report.exclude, { requested: 2, notFoundInBank: ['not-in-bank'] })
         const publish = await bulkPublishQuestionsService(reviewerId, { bankCode, dryRun: true })
         assert.equal(publish.counters.outcomes.PUBLISHED, 1)
         assert.deepEqual(await snapshot(), before)
      })

      let runId
      await t.test('verification uses the admin service, keeps verified keys and audits the run', async () => {
         const verifiedBefore = await stateOf(ids.v1)
         const otherBefore = (await snapshot([otherBankCode])).questions
         const report = await bulkVerifyAnswerKeysService(reviewerId, { bankCode, exclude: ['x1'], batchSize: 2 })
         assert.equal(report.status, 'completed', JSON.stringify(report.errors))
         runId = report.runId
         assert.match(runId, /^[0-9a-f-]{36}$/)
         assert.deepEqual(report.counters.outcomes, {
            VERIFIED: 5,
            SKIPPED_EXCLUDED: 1,
            SKIPPED_NOT_DRAFT: 1,
            SKIPPED_NOT_PROPOSED: 2,
            SKIPPED_SOURCE_FILTERED: 0,
            SKIPPED_SOURCE_NOT_VERIFIABLE: 0,
            FAILED: 0,
         })
         assert.equal(report.counters.batches.committed, 5)
         for (const externalId of ['k1', 'k2', 'e1', 'm-ok', 'm-null']) {
            const state = await stateOf(ids[externalId])
            assert.equal(state.key_status, 'verified', externalId)
            assert.equal(String(state.verified_by), String(reviewerId))
         }
         assert.equal((await stateOf(ids.e1)).source, 'expert_review')
         assert.equal((await stateOf(ids.x1)).key_status, 'proposed')
         assert.deepEqual(await stateOf(ids.v1), verifiedBefore)
         assert.deepEqual((await snapshot([otherBankCode])).questions, otherBefore)

         const audits = await client.query(
            `SELECT event_code AS code, entity_id, metadata FROM audit_events
             WHERE actor_user_id = $1 AND metadata->>'runId' = $2 ORDER BY id`,
            [reviewerId, runId],
         )
         assert.deepEqual(audits.rows.map((row) => row.code), [
            'question_bulk_verify.started',
            ...Array(5).fill('question.answer_key.verified'),
            'question_bulk_verify.completed',
         ])
         const perQuestion = audits.rows.filter((row) => row.code === 'question.answer_key.verified')
         assert.ok(perQuestion.every((row) => row.metadata.origin === 'bulk' && row.metadata.keySource === row.metadata.source))
      })

      await t.test('a repeated verification run changes nothing and writes no audit', async () => {
         const before = await snapshot()
         const report = await bulkVerifyAnswerKeysService(reviewerId, { bankCode, exclude: ['x1'] })
         assert.equal(report.counters.outcomes.VERIFIED, 0)
         assert.deepEqual(await snapshot(), before)
      })

      await t.test('publication publishes ready drafts and reports the rest with reason codes', async () => {
         const otherBefore = (await snapshot([otherBankCode])).questions
         const report = await bulkPublishQuestionsService(reviewerId, { bankCode, batchSize: 3 })
         assert.equal(report.status, 'completed', JSON.stringify(report.errors))
         assert.deepEqual(outcomesOf(report), {
            k1: 'PUBLISHED',
            k2: 'PUBLISHED',
            x1: 'SKIPPED_KEY_NOT_VERIFIED',
            e1: 'PUBLISHED',
            v1: 'PUBLISHED',
            p1: 'SKIPPED_NOT_DRAFT',
            u1: 'SKIPPED_KEY_NOT_VERIFIED',
            'm-ok': 'PUBLISHED',
            'm-null': 'NOT_PUBLISHABLE',
         })
         assert.deepEqual(report.counters.reasons, { INTERACTION_SETTINGS_INCOMPLETE: 1 })
         assert.equal((await stateOf(ids['m-null'])).status, 'draft')
         assert.equal((await stateOf(ids['m-ok'])).status, 'published')
         assert.deepEqual((await snapshot([otherBankCode])).questions, otherBefore)

         const before = await snapshot()
         const again = await bulkPublishQuestionsService(reviewerId, { bankCode })
         assert.equal(again.counters.outcomes.PUBLISHED, 0)
         assert.equal(again.counters.outcomes.NOT_PUBLISHABLE, 1)
         assert.deepEqual(await snapshot(), before)
      })

      await t.test('the CLIs print counts and codes only and honour --dry-run', async () => {
         const directory = await mkdtemp(path.join(os.tmpdir(), 'everest-bulk-'))
         directories.push(directory)
         const excludePath = path.join(directory, 'exclude.json')
         const reportPath = path.join(directory, 'report.json')
         await writeFile(excludePath, JSON.stringify({ externalIds: ['x1'] }))
         const before = await snapshot()
         const verify = await runCli('verify-answer-keys.js', [
            '--bank', bankCode, '--actor-phone', adminPhone, '--dry-run', '--exclude', excludePath, '--report', reportPath,
         ])
         assert.equal(verify.code, 0, verify.stderr)
         const printed = JSON.parse(verify.stdout)
         assert.equal(printed.mode, 'dry_run')
         assert.equal(printed.counters.outcomes.SKIPPED_EXCLUDED, 1)
         assert.doesNotMatch(verify.stdout, /Synthetic|option|optionKey|pairs/)
         const report = JSON.parse(await readFile(reportPath, 'utf8'))
         assert.ok(report.entries.every((entry) => Object.keys(entry).every((key) => ['externalId', 'questionId', 'outcome', 'reason'].includes(key))))
         const publish = await runCli('publish-questions.js', ['--bank', bankCode, '--actor-phone', adminPhone, '--dry-run'])
         assert.equal(publish.code, 0, publish.stderr)
         assert.equal(JSON.parse(publish.stdout).counters.reasons.INTERACTION_SETTINGS_INCOMPLETE, 1)
         assert.deepEqual(await snapshot(), before)
         const unknown = await runCli('publish-questions.js', ['--bank', bankCode])
         assert.equal(unknown.code, 1)
      })

      await t.test('dry runs of a bank with image questions read without a transaction and write nothing', async () => {
         const imageBankCode = `bulk-img-${suffix}`
         const subject = await client.query('SELECT id FROM subjects WHERE code = $1', [subjectCode])
         const bank = await createQuestionBankService(adminId, {
            code: imageBankCode, title: 'Synthetic image bank', subjectId: subject.rows[0].id, visibility: 'staff',
         })
         async function imageQuestion(externalId, status = 'ready') {
            const asset = await client.query(
               `INSERT INTO assets (storage_key, mime_type, size_bytes, status, uploaded_by)
                VALUES ($1, 'image/png', 10, 'ready', $2) RETURNING id`,
               [`questions/test-${randomUUID()}.png`, adminId],
            )
            const assetId = String(asset.rows[0].id)
            const question = await createQuestionService(adminId, bank.id, {
               questionType: 'single_choice',
               languageCode: 'tg',
               content: { blocks: [{ type: 'text', text: `Synthetic stem ${externalId}` }, { type: 'image', assetId, alt: 'figure' }] },
               options: ['a', 'b'].map((key) => ({ key, content: text(`${externalId} option ${key}`) })),
            })
            await client.query('UPDATE questions SET external_id = $2 WHERE id = $1', [question.id, externalId])
            await replaceAnswerKeyService(adminId, question.id, { answerData: { optionKey: 'a' }, source: 'official_key' })
            if (status !== 'proposed') await verifyAnswerKeyService(adminId, question.id, { source: 'official_key' })
            if (status === 'archived') await client.query(`UPDATE assets SET status = 'archived' WHERE id = $1`, [assetId])
         }
         await imageQuestion('img-proposed', 'proposed')
         await imageQuestion('img-ready')
         await imageQuestion('img-archived', 'archived')
         const before = await snapshot([imageBankCode])

         const verify = await bulkVerifyAnswerKeysService(reviewerId, { bankCode: imageBankCode, dryRun: true })
         assert.equal(verify.status, 'completed', JSON.stringify(verify.errors))
         assert.equal(outcomesOf(verify)['img-proposed'], 'VERIFIED')
         const publish = await bulkPublishQuestionsService(reviewerId, { bankCode: imageBankCode, dryRun: true })
         assert.equal(publish.status, 'completed', JSON.stringify(publish.errors))
         assert.deepEqual(outcomesOf(publish), {
            'img-proposed': 'SKIPPED_KEY_NOT_VERIFIED',
            'img-ready': 'PUBLISHED',
            'img-archived': 'NOT_PUBLISHABLE',
         })
         assert.deepEqual(publish.counters.reasons, { ASSET_NOT_READY: 1 })

         const keyDocument = {
            schemaVersion: 'everest.answer-key-import.v1',
            sourcePackage: 'synthetic-package-v1',
            bankCode: imageBankCode,
            keySource: { filename: 'synthetic-key.pdf', sha256: 'ab'.repeat(32), pages: 1 },
            records: [{
               bankCode: imageBankCode,
               questionExternalId: 'img-proposed',
               status: 'proposed',
               source: 'official_key',
               answerDataExternal: { optionKeys: ['a'] },
               explanation: { blocks: [] },
            }],
         }
         const keys = await dryRunAnswerKeyImportService(reviewerId, parseAnswerKeyFileBuffer(Buffer.from(JSON.stringify(keyDocument))))
         assert.equal(keys.valid, true, JSON.stringify(keys.errors))
         assert.equal(keys.counters.outcomes.UNCHANGED, 1)

         const directory = await mkdtemp(path.join(os.tmpdir(), 'everest-bulk-img-'))
         directories.push(directory)
         const keysPath = path.join(directory, 'keys.json')
         await writeFile(keysPath, JSON.stringify(keyDocument))
         const common = ['--actor-phone', adminPhone, '--dry-run']
         const publishCli = await runCli('publish-questions.js', ['--bank', imageBankCode, ...common])
         assert.equal(publishCli.code, 0, publishCli.stderr || publishCli.stdout)
         assert.equal(JSON.parse(publishCli.stdout).counters.reasons.ASSET_NOT_READY, 1)
         const verifyCli = await runCli('verify-answer-keys.js', ['--bank', imageBankCode, ...common])
         assert.equal(verifyCli.code, 0, verifyCli.stderr || verifyCli.stdout)
         const keysCli = await runCli('import-answer-keys.js', ['--keys', keysPath, ...common])
         assert.equal(keysCli.code, 0, keysCli.stderr || keysCli.stdout)
         assert.deepEqual(await snapshot([imageBankCode]), before)
      })
   } finally {
      await cleanup(client)
      await client.end()
      for (const directory of directories) await rm(directory, { recursive: true, force: true })
   }
})
