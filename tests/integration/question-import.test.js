import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import pg from 'pg'

import { createApp } from '../../src/app.js'
import env from '../../src/configs/env.js'
import * as questionBankRepository from '../../src/repositories/question-bank-repository.js'
import { withTransaction } from '../../src/repositories/transaction-repository.js'
import { issueSessionService } from '../../src/services/auth/session-service.js'
import {
   archiveQuestionService,
   publishQuestionService,
   replaceAnswerKeyService,
   verifyAnswerKeyService,
} from '../../src/services/question-bank-service.js'
import {
   dryRunQuestionImportService,
   resolveImportActorService,
   runQuestionImportService,
} from '../../src/services/question-import-service.js'
import { loadQuestionPackage } from '../../src/utils/question-package.js'
import { createPng, createZip, entityPackage, writePackageDirectory } from '../helpers/import-fixtures.js'
import { createMemoryStorageProvider } from '../helpers/memory-storage-provider.js'

const { Client } = pg
const userIds = []
const directories = []
const suffix = randomUUID().slice(0, 8)
const subjectCode = `imp-bio-${suffix}`
const namespace = `test:${suffix}`
const config = {
   ...env,
   jwtAccessSecret: 'question-import-integration-secret-longer-than-32-chars',
   authSessionTtlSeconds: 900,
   authRefreshTtlSeconds: 86400,
   authAdminRateLimit: 1000,
}

function text(value) {
   return { blocks: [{ type: 'text', text: value }] }
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
   await client.query(
      `INSERT INTO user_profiles (user_id, first_name, last_name) VALUES ($1, 'Import', 'M09')`,
      [userId],
   )
   await client.query(
      'INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2',
      [userId, role],
   )
   return userId
}

async function packageFrom(manifest, files) {
   const directory = await writePackageDirectory(manifest, files)
   directories.push(directory)
   return loadQuestionPackage(directory)
}

// One question of each of the five types; q-single carries a proposed key so it can be
// verified and published by a reviewer later in the test.
function questions(prefix, overrides = {}) {
   return [
      {
         externalId: `${prefix}-single`,
         type: 'single_choice',
         content: { blocks: [{ type: 'text', text: 'Synthetic single' }, { type: 'image', asset: 'fig-shared', alt: 'Figure' }] },
         options: [
            { key: 'a', label: 'А)', content: text('alpha') },
            { key: 'b', label: 'Б)', content: text('beta') },
         ],
         topicCodes: ['cells'],
         source: { book: 'Synthetic', page: 3, number: '1', bookSectionTitle: 'II', year: 2024 },
         answerKey: { status: 'proposed', source: 'official_key', answerData: { optionKey: 'b' } },
         ...overrides.single,
      },
      {
         externalId: `${prefix}-multiple`,
         type: 'multiple_choice',
         content: { blocks: [{ type: 'text', text: 'Synthetic multiple' }, { type: 'image', asset: 'fig-shared' }] },
         options: [
            { key: 'a', content: text('one') },
            { key: 'b', content: text('two') },
            { key: 'c', content: text('three') },
         ],
         answerKey: { status: 'unknown' },
      },
      {
         externalId: `${prefix}-matching`,
         type: 'matching',
         content: text('Synthetic matching'),
         interactionSettings: { requireAllLeft: true, allowRightReuse: false },
         matching: {
            left: [{ key: '1', label: '1)', content: text('left one') }, { key: '2', content: text('left two') }],
            right: [{ key: 'a', content: text('right a') }, { key: 'b', content: text('right b') }],
         },
      },
      {
         externalId: `${prefix}-numeric`,
         type: 'numeric',
         difficulty: 2,
         difficultySource: 'official',
         content: { blocks: [{ type: 'formula', latex: 'x + 1 = 3' }, { type: 'table', header: true, rows: [['x'], ['?']] }] },
      },
      {
         externalId: `${prefix}-short`,
         type: 'short_text',
         content: { blocks: [{ type: 'verse', lines: ['Line one', 'Line two'] }] },
         language: 'ru',
      },
   ]
}

function manifest({ bankCode, prefix = 'q', assets, questionList, sourceNamespace = namespace, subjects } = {}) {
   return {
      schemaVersion: 'everest.question-import.v1',
      sourceNamespace,
      subjects: subjects ?? [{ code: subjectCode, color: 'green', translations: { tg: { title: 'Биология' } } }],
      sections: [{ subjectCode, code: 'cells', translations: { tg: { title: 'Ҳуҷайра' } } }],
      topics: [
         { subjectCode, code: 'cells', sectionCode: 'cells', translations: { tg: { title: 'Ҳуҷайра' } } },
         { subjectCode, code: 'organelles', parentCode: 'cells', translations: { tg: { title: 'Органоид' } } },
      ],
      bank: { code: bankCode, title: 'Synthetic bank', subjectCode, source: { book: 'Synthetic', year: 2025 } },
      assets: assets ?? [{ id: 'fig-shared', file: 'assets/shared.png', mimeType: 'image/png' }],
      questions: questionList ?? questions(prefix),
   }
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
   await client.query(`DELETE FROM asset_aliases WHERE source_namespace LIKE $1`, [`%${suffix}%`])
   await client.query('DELETE FROM assets WHERE uploaded_by = ANY($1::bigint[])', [userIds])
   const subjects = `SELECT id FROM subjects WHERE code LIKE '%-${suffix}'`
   await client.query(`DELETE FROM topic_translations WHERE topic_id IN (SELECT id FROM topics WHERE subject_id IN (${subjects}))`)
   await client.query(`UPDATE topics SET parent_id = NULL WHERE subject_id IN (${subjects})`)
   await client.query(`DELETE FROM topics WHERE subject_id IN (${subjects})`)
   await client.query(`DELETE FROM section_translations WHERE section_id IN (SELECT id FROM sections WHERE subject_id IN (${subjects}))`)
   await client.query(`DELETE FROM sections WHERE subject_id IN (${subjects})`)
   await client.query(`DELETE FROM subject_translations WHERE subject_id IN (${subjects})`)
   await client.query(`DELETE FROM subjects WHERE code LIKE '%-${suffix}'`)
   await client.query('DELETE FROM audit_events WHERE actor_user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM auth_refresh_tokens WHERE session_id IN (SELECT id FROM auth_sessions WHERE user_id = ANY($1::bigint[]))', [userIds])
   await client.query('DELETE FROM auth_sessions WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM user_phones WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM user_roles WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM user_profiles WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [userIds])
}

test('question package import integration (M09)', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   const storage = createMemoryStorageProvider()
   const overrides = { storage }
   const sharedPng = createPng(3, 2, 7)
   const files = { 'assets/shared.png': sharedPng }

   async function count(sql, params = []) {
      return (await client.query(sql, params)).rows[0].total
   }

   async function footprint() {
      return {
         subjects: await count(`SELECT count(*)::integer AS total FROM subjects WHERE code LIKE '%-${suffix}'`),
         banks: await count(`SELECT count(*)::integer AS total FROM question_banks WHERE code LIKE '%-${suffix}'`),
         questions: await count('SELECT count(*)::integer AS total FROM questions WHERE created_by = ANY($1::bigint[])', [userIds]),
         runs: await count('SELECT count(*)::integer AS total FROM question_imports WHERE initiated_by = ANY($1::bigint[])', [userIds]),
         assets: await count('SELECT count(*)::integer AS total FROM assets WHERE uploaded_by = ANY($1::bigint[])', [userIds]),
         aliases: await count(`SELECT count(*)::integer AS total FROM asset_aliases WHERE source_namespace LIKE '%${suffix}%'`),
      }
   }

   let adminId
   let teacherId
   let studentId
   let blockedId
   const adminPhone = `+99290${randomInt(1000000, 9999999)}`
   try {
      adminId = await createUser(client, 'admin')
      teacherId = await createUser(client, 'teacher')
      studentId = await createUser(client, 'student')
      blockedId = await createUser(client, 'teacher', 'blocked')
      await client.query(
         'INSERT INTO user_phones (user_id, phone_e164, is_primary) VALUES ($1, $2, FALSE)',
         [adminId, adminPhone],
      )
      const bankCode = `bank-${suffix}`
      const valid = await packageFrom(manifest({ bankCode }), files)
      let firstRun

      await t.test('actor must be an active user with questions.manage', async () => {
         assert.equal(await resolveImportActorService(adminPhone), adminId)
         await assert.rejects(resolveImportActorService('+992000000001'), { code: 'IMPORT_ACTOR_FORBIDDEN' })
         await assert.rejects(dryRunQuestionImportService(studentId, valid), { code: 'IMPORT_ACTOR_FORBIDDEN' })
         await assert.rejects(runQuestionImportService(blockedId, valid, {}, overrides), { code: 'IMPORT_ACTOR_INACTIVE' })
      })

      await t.test('dry run validates all five types and writes nothing', async () => {
         const before = await footprint()
         const report = await dryRunQuestionImportService(adminId, valid)
         assert.equal(report.valid, true, JSON.stringify(report.errors))
         assert.equal(report.counters.questions.total, 5)
         assert.equal(report.counters.questions.created, 5)
         assert.equal(report.counters.subjects.created, 1)
         assert.equal(report.counters.topics.created, 2)
         assert.equal(report.counters.assets.uploaded, 1)
         assert.equal(report.counters.answerKeys.proposed, 1)
         assert.equal(report.counters.answerKeys.unknown, 4)
         assert.deepEqual(report.topWarningCodes, [{ code: 'CONTENT_TABLE_HEADER_FLATTENED', count: 1 }])
         assert.deepEqual(await footprint(), before)
         assert.equal(storage.objects.size, 0)
      })

      await t.test('the committed sample fixture passes a dry run', async () => {
         const sample = await loadQuestionPackage(path.resolve('tests/fixtures/question-import/sample'))
         const report = await dryRunQuestionImportService(adminId, sample)
         assert.equal(report.valid, true, JSON.stringify(report.errors))
         assert.equal(report.counters.questions.total, 5)
      })

      await t.test('real run imports drafts, images, keys and records the run', async () => {
         firstRun = await runQuestionImportService(adminId, valid, { idempotencyKey: `first-${suffix}` }, overrides)
         assert.equal(firstRun.status, 'completed', JSON.stringify(firstRun.errors))
         assert.equal(firstRun.counters.questions.created, 5)
         assert.equal(firstRun.counters.batches.committed, 1)
         const rows = (await client.query(
            'SELECT id, external_id, status, import_id, source_metadata FROM questions WHERE bank_id = $1 ORDER BY external_id',
            [firstRun.bankId],
         )).rows
         assert.equal(rows.length, 5)
         assert.ok(rows.every((row) => row.status === 'draft' && row.import_id === firstRun.runId))
         assert.deepEqual(rows.find((row) => row.external_id === 'q-single').source_metadata, {
            book: 'Synthetic', page: 3, number: '1', bookSectionTitle: 'II', year: 2024,
         })
         const keys = (await client.query(
            `SELECT question.external_id, answer_key.status, answer_key.source, answer_key.verified_by
             FROM question_answer_keys AS answer_key JOIN questions AS question ON question.id = answer_key.question_id
             WHERE question.bank_id = $1`,
            [firstRun.bankId],
         )).rows
         assert.equal(keys.find((row) => row.external_id === 'q-single').status, 'proposed')
         assert.ok(keys.every((row) => row.status !== 'verified' && row.verified_by === null))
         // One asset (sha256 filled) shared by two questions, one alias, one stored object.
         const assets = (await client.query('SELECT id, sha256, status FROM assets WHERE uploaded_by = $1', [adminId])).rows
         assert.equal(assets.length, 1)
         assert.match(assets[0].sha256, /^[a-f0-9]{64}$/)
         assert.equal(assets[0].status, 'ready')
         assert.equal(await count('SELECT count(*)::integer AS total FROM question_assets WHERE asset_id = $1', [assets[0].id]), 2)
         assert.equal(await count('SELECT count(*)::integer AS total FROM asset_aliases WHERE source_namespace = $1', [namespace]), 1)
         assert.equal(storage.objects.size, 1)
         const run = (await client.query('SELECT status, is_dry_run, counters FROM question_imports WHERE id = $1', [firstRun.runId])).rows[0]
         assert.equal(run.status, 'completed')
         assert.equal(run.is_dry_run, false)
         assert.equal(run.counters.questions.created, 5)
         assert.equal(await count(
            `SELECT count(*)::integer AS total FROM question_import_errors WHERE import_id = $1 AND severity = 'warning'
               AND error_code = 'CONTENT_TABLE_HEADER_FLATTENED'`,
            [firstRun.runId],
         ), 1)
      })

      await t.test('same key and hash replays; same key with another package conflicts', async () => {
         const before = await footprint()
         const replay = await runQuestionImportService(adminId, valid, { idempotencyKey: `first-${suffix}` }, overrides)
         assert.equal(replay.replayed, true)
         assert.equal(replay.run.id, firstRun.runId)
         assert.deepEqual(await footprint(), before)
         const changed = await packageFrom(manifest({ bankCode, questionList: questions('q').slice(0, 2) }), files)
         await assert.rejects(
            runQuestionImportService(adminId, changed, { idempotencyKey: `first-${suffix}` }, overrides),
            { code: 'IMPORT_IDEMPOTENCY_CONFLICT' },
         )
      })

      await t.test('re-import updates drafts in place and skips published/archived questions', async () => {
         const ids = Object.fromEntries((await client.query(
            'SELECT external_id, id FROM questions WHERE bank_id = $1',
            [firstRun.bankId],
         )).rows.map((row) => [row.external_id, row.id]))
         await verifyAnswerKeyService(adminId, ids['q-single'], { source: 'official_key' })
         await publishQuestionService(adminId, ids['q-single'])
         await client.query(
            `UPDATE question_answer_keys SET status = 'proposed', source = 'official_key', answer_data = '{"value": 2}'
             WHERE question_id = $1`,
            [ids['q-numeric']],
         )
         await verifyAnswerKeyService(adminId, ids['q-numeric'], { source: 'official_key' })
         await publishQuestionService(adminId, ids['q-numeric'])
         await archiveQuestionService(adminId, ids['q-numeric'])

         const list = questions('q')
         list[1].options[0].content = text('one (edited)')
         const second = await packageFrom(manifest({ bankCode, questionList: list }), files)
         const result = await runQuestionImportService(adminId, second, { idempotencyKey: `second-${suffix}` }, overrides)
         assert.equal(result.status, 'completed', JSON.stringify(result.errors))
         assert.equal(result.counters.questions.created, 0)
         assert.equal(result.counters.questions.updated, 3)
         assert.equal(result.counters.questions.skippedImmutable, 2)
         assert.equal(result.counters.assets.reusedByAlias, 1)
         assert.equal(result.counters.assets.uploaded, 0)
         assert.equal(result.warnings.filter((entry) => entry.code === 'QUESTION_IMMUTABLE_SKIPPED').length, 2)
         const option = (await client.query(
            `SELECT content FROM question_options WHERE question_id = $1 AND option_key = 'a'`,
            [ids['q-multiple']],
         )).rows[0]
         assert.deepEqual(option.content, text('one (edited)'))
         const statuses = Object.fromEntries((await client.query(
            'SELECT external_id, status, import_id FROM questions WHERE bank_id = $1',
            [firstRun.bankId],
         )).rows.map((row) => [row.external_id, row]))
         assert.equal(statuses['q-single'].status, 'published')
         assert.equal(statuses['q-single'].import_id, firstRun.runId)
         assert.equal(statuses['q-numeric'].status, 'archived')
         assert.equal(statuses['q-multiple'].import_id, result.runId)
         assert.equal(await count('SELECT count(*)::integer AS total FROM questions WHERE bank_id = $1', [firstRun.bankId]), 5)
      })

      await t.test('same bytes in another namespace reuse the asset by sha256', async () => {
         const other = await packageFrom(manifest({
            bankCode: `bank2-${suffix}`,
            prefix: 'other',
            sourceNamespace: `other:${suffix}`,
         }), files)
         const result = await runQuestionImportService(adminId, other, {}, overrides)
         assert.equal(result.status, 'completed', JSON.stringify(result.errors))
         assert.equal(result.counters.assets.reusedByHash, 1)
         assert.equal(result.counters.assets.uploaded, 0)
         assert.equal(await count('SELECT count(*)::integer AS total FROM assets WHERE uploaded_by = $1', [adminId]), 1)
         assert.equal(storage.objects.size, 1)
         assert.equal(result.counters.subjects.unchanged, 1)
         assert.equal(result.counters.topics.unchanged, 2)
      })

      await t.test('alias pointing to other bytes is rejected', async () => {
         const conflict = await packageFrom(manifest({ bankCode }), { 'assets/shared.png': createPng(3, 2, 99) })
         const report = await dryRunQuestionImportService(adminId, conflict)
         assert.equal(report.valid, false)
         assert.ok(report.errors.some((entry) => entry.code === 'ASSET_ALIAS_CONFLICT'))
      })

      await t.test('invalid packages are rejected with paths and write nothing', async () => {
         const before = await footprint()
         const broken = questions('bad')
         delete broken[0].externalId
         broken[1].externalId = 'dup'
         broken[2].externalId = 'dup'
         broken[3].content = { blocks: [{ type: 'text', text: 'x', html: '<b>x</b>' }] }
         broken[4].answerKey = { status: 'verified', source: 'official_key', answerData: { acceptedAnswers: ['x'] } }
         const extra = [
            { ...questions('bad2')[0], answerKey: { status: 'proposed', source: 'official_key', answerData: { optionKey: 'z' } } },
            { ...questions('bad3')[0], topicCodes: ['missing-topic'] },
            { ...questions('bad4')[0], options: [{ key: 'a', content: text('a'), isCorrect: true }, { key: 'b', content: text('b') }] },
            { ...questions('bad5')[0], content: { blocks: [{ type: 'image', asset: 'nope' }] } },
            { ...questions('bad6')[0], type: 'essay' },
         ]
         const invalid = await packageFrom(manifest({ bankCode: `bank3-${suffix}`, questionList: [...broken, ...extra] }), files)
         const result = await runQuestionImportService(adminId, invalid, {}, overrides)
         assert.equal(result.status, 'rejected')
         const codes = result.errors.map((entry) => entry.code)
         for (const code of [
            'QUESTION_EXTERNAL_ID_REQUIRED',
            'QUESTION_EXTERNAL_ID_DUPLICATE',
            'VALIDATION_ERROR',
            'ANSWER_KEY_VERIFIED_REJECTED',
            'ANSWER_KEY_INVALID',
            'REFERENCE_UNKNOWN',
            'OPTION_IS_CORRECT_REJECTED',
         ]) assert.ok(codes.includes(code), `${code} missing from ${codes}`)
         assert.ok(result.errors.find((entry) => entry.code === 'QUESTION_EXTERNAL_ID_REQUIRED').path.startsWith('questions[0]'))
         assert.ok(result.errors.every((entry) => !entry.message.includes('Synthetic')))
         assert.deepEqual(await footprint(), before)

         const wrongVersion = await packageFrom({ ...manifest({ bankCode }), schemaVersion: 'v0' }, files)
         assert.equal((await dryRunQuestionImportService(adminId, wrongVersion)).errors[0].code, 'PACKAGE_SCHEMA_VERSION_UNSUPPORTED')
         const malformed = await writePackageDirectory('{ not json', {})
         directories.push(malformed)
         await assert.rejects(loadQuestionPackage(malformed), { code: 'PACKAGE_JSON_INVALID' })
         const unknownField = await packageFrom({ ...manifest({ bankCode }), extra: 1 }, files)
         assert.equal((await dryRunQuestionImportService(adminId, unknownField)).errors[0].code, 'PACKAGE_FIELD_UNKNOWN')
         const badHash = await packageFrom(manifest({
            bankCode,
            assets: [{ id: 'fig-shared', file: 'assets/shared.png', mimeType: 'image/png', sha256: '0'.repeat(64) }],
         }), files)
         assert.ok((await dryRunQuestionImportService(adminId, badHash)).errors.some((entry) => entry.code === 'ASSET_HASH_MISMATCH'))
         const notImage = await packageFrom(manifest({ bankCode }), { 'assets/shared.png': Buffer.from('not an image') })
         assert.ok((await dryRunQuestionImportService(adminId, notImage)).errors.some((entry) => entry.code === 'ASSET_TYPE_INVALID'))
      })

      await t.test('teachers cannot create taxonomy or write into banks of others', async () => {
         const newSubject = await packageFrom(manifest({
            bankCode: `bank4-${suffix}`,
            subjects: [{ code: `imp-new-${suffix}`, translations: { tg: { title: 'Нав' } } }],
         }), files)
         const report = await dryRunQuestionImportService(teacherId, newSubject)
         assert.ok(report.errors.some((entry) => entry.code === 'TAXONOMY_PERMISSION_REQUIRED'))
         const foreignBank = await packageFrom(manifest({ bankCode, subjects: [] }), files)
         const foreign = await runQuestionImportService(teacherId, foreignBank, {}, overrides)
         assert.equal(foreign.status, 'rejected')
         assert.ok(foreign.errors.some((entry) => entry.code === 'QUESTION_BANK_READ_ONLY'))
      })

      await t.test('a failing batch rolls back completely; a re-run is idempotent', async () => {
         const list = Array.from({ length: 5 }, (_, index) => ({
            externalId: `batch-${index}`,
            type: 'short_text',
            content: text(`Batch question ${index}`),
            topicCodes: ['organelles'],
         }))
         const batchPackage = await packageFrom(manifest({ bankCode: `bank5-${suffix}`, questionList: list, assets: [] }), {})
         const faulty = {
            ...overrides,
            questions: {
               ...questionBankRepository,
               async replaceTopics(questionId, subjectIdValue, topicIds, db) {
                  const row = await questionBankRepository.findQuestion(questionId, db)
                  if (row.external_id === 'batch-3') throw new Error('Simulated failure')
                  return questionBankRepository.replaceTopics(questionId, subjectIdValue, topicIds, db)
               },
            },
         }
         const failed = await runQuestionImportService(adminId, batchPackage, { batchSize: 2, idempotencyKey: `batch-a-${suffix}` }, faulty)
         assert.equal(failed.status, 'failed')
         assert.deepEqual(failed.counters.batches, { size: 2, committed: 1, failed: 1 })
         assert.equal(failed.counters.questions.created, 2)
         assert.equal(failed.counters.questions.failed, 2)
         assert.equal(failed.counters.questions.notAttempted, 1)
         const stored = (await client.query(
            'SELECT external_id FROM questions WHERE bank_id = $1 ORDER BY external_id',
            [failed.bankId],
         )).rows.map((row) => row.external_id)
         assert.deepEqual(stored, ['batch-0', 'batch-1'])
         const errors = (await client.query(
            `SELECT error_code, record_path, external_id, message FROM question_import_errors
             WHERE import_id = $1 AND severity = 'error'`,
            [failed.runId],
         )).rows
         assert.equal(errors.length, 1)
         assert.equal(errors[0].error_code, 'IMPORT_BATCH_FAILED')
         assert.equal(errors[0].record_path, 'questions[2..3]')
         assert.equal(errors[0].external_id, 'batch-3')
         assert.ok(!errors[0].message.includes('Simulated'))
         assert.equal((await client.query('SELECT status FROM question_imports WHERE id = $1', [failed.runId])).rows[0].status, 'failed')

         const rerun = await runQuestionImportService(adminId, batchPackage, { batchSize: 2, idempotencyKey: `batch-b-${suffix}` }, overrides)
         assert.equal(rerun.status, 'completed')
         assert.equal(rerun.counters.questions.updated, 2)
         assert.equal(rerun.counters.questions.created, 3)
         assert.equal(await count('SELECT count(*)::integer AS total FROM questions WHERE bank_id = $1', [failed.bankId]), 5)
      })

      await t.test('duplicate suggestions are recorded, never merged', async () => {
         const twin = (externalId) => ({
            externalId,
            type: 'single_choice',
            content: text('Same   question TEXT'),
            options: [{ key: 'a', content: text('x') }, { key: 'b', content: text('y') }],
         })
         const variant = twin('dup-c')
         variant.options[1].content = text('z')
         const duplicates = await packageFrom(manifest({
            bankCode: `bank6-${suffix}`,
            assets: [],
            questionList: [twin('dup-a'), { ...twin('dup-b'), content: text('same question text') }, variant],
         }), {})
         const result = await runQuestionImportService(adminId, duplicates, {}, overrides)
         assert.equal(result.status, 'completed', JSON.stringify(result.errors))
         assert.equal(result.counters.duplicates.suggested, 1)
         assert.equal(result.counters.questions.created, 3)
         const links = (await client.query(
            `SELECT link.marked_by, source.external_id AS question, target.external_id AS duplicate_of
             FROM question_duplicate_links AS link
             JOIN questions AS source ON source.id = link.question_id
             JOIN questions AS target ON target.id = link.duplicate_of_id
             WHERE source.bank_id = $1`,
            [result.bankId],
         )).rows
         assert.deepEqual(links, [{ marked_by: adminId, question: 'dup-b', duplicate_of: 'dup-a' }])
      })

      await t.test('ZIP packages load like directories', async () => {
         const zipPath = path.join(os.tmpdir(), `everest-import-${suffix}.zip`)
         await writeFile(zipPath, createZip([
            { name: 'pkg/manifest.json', data: Buffer.from(JSON.stringify(manifest({ bankCode }))) },
            { name: 'pkg/assets/shared.png', data: sharedPng, deflate: false },
         ]))
         directories.push(zipPath)
         const zipped = await loadQuestionPackage(zipPath)
         assert.match(zipped.sha256, /^[a-f0-9]{64}$/)
         assert.equal(zipped.files.get('assets/shared.png').equals(sharedPng), true)
         assert.equal((await dryRunQuestionImportService(adminId, zipped)).valid, true)
         const evilPath = path.join(os.tmpdir(), `everest-import-evil-${suffix}.zip`)
         await writeFile(evilPath, createZip([{ name: '../manifest.json', data: Buffer.from('{}') }]))
         directories.push(evilPath)
         await assert.rejects(loadQuestionPackage(evilPath), { code: 'PACKAGE_ARCHIVE_INVALID' })
      })

      await t.test('real entity-file format imports with mapped content and warnings', async () => {
         const entityBank = `book-${suffix}`
         const { manifest: entityManifest, files: entityFiles } = entityPackage({
            subjectCode: `imp-book-${suffix}`,
            bankCode: entityBank,
            namespace: `book:${suffix}`,
            png: createPng(5, 4, 21),
            answerKeys: {
               'single-0002': { status: 'proposed', source: 'official_key', answerDataExternal: { optionKeys: ['c'] } },
            },
         })
         const pkg = await packageFrom(entityManifest, entityFiles)
         const dry = await dryRunQuestionImportService(adminId, pkg)
         assert.equal(dry.valid, true, JSON.stringify(dry.errors))
         assert.equal(dry.counters.duplicates.declared, 1)

         const result = await runQuestionImportService(adminId, pkg, {}, overrides)
         assert.equal(result.status, 'completed', JSON.stringify(result.errors))
         assert.equal(result.counters.questions.created, 5)
         assert.equal(result.counters.duplicates.declared, 1)
         assert.equal(result.counters.answerKeys.proposed, 1)
         for (const code of ['CONTENT_INLINE_MARKS_FLATTENED', 'MATCHING_RULE_UNSPECIFIED', 'IMAGE_BLOCK_APPENDED', 'QUESTION_TYPE_MAPPED', 'SOURCE_FIELD_DROPPED']) {
            assert.ok(result.topWarningCodes.some((entry) => entry.code === code), `${code} missing`)
         }
         const rows = Object.fromEntries((await client.query(
            `SELECT external_id, id, question_type, status, content, interaction_settings, source_metadata
             FROM questions WHERE bank_id = $1`,
            [result.bankId],
         )).rows.map((row) => [row.external_id.replace(`${entityBank}-`, ''), row]))
         assert.equal(rows['open-0001'].question_type, 'short_text')
         assert.deepEqual(rows['open-0001'].content.blocks[0], { type: 'verse', lines: ['Line one', 'Line two'] })
         assert.deepEqual(rows['matching-0001'].interaction_settings, { requireAllLeft: true, allowRightReuse: null })
         assert.equal(rows['single-0001'].source_metadata.bookSectionTitle, 'Synthetic section')
         assert.ok(Object.values(rows).every((row) => row.status === 'draft'))
         // One stored figure, linked to both questions (block in one, appended in the other).
         const links = (await client.query(
            `SELECT link.asset_id, asset.sha256, asset.source_metadata FROM question_assets AS link
             JOIN assets AS asset ON asset.id = link.asset_id
             WHERE link.question_id = ANY($1::bigint[])`,
            [[rows['single-0001'].id, rows['single-0002'].id]],
         )).rows
         assert.equal(links.length, 2)
         assert.equal(new Set(links.map((link) => link.asset_id)).size, 1)
         assert.equal(links[0].source_metadata.package.extractionMethod, 'synthetic')
         const declared = (await client.query(
            'SELECT reason, marked_by FROM question_duplicate_links WHERE question_id = $1 AND duplicate_of_id = $2',
            [rows['single-0003'].id, rows['single-0001'].id],
         )).rows
         assert.deepEqual(declared, [{ reason: 'synthetic full-text duplicate', marked_by: adminId }])
         const key = (await client.query('SELECT status, source, answer_data FROM question_answer_keys WHERE question_id = $1', [rows['single-0002'].id])).rows[0]
         assert.deepEqual(key, { status: 'proposed', source: 'official_key', answer_data: { optionKey: 'c' } })

         // An unstated matching rule blocks publication even with a verified key.
         const matchingId = rows['matching-0001'].id
         await replaceAnswerKeyService(adminId, matchingId, {
            answerData: { pairs: [{ left: 'l1', right: 'r1' }, { left: 'l2', right: 'r2' }] },
            source: 'official_key',
         })
         await verifyAnswerKeyService(adminId, matchingId, { source: 'official_key' })
         await assert.rejects(publishQuestionService(adminId, matchingId), (error) => {
            assert.equal(error.code, 'QUESTION_NOT_PUBLISHABLE')
            assert.equal(error.details[0].message, 'INTERACTION_SETTINGS_INCOMPLETE')
            return true
         })

         const tampered = await packageFrom(entityManifest, {
            ...entityFiles,
            'data/question_topics.json': Buffer.from(entityFiles['data/question_topics.json'].toString().split('topic-a').join('topic-missing')),
         })
         const rejected = await dryRunQuestionImportService(adminId, tampered)
         assert.equal(rejected.valid, false)
         assert.ok(rejected.errors.some((entry) => entry.code === 'PACKAGE_FILE_HASH_MISMATCH'))
         assert.ok(rejected.errors.some((entry) => entry.path.startsWith('data/questions.part001.json#records[')))
      })

      await t.test('imports never publish or verify', async () => {
         const published = await count(
            `SELECT count(*)::integer AS total FROM questions
             WHERE created_by = $1 AND status <> 'draft' AND external_id NOT IN ('q-single', 'q-numeric')`,
            [adminId],
         )
         assert.equal(published, 0)
         assert.equal(await count(
            `SELECT count(*)::integer AS total FROM question_answer_keys AS answer_key
             JOIN questions AS question ON question.id = answer_key.question_id
             WHERE question.created_by = $1 AND answer_key.status = 'verified'
               AND question.external_id NOT IN ('q-single', 'q-numeric')
               AND question.external_id NOT LIKE 'book-%-matching-0001'`,
            [adminId],
         ), 0)
      })

      await t.test('read API lists runs, counters and paginated errors with scope', async () => {
         const server = await new Promise((resolve) => {
            const listener = createApp({ authProtection: { config }, telegramAuth: { config } })
               .listen(0, '127.0.0.1', () => resolve(listener))
         })
         try {
            const session = (userId) => withTransaction((db) => issueSessionService({
               userId,
               requestContext: { userAgent: 'M09 integration', ipAddress: '127.0.0.1' },
               client: db,
            }, { config }))
            const api = async (path, userId) => {
               const auth = await session(userId)
               const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1${path}`, {
                  headers: { authorization: `Bearer ${auth.accessToken}` },
               })
               return { status: response.status, body: await response.json() }
            }
            const list = await api(`/admin/question-imports?bankId=${firstRun.bankId}`, adminId)
            assert.equal(list.status, 200, JSON.stringify(list.body))
            assert.ok(list.body.data.imports.some((run) => run.id === firstRun.runId))
            const one = await api(`/admin/question-imports/${firstRun.runId}`, adminId)
            assert.equal(one.status, 200)
            assert.equal(one.body.data.counters.questions.created, 5)
            assert.equal(one.body.data.manifest.bankCode, bankCode)
            const page = await api(`/admin/question-imports/${firstRun.runId}/errors?limit=1&severity=warning`, adminId)
            assert.equal(page.status, 200)
            assert.equal(page.body.data.entries[0].code, 'CONTENT_TABLE_HEADER_FLATTENED')
            assert.equal(page.body.data.pagination.limit, 1)
            assert.equal((await api('/admin/question-imports', studentId)).status, 403)
            assert.equal((await api(`/admin/question-imports/${firstRun.runId}`, teacherId)).status, 404)
            assert.equal((await api('/admin/question-imports/abc', adminId)).body.error.code, 'INVALID_IMPORT_ID')
         } finally {
            await new Promise((resolve) => server.close(resolve))
         }
      })
   } finally {
      await cleanup(client)
      await client.end()
      for (const directory of directories) await rm(directory, { recursive: true, force: true })
   }
})
