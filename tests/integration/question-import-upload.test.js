import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import pg from 'pg'

import { createApp } from '../../src/app.js'
import env from '../../src/configs/env.js'
import { startQuestionImportWorker } from '../../src/jobs/question-import-worker.js'
import { withTransaction } from '../../src/repositories/transaction-repository.js'
import { issueSessionService } from '../../src/services/auth/session-service.js'
import { runQuestionImportService } from '../../src/services/question-import-service.js'
import { processNextQuestionImportService } from '../../src/services/question-import-upload-service.js'
import AppError from '../../src/utils/app-error.js'
import { loadQuestionPackage, parseQuestionPackageBuffer } from '../../src/utils/question-package.js'
import { readZipEntries } from '../../src/utils/zip-reader.js'
import { createPng, createZip } from '../helpers/import-fixtures.js'
import { createMemoryStorageProvider } from '../helpers/memory-storage-provider.js'

const { Client } = pg
const suffix = randomUUID().slice(0, 8)
const subjectCode = `upload-${suffix}`
const config = {
   ...env,
   jwtAccessSecret: 'question-import-upload-secret-longer-than-32-chars',
   authSessionTtlSeconds: 900,
   authRefreshTtlSeconds: 86400,
   authAdminRateLimit: 1000,
   questionImportRateLimit: 1000,
}
const text = (value) => ({ blocks: [{ type: 'text', text: value }] })
const base = '/admin/question-imports/packages'

function question(externalId, extra = {}) {
   return {
      externalId,
      type: 'single_choice',
      content: text(`Question ${externalId}`),
      options: [{ key: 'a', content: text('one') }, { key: 'b', content: text('two') }],
      ...extra,
   }
}

function manifest(bankCode, questions, extra = {}) {
   return {
      schemaVersion: 'everest.question-import.v1',
      sourceNamespace: `upload-${suffix}`,
      subjects: [{ code: subjectCode, color: 'green', translations: { tg: { title: 'Боргузорӣ' } } }],
      bank: { code: bankCode, title: 'Upload bank', subjectCode },
      questions,
      ...extra,
   }
}

function zip(value, files = {}) {
   return createZip([
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(value)) },
      ...Object.entries(files).map(([name, data]) => ({ name, data })),
   ])
}

test('question package upload integration', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   const directory = await mkdtemp(path.join(os.tmpdir(), 'everest-import-'))
   const storage = createMemoryStorageProvider()
   const overrides = { storage, uploadDirectory: directory, maxUploadBytes: 1024 * 1024 }
   const servers = []

   async function serve(questionImports, limits = {}) {
      const appConfig = { ...config, ...limits }
      const server = await new Promise((resolve) => {
         const app = createApp({
            authProtection: { config: appConfig },
            telegramAuth: { config: appConfig },
            questionImports,
         })
         const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
      })
      servers.push(server)
      return server.address().port
   }

   const port = await serve(overrides)
   t.after(async () => {
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
      await client.end()
      await rm(directory, { recursive: true, force: true })
   })

   async function createUser(role) {
      const { rows } = await client.query(
         `INSERT INTO users (status, onboarding_completed_at)
          VALUES ('active', CURRENT_TIMESTAMP) RETURNING id`,
      )
      await client.query(
         'INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2',
         [rows[0].id, role],
      )
      return rows[0].id
   }

   const issue = (userId) => withTransaction((transactionClient) => issueSessionService({
      userId,
      requestContext: { userAgent: 'upload integration', ipAddress: '127.0.0.1' },
      client: transactionClient,
   }, { config }))

   const adminId = await createUser('admin')
   const admin = await issue(adminId)
   const secondAdmin = await issue(await createUser('admin'))
   const student = await issue(await createUser('student'))

   async function send(method, url, session, body, headers = {}, targetPort = port) {
      const response = await fetch(`http://127.0.0.1:${targetPort}/api/v1${url}`, {
         method,
         headers: { authorization: `Bearer ${session.accessToken}`, ...headers },
         ...(body === undefined ? {} : { body }),
      })
      return { status: response.status, body: await response.json() }
   }

   const upload = (buffer, session = admin, query = '', targetPort = port) => send(
      'POST',
      `${base}${query}`,
      session,
      buffer,
      { 'content-type': 'application/zip' },
      targetPort,
   )
   const confirm = (id, session = admin, targetPort = port) => send('POST', `${base}/${id}/confirm`, session, '{}', { 'content-type': 'application/json' }, targetPort)
   const status = (id) => send('GET', `${base}/${id}`, admin)
   const questionCount = async (bankCode) => Number((await client.query(
      `SELECT count(*) FROM questions q JOIN question_banks b ON b.id = q.bank_id WHERE b.code = $1`,
      [bankCode],
   )).rows[0].count)
   const process = () => processNextQuestionImportService(overrides)

   await t.test('a valid package goes through upload, confirm and the background run', async () => {
      const bank = `upload-valid-${suffix}`
      const buffer = zip(manifest(bank, [question('v1'), question('v2')]))
      const created = await upload(buffer)
      assert.equal(created.status, 201, JSON.stringify(created.body))
      const { upload: row, duplicate } = created.body.data
      assert.equal(duplicate, false)
      assert.equal(row.status, 'validated')
      assert.equal(row.dryRun.valid, true)
      assert.equal(row.dryRun.counters.questions.total, 2)
      assert.equal(row.runId, null)
      assert.equal(await questionCount(bank), 0)
      assert.equal((await readdir(directory)).length, 1)

      const queued = await confirm(row.id)
      assert.equal(queued.status, 202)
      assert.equal(queued.body.data.status, 'queued')
      assert.equal((await confirm(row.id)).status, 202, 'confirm is idempotent while queued')
      const again = await upload(buffer)
      assert.equal(again.status, 200)
      assert.equal(again.body.data.duplicate, true)
      assert.equal(again.body.data.upload.id, row.id)

      assert.equal(await process(), row.id)
      assert.equal(await process(), null)
      const finished = (await status(row.id)).body.data
      assert.equal(finished.status, 'completed')
      assert.equal(await questionCount(bank), 2)
      assert.deepEqual(await readdir(directory), [], 'the stored package is removed')

      const run = await send('GET', `/admin/question-imports/${finished.runId}`, admin)
      assert.equal(run.body.data.status, 'completed')
      assert.equal(run.body.data.packageSha256, row.packageSha256)
      const audits = await client.query(
         `SELECT event_code AS code FROM audit_events WHERE entity_type = 'question_import_upload' AND entity_id = $1 ORDER BY id`,
         [row.id],
      )
      assert.deepEqual(audits.rows.map((event) => event.code), [
         'question_import.package_uploaded',
         'question_import.package_confirmed',
         'question_import.package_completed',
      ])
   })

   await t.test('a duplicate package replays the finished run', async () => {
      const bank = `upload-duplicate-${suffix}`
      const buffer = zip(manifest(bank, [question('d1')]))
      const first = (await upload(buffer)).body.data.upload
      await confirm(first.id)
      await process()
      const firstRun = (await status(first.id)).body.data.runId

      const second = (await upload(buffer)).body.data.upload
      assert.equal(second.previousRunId, firstRun)
      await confirm(second.id)
      await process()
      const replay = (await status(second.id)).body.data
      assert.equal(replay.status, 'completed')
      assert.equal(replay.runId, firstRun)
      assert.equal(await questionCount(bank), 1)
   })

   await t.test('malformed packages leave nothing behind', async () => {
      const before = (await readdir(directory)).length
      const garbage = await upload(Buffer.from('this is not a zip archive, only some text'))
      assert.equal(garbage.status, 400)
      assert.equal(garbage.body.error.code, 'PACKAGE_ARCHIVE_INVALID')

      const noManifest = await upload(createZip([{ name: 'readme.txt', data: Buffer.from('hi') }]))
      assert.equal(noManifest.body.error.code, 'PACKAGE_MANIFEST_MISSING')
      const badJson = await upload(createZip([{ name: 'manifest.json', data: Buffer.from('{ nope') }]))
      assert.equal(badJson.body.error.code, 'PACKAGE_JSON_INVALID')

      const invalid = await upload(zip(manifest(`upload-bad-${suffix}`, [{ externalId: 'x', type: 'nonsense', content: text('x') }])))
      assert.equal(invalid.status, 201)
      const row = invalid.body.data.upload
      assert.equal(row.status, 'rejected')
      assert.equal(row.dryRun.valid, false)
      assert.ok(row.dryRun.errors.length > 0)
      const refused = await confirm(row.id)
      assert.equal(refused.status, 409)
      assert.equal(refused.body.error.code, 'IMPORT_UPLOAD_NOT_CONFIRMABLE')
      assert.equal((await readdir(directory)).length, before)
   })

   await t.test('zip-slip and absolute paths are refused before anything is stored', async () => {
      const parent = path.dirname(directory)
      const before = await readdir(parent)
      for (const name of ['../evil.json', 'a/../../evil.json', '/etc/evil', 'C:/evil', 'a\\evil', `bad${String.fromCharCode(0)}name`]) {
         const response = await upload(createZip([
            { name: 'manifest.json', data: Buffer.from('{}') },
            { name, data: Buffer.from('x') },
         ]))
         assert.equal(response.status, 400, name)
         assert.equal(response.body.error.code, 'PACKAGE_ARCHIVE_INVALID', name)
      }
      assert.deepEqual(await readdir(parent), before)
   })

   await t.test('a decompression bomb is stopped by the total size limit', () => {
      const big = Buffer.alloc(4096)
      const archive = createZip([{ name: 'a', data: big }, { name: 'b', data: big }])
      assert.throws(
         () => readZipEntries(archive, { maxEntryBytes: 4096, maxTotalBytes: 5000 }),
         (error) => error instanceof AppError && error.code === 'PACKAGE_TOO_LARGE',
      )
   })

   await t.test('transport rules: content type, size, permission, ownership, rate limit', async () => {
      const wrongType = await send('POST', base, admin, 'hello', { 'content-type': 'text/plain' })
      assert.equal(wrongType.status, 415)
      assert.equal(wrongType.body.error.code, 'PACKAGE_CONTENT_TYPE_INVALID')

      const tooLarge = await upload(Buffer.alloc(1024 * 1024 + 1))
      assert.equal(tooLarge.status, 413)
      assert.equal(tooLarge.body.error.code, 'PACKAGE_TOO_LARGE')

      const forbidden = await upload(zip(manifest(`upload-forbidden-${suffix}`, [question('f1')])), student)
      assert.equal(forbidden.status, 403)
      assert.equal(forbidden.body.error.code, 'ACTION_FORBIDDEN')

      const cookieNoCsrf = await fetch(`http://127.0.0.1:${port}/api/v1${base}`, {
         method: 'POST',
         headers: { cookie: `everest_access=${admin.accessToken}`, 'content-type': 'application/zip' },
         body: Buffer.from('zip'),
      })
      assert.equal(cookieNoCsrf.status, 403)

      assert.equal((await send('GET', `${base}/nonsense`, admin)).body.error.code, 'INVALID_IMPORT_UPLOAD_ID')
      assert.equal((await send('GET', `${base}/999999999`, admin)).status, 404)

      const buffer = zip(manifest(`upload-owner-${suffix}`, [question('o1')]))
      const owned = (await upload(buffer)).body.data.upload
      const taken = await upload(buffer, secondAdmin)
      assert.equal(taken.status, 409)
      assert.equal(taken.body.error.code, 'IMPORT_PACKAGE_IN_PROGRESS')

      // An unconfirmed upload of the same bytes is replaced by the new one.
      const replaced = (await upload(buffer, admin, '?applyMatchingDefaults=true')).body.data.upload
      assert.notEqual(replaced.id, owned.id)
      assert.equal((await status(owned.id)).body.data.status, 'expired')
      assert.equal((await status(owned.id)).body.data.errorCode, 'IMPORT_UPLOAD_SUPERSEDED')

      const limitedPort = await serve(overrides, { questionImportRateLimit: 1 })
      const limitedUser = await issue(await createUser('admin'))
      await upload(Buffer.from('first'), limitedUser, '', limitedPort)
      const limited = await upload(Buffer.from('second'), limitedUser, '', limitedPort)
      assert.equal(limited.status, 429)
   })

   await t.test('without storage nothing is written, and images use storage when it exists', async () => {
      const bank = `upload-image-${suffix}`
      const image = createPng(2, 2, Number.parseInt(suffix.slice(0, 4), 16) % 251)
      const value = manifest(bank, [question('i1', {
         content: { blocks: [{ type: 'text', text: 'With image' }, { type: 'image', asset: 'fig' }] },
      })], { assets: [{ id: 'fig', file: 'assets/fig.png', mimeType: 'image/png' }] })
      const buffer = zip(value, { 'assets/fig.png': image })

      const unavailable = {
         uploadDirectory: directory,
         get storage() {
            throw new AppError(503, 'STORAGE_NOT_CONFIGURED', 'File storage is not configured')
         },
      }
      const noStoragePort = await serve(unavailable)
      const row = (await upload(buffer, admin, '', noStoragePort)).body.data.upload
      assert.equal(row.status, 'validated')
      assert.equal(row.dryRun.counters.assets.uploaded, 1)
      const refused = await confirm(row.id, admin, noStoragePort)
      assert.equal(refused.status, 503)
      assert.equal(refused.body.error.code, 'STORAGE_NOT_CONFIGURED')
      assert.equal((await status(row.id)).body.data.status, 'validated')

      // The shared importer enforces the same rule, so the CLI fails the same way.
      await assert.rejects(
         runQuestionImportService(adminId, parseQuestionPackageBuffer(buffer), {}, unavailable),
         { code: 'STORAGE_NOT_CONFIGURED' },
      )
      assert.equal(await questionCount(bank), 0)
      const runs = await client.query('SELECT count(*) FROM question_imports WHERE package_sha256 = $1', [row.packageSha256])
      assert.equal(runs.rows[0].count, '0')
      const banks = await client.query('SELECT count(*) FROM question_banks WHERE code = $1', [bank])
      assert.equal(banks.rows[0].count, '0')

      await confirm(row.id)
      await process()
      assert.equal((await status(row.id)).body.data.status, 'completed')
      const stored = await client.query(
         `SELECT storage_key, status FROM assets WHERE sha256 IS NOT NULL AND source_metadata->>'importExternalId' = 'fig'
          ORDER BY id DESC LIMIT 1`,
      )
      assert.equal(stored.rows[0].status, 'ready')
      assert.match(stored.rows[0].storage_key, /^question-imports\/sha256\//)
   })

   await t.test('matching defaults apply only when requested and are always reported', async () => {
      const bank = `upload-matching-${suffix}`
      const matching = {
         externalId: 'm1',
         type: 'matching',
         content: text('Match'),
         interactionSettings: { requireAllLeft: null, allowRightReuse: null },
         matching: {
            left: [{ key: 'l', content: text('left') }],
            right: [{ key: 'r', content: text('right') }],
         },
      }
      const buffer = zip(manifest(bank, [matching]))
      const settings = async () => (await client.query(
         `SELECT q.interaction_settings FROM questions q JOIN question_banks b ON b.id = q.bank_id WHERE b.code = $1`,
         [bank],
      )).rows[0].interaction_settings

      const plain = (await upload(buffer)).body.data.upload
      assert.ok(plain.dryRun.warnings.some((entry) => entry.code === 'MATCHING_RULE_UNSPECIFIED'))
      await confirm(plain.id)
      await process()
      assert.deepEqual(await settings(), { requireAllLeft: null, allowRightReuse: null })

      const invalidFlag = await upload(buffer, admin, '?applyMatchingDefaults=yes')
      assert.equal(invalidFlag.status, 400)

      const defaults = (await upload(buffer, admin, '?applyMatchingDefaults=true')).body.data.upload
      assert.ok(defaults.dryRun.warnings.some((entry) => entry.code === 'MATCHING_DEFAULTS_APPLIED'))
      assert.equal(defaults.previousRunId, null, 'the option makes it a different run')
      await confirm(defaults.id)
      await process()
      assert.equal((await status(defaults.id)).body.data.status, 'completed')
      assert.deepEqual(await settings(), { requireAllLeft: true, allowRightReuse: false })
   })

   await t.test('workers claim each package once; lost workers and old uploads are cleaned up', async () => {
      const queued = (await upload(zip(manifest(`upload-race-${suffix}`, [question('r1')])))).body.data.upload
      await confirm(queued.id)
      const results = await Promise.all([process(), process(), process()])
      assert.deepEqual(results.filter(Boolean), [queued.id])

      const lost = (await upload(zip(manifest(`upload-lost-${suffix}`, [question('l1')])))).body.data.upload
      await client.query(
         `UPDATE question_import_uploads SET status = 'running', lease_until = CURRENT_TIMESTAMP - interval '1 minute' WHERE id = $1`,
         [lost.id],
      )
      const old = (await upload(zip(manifest(`upload-old-${suffix}`, [question('e1')])))).body.data.upload
      await client.query(
         `UPDATE question_import_uploads SET expires_at = CURRENT_TIMESTAMP - interval '1 minute' WHERE id = $1`,
         [old.id],
      )
      await process()
      const lostRow = (await status(lost.id)).body.data
      assert.equal(lostRow.status, 'failed')
      assert.equal(lostRow.errorCode, 'IMPORT_WORKER_LOST')
      assert.equal((await status(old.id)).body.data.status, 'expired')
      assert.equal((await confirm(old.id)).body.error.code, 'IMPORT_UPLOAD_NOT_CONFIRMABLE')

      const live = await client.query(
         `SELECT stored_name FROM question_import_uploads WHERE stored_name IS NOT NULL`,
      )
      assert.deepEqual((await readdir(directory)).sort(), live.rows.map((row) => row.stored_name).sort())
   })

   await t.test('the worker loop drains the queue and stops', async () => {
      const queued = (await upload(zip(manifest(`upload-loop-${suffix}`, [question('w1')])))).body.data.upload
      await confirm(queued.id)
      const worker = startQuestionImportWorker({ intervalMs: 10, overrides })
      await new Promise((resolve) => { setTimeout(resolve, 300) })
      await worker.stop()
      assert.equal((await status(queued.id)).body.data.status, 'completed')
   })

   await t.test('the CLI loader and the upload parser agree on a ZIP file', async () => {
      const buffer = zip(manifest(`upload-cli-${suffix}`, [question('c1')]))
      const file = path.join(os.tmpdir(), `everest-cli-${suffix}.zip`)
      await writeFile(file, buffer)
      t.after(() => rm(file, { force: true }))
      const fromFile = await loadQuestionPackage(file)
      const fromBuffer = parseQuestionPackageBuffer(buffer)
      assert.equal(fromFile.sha256, fromBuffer.sha256)
      assert.deepEqual(fromFile.manifest, fromBuffer.manifest)
   })
})
