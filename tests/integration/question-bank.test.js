import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import pg from 'pg'

import { createApp } from '../../src/app.js'
import env from '../../src/configs/env.js'
import { withTransaction } from '../../src/repositories/transaction-repository.js'
import { issueSessionService } from '../../src/services/auth/session-service.js'

const { Client } = pg
const userIds = []
const suffix = randomUUID().slice(0, 8)
const config = {
   ...env,
   jwtAccessSecret: 'question-bank-integration-secret-longer-than-32-chars',
   authSessionTtlSeconds: 900,
   authRefreshTtlSeconds: 86400,
   authAdminRateLimit: 1000,
}

async function createUser(client, role, name) {
   const user = await client.query(
      `INSERT INTO users (status, onboarding_completed_at)
       VALUES ('active', CURRENT_TIMESTAMP) RETURNING id`,
   )
   const userId = user.rows[0].id
   userIds.push(userId)
   await client.query(
      `INSERT INTO user_profiles (user_id, first_name, last_name) VALUES ($1, $2, 'M08')`,
      [userId, name],
   )
   await client.query(
      'INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2',
      [userId, role],
   )
   return userId
}

async function issue(userId) {
   return withTransaction((client) => issueSessionService({
      userId,
      requestContext: { userAgent: 'M08 integration', ipAddress: '127.0.0.1' },
      client,
   }, { config }))
}

async function listen(app) {
   return new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
   })
}

function text(value) {
   return { blocks: [{ type: 'text', text: value }] }
}

// Published questions are immutable by trigger, so fixture cleanup disables the question
// guards inside one transaction. This is test-only maintenance SQL.
async function cleanup(client) {
   if (!userIds.length) return
   await client.query('BEGIN')
   try {
      for (const table of [
         'questions',
         'question_options',
         'question_matching_items',
         'question_answer_keys',
         'question_assets',
         'question_topics',
      ]) {
         await client.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`)
      }
      const questionFilter = 'question_id IN (SELECT id FROM questions WHERE created_by = ANY($1::bigint[]))'
      await client.query(`DELETE FROM question_assets WHERE ${questionFilter}`, [userIds])
      await client.query(`DELETE FROM question_topics WHERE ${questionFilter}`, [userIds])
      await client.query(`DELETE FROM question_answer_keys WHERE ${questionFilter}`, [userIds])
      await client.query(`DELETE FROM question_matching_items WHERE ${questionFilter}`, [userIds])
      await client.query(`DELETE FROM question_options WHERE ${questionFilter}`, [userIds])
      await client.query(
         `UPDATE questions SET source_question_id = NULL WHERE created_by = ANY($1::bigint[])`,
         [userIds],
      )
      await client.query('DELETE FROM questions WHERE created_by = ANY($1::bigint[])', [userIds])
      for (const table of [
         'questions',
         'question_options',
         'question_matching_items',
         'question_answer_keys',
         'question_assets',
         'question_topics',
      ]) {
         await client.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`)
      }
      await client.query('COMMIT')
   } catch (error) {
      await client.query('ROLLBACK')
      throw error
   }
   await client.query('DELETE FROM question_banks WHERE owner_id = ANY($1::bigint[])', [userIds])
   const subjects = `SELECT id FROM subjects WHERE code LIKE '%-${suffix}'`
   await client.query(`DELETE FROM topic_translations WHERE topic_id IN (SELECT id FROM topics WHERE subject_id IN (${subjects}))`)
   await client.query(`UPDATE topics SET parent_id = NULL WHERE subject_id IN (${subjects})`)
   await client.query(`DELETE FROM topics WHERE subject_id IN (${subjects})`)
   await client.query(`DELETE FROM section_translations WHERE section_id IN (SELECT id FROM sections WHERE subject_id IN (${subjects}))`)
   await client.query(`DELETE FROM sections WHERE subject_id IN (${subjects})`)
   await client.query(`DELETE FROM subject_translations WHERE subject_id IN (${subjects})`)
   await client.query(`DELETE FROM subjects WHERE code LIKE '%-${suffix}'`)
   await client.query('DELETE FROM assets WHERE uploaded_by = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM audit_events WHERE actor_user_id = ANY($1::bigint[]) OR subject_user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM auth_refresh_tokens WHERE session_id IN (SELECT id FROM auth_sessions WHERE user_id = ANY($1::bigint[]))', [userIds])
   await client.query('DELETE FROM auth_sessions WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM user_roles WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM user_profiles WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [userIds])
}

test('taxonomy, question banks, answer keys, review and publication integration', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   const dependencies = { authProtection: { config }, telegramAuth: { config } }
   const server = await listen(createApp(dependencies))
   const port = server.address().port

   async function api(method, path, session, body) {
      const headers = { 'content-type': 'application/json' }
      if (session) headers.authorization = `Bearer ${session.accessToken}`
      const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
         method,
         headers,
         ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      return { status: response.status, body: await response.json() }
   }

   function expect(response, status, code) {
      assert.equal(response.status, status, JSON.stringify(response.body))
      if (code) assert.equal(response.body.error.code, code)
      return response.body.data
   }

   t.after(async () => {
      await new Promise((resolve) => server.close(resolve))
      await cleanup(client)
      await client.end()
   })

   const adminId = await createUser(client, 'admin', 'Admin')
   const authorId = await createUser(client, 'teacher', 'Author')
   const readerId = await createUser(client, 'teacher', 'Reader')
   const studentId = await createUser(client, 'student', 'Student')
   const admin = await issue(adminId)
   const author = await issue(authorId)
   const reader = await issue(readerId)
   const student = await issue(studentId)

   let math
   let biology
   let algebraSection
   let equations
   let linear
   let cells
   await t.test('taxonomy is staff-only and admin-managed with subject consistency', async () => {
      expect(await api('GET', '/admin/subjects', student), 403, 'ACTION_FORBIDDEN')
      expect(await api('POST', '/admin/subjects', author, {
         code: `math-${suffix}`, translations: { tg: { title: 'Математика' } },
      }), 403, 'ACTION_FORBIDDEN')
      expect(await api('POST', '/admin/subjects', admin, {
         code: `math-${suffix}`, primaryLanguage: 'tg', translations: { ru: { title: 'Математика' } },
      }), 400, 'VALIDATION_ERROR')
      math = expect(await api('POST', '/admin/subjects', admin, {
         code: `math-${suffix}`,
         primaryLanguage: 'tg',
         translations: { tg: { title: 'Математика' }, ru: { title: 'Математика RU' } },
      }), 201)
      assert.equal(math.title, 'Математика')
      assert.deepEqual(math.translations.ru, { title: 'Математика RU' })
      expect(await api('POST', '/admin/subjects', admin, {
         code: `math-${suffix}`, translations: { tg: { title: 'Duplicate' } },
      }), 409, 'SUBJECT_CODE_CONFLICT')
      biology = expect(await api('POST', '/admin/subjects', admin, {
         code: `bio-${suffix}`, translations: { tg: { title: 'Биология' } },
      }), 201)
      const subjects = expect(await api('GET', '/admin/subjects', author), 200)
      assert.ok(subjects.subjects.some((subject) => subject.id === math.id))

      algebraSection = expect(await api('POST', `/admin/subjects/${math.id}/sections`, admin, {
         code: 'algebra', translations: { tg: { title: 'Алгебра' } },
      }), 201)
      assert.equal(algebraSection.subjectId, math.id)
      cells = expect(await api('POST', `/admin/subjects/${biology.id}/topics`, admin, {
         code: 'cells', translations: { tg: { title: 'Ҳуҷайра' } },
      }), 201)
      expect(await api('POST', `/admin/subjects/${biology.id}/topics`, admin, {
         code: 'wrong-section', sectionId: algebraSection.id, translations: { tg: { title: 'X' } },
      }), 422, 'TAXONOMY_SUBJECT_MISMATCH')
      equations = expect(await api('POST', `/admin/subjects/${math.id}/topics`, admin, {
         code: 'equations', sectionId: algebraSection.id, translations: { tg: { title: 'Муодилаҳо' } },
      }), 201)
      linear = expect(await api('POST', `/admin/subjects/${math.id}/topics`, admin, {
         code: 'linear', parentId: equations.id, translations: { tg: { title: 'Хаттӣ' } },
      }), 201)
      assert.equal(linear.parentId, equations.id)
      expect(await api('PATCH', `/admin/topics/${equations.id}`, admin, {
         parentId: linear.id,
      }), 409, 'TOPIC_CYCLE')
      expect(await api('PATCH', `/admin/topics/${equations.id}`, admin, {
         parentId: equations.id,
      }), 409, 'TOPIC_CYCLE')
      expect(await api('PATCH', `/admin/topics/${linear.id}`, admin, {
         parentId: cells.id,
      }), 422, 'TAXONOMY_SUBJECT_MISMATCH')
      const renamed = expect(await api('PATCH', `/admin/sections/${algebraSection.id}`, admin, {
         translations: { tg: { title: 'Алгебра 2' } },
      }), 200)
      assert.equal(renamed.title, 'Алгебра 2')
      expect(await api('PATCH', `/admin/sections/${algebraSection.id}`, admin, {
         primaryLanguage: 'ru',
      }), 400, 'VALIDATION_ERROR')
      const topics = expect(await api('GET', `/admin/subjects/${math.id}/topics`, author), 200)
      assert.equal(topics.topics.length, 2)
      expect(await api('DELETE', `/admin/sections/${algebraSection.id}`, admin), 409, 'SECTION_IN_USE')
   })

   let bank
   await t.test('banks are private to their owner until shared with staff', async () => {
      expect(await api('POST', '/admin/question-banks', student, {
         code: `bank-${suffix}`, title: 'Bank', subjectId: math.id,
      }), 403, 'ACTION_FORBIDDEN')
      bank = expect(await api('POST', '/admin/question-banks', author, {
         code: `bank-${suffix}`,
         title: 'Algebra book',
         subjectId: math.id,
         sourceMetadata: { book: 'Algebra 9', edition: '2024' },
      }), 201)
      assert.equal(bank.visibility, 'private')
      assert.equal(bank.permissions.manage, true)
      expect(await api('GET', `/admin/question-banks/${bank.id}`, reader), 404, 'QUESTION_BANK_NOT_FOUND')
      expect(await api('PATCH', `/admin/question-banks/${bank.id}`, author, {
         subjectId: biology.id,
      }), 400, 'VALIDATION_ERROR')
      expect(await api('PATCH', `/admin/question-banks/${bank.id}`, author, {
         visibility: 'staff',
      }), 200)
      const shared = expect(await api('GET', `/admin/question-banks/${bank.id}`, reader), 200)
      assert.equal(shared.permissions.manage, false)
      const adminView = expect(await api('GET', `/admin/question-banks/${bank.id}`, admin), 200)
      assert.equal(adminView.permissions.manage, true)
      expect(await api('PATCH', `/admin/question-banks/${bank.id}`, reader, {
         title: 'Hijack',
      }), 403, 'QUESTION_BANK_READ_ONLY')
   })

   let single
   await t.test('draft questions validate structure, topics and option correctness storage', async () => {
      const base = {
         questionType: 'single_choice',
         content: text('2 + 2 = ?'),
         options: [
            { key: 'a', content: text('3') },
            { key: 'b', content: text('4') },
         ],
         topicIds: [linear.id],
      }
      expect(await api('POST', `/admin/question-banks/${bank.id}/questions`, reader, base), 403, 'QUESTION_BANK_READ_ONLY')
      expect(await api('POST', `/admin/question-banks/${bank.id}/questions`, author, {
         ...base, topicIds: [cells.id],
      }), 422, 'TAXONOMY_SUBJECT_MISMATCH')
      expect(await api('POST', `/admin/question-banks/${bank.id}/questions`, author, {
         ...base, options: [{ key: 'a', content: text('3'), isCorrect: true }, { key: 'b', content: text('4') }],
      }), 400, 'VALIDATION_ERROR')
      expect(await api('POST', `/admin/question-banks/${bank.id}/questions`, author, {
         ...base, options: [{ key: 'a', content: text('3') }],
      }), 400, 'VALIDATION_ERROR')
      expect(await api('POST', `/admin/question-banks/${bank.id}/questions`, author, {
         ...base, content: { blocks: [{ type: 'script', text: 'x' }] },
      }), 400, 'VALIDATION_ERROR')
      expect(await api('POST', `/admin/question-banks/${bank.id}/questions`, author, {
         ...base, matching: { left: [], right: [] },
      }), 400, 'VALIDATION_ERROR')
      single = expect(await api('POST', `/admin/question-banks/${bank.id}/questions`, author, {
         ...base,
         externalId: 'algebra-9-001',
         difficulty: 2,
         difficultySource: 'expert',
         sourceMetadata: { book: 'Algebra 9', page: 12, number: '1' },
      }), 201)
      assert.equal(single.status, 'draft')
      assert.equal(single.subjectId, math.id)
      assert.equal(single.keyStatus, 'unknown')
      assert.deepEqual(single.options.map((option) => option.key), ['a', 'b'])
      assert.deepEqual(single.topicIds, [linear.id])
      expect(await api('POST', `/admin/question-banks/${bank.id}/questions`, author, {
         ...base, externalId: 'algebra-9-001',
      }), 409, 'QUESTION_EXTERNAL_ID_CONFLICT')
      const columns = await client.query(
         `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'question_options' AND column_name = 'is_correct'`,
      )
      assert.equal(columns.rowCount, 0)
   })

   await t.test('answer keys are proposed by authors, hidden from readers and verified by reviewers', async () => {
      expect(await api('PUT', `/admin/questions/${single.id}/answer-key`, author, {
         answerData: { optionKey: 'z' }, source: 'expert_review',
      }), 400, 'ANSWER_KEY_INVALID')
      expect(await api('PUT', `/admin/questions/${single.id}/answer-key`, author, {
         answerData: { optionKey: 'b' }, source: 'none',
      }), 400, 'VALIDATION_ERROR')
      const proposed = expect(await api('PUT', `/admin/questions/${single.id}/answer-key`, author, {
         answerData: { optionKey: 'b' },
         source: 'ai_inference',
         explanation: text('2 + 2 = 4'),
      }), 200)
      assert.equal(proposed.answerKey.status, 'proposed')
      assert.deepEqual(proposed.answerKey.answerData, { optionKey: 'b' })

      const readerResponse = await api('GET', `/admin/questions/${single.id}`, reader)
      const readerView = expect(readerResponse, 200)
      assert.equal(readerView.keyStatus, 'proposed')
      assert.equal(Object.hasOwn(readerView, 'answerKey'), false)
      assert.equal(JSON.stringify(readerResponse.body).includes('2 + 2 = 4'), false)
      const listed = expect(await api('GET', `/admin/question-banks/${bank.id}/questions?keyStatus=proposed`, reader), 200)
      assert.deepEqual(listed.questions.map((question) => question.id), [single.id])
      assert.equal(Object.hasOwn(listed.questions[0], 'answerKey'), false)

      expect(await api('POST', `/admin/questions/${single.id}/publish`, admin), 409, 'QUESTION_NOT_PUBLISHABLE')
      expect(await api('POST', `/admin/questions/${single.id}/answer-key/verify`, author, {
         source: 'expert_review',
      }), 403, 'ACTION_FORBIDDEN')
      expect(await api('POST', `/admin/questions/${single.id}/answer-key/verify`, admin, {
         source: 'ai_inference',
      }), 400, 'VALIDATION_ERROR')
      const verified = expect(await api('POST', `/admin/questions/${single.id}/answer-key/verify`, admin, {
         source: 'official_key',
      }), 200)
      assert.equal(verified.answerKey.status, 'verified')
      assert.equal(verified.answerKey.verifiedBy, adminId)
      expect(await api('POST', `/admin/questions/${single.id}/answer-key/verify`, admin, {
         source: 'official_key',
      }), 409, 'ANSWER_KEY_NOT_PROPOSED')

      const edited = expect(await api('PATCH', `/admin/questions/${single.id}`, author, {
         content: text('Сумма 2 + 2 = ?'),
      }), 200)
      assert.equal(edited.answerKey.status, 'proposed')
      assert.equal(edited.answerKey.verifiedBy, null)

      await assert.rejects(
         client.query(
            `UPDATE question_answer_keys SET status = 'verified', source = 'ai_inference',
               verified_by = $2, verified_at = CURRENT_TIMESTAMP
             WHERE question_id = $1`,
            [single.id, adminId],
         ),
         (error) => error.constraint === 'question_answer_keys_verified_source_check',
      )
   })

   await t.test('publication is guarded and published questions are immutable', async () => {
      expect(await api('POST', `/admin/questions/${single.id}/answer-key/verify`, admin, {
         source: 'expert_review',
      }), 200)
      expect(await api('POST', `/admin/questions/${single.id}/publish`, author), 403, 'ACTION_FORBIDDEN')
      const published = expect(await api('POST', `/admin/questions/${single.id}/publish`, admin), 200)
      assert.equal(published.status, 'published')
      expect(await api('POST', `/admin/questions/${single.id}/publish`, admin), 409, 'INVALID_QUESTION_TRANSITION')
      expect(await api('PATCH', `/admin/questions/${single.id}`, author, {
         content: text('changed'),
      }), 409, 'QUESTION_IMMUTABLE')
      expect(await api('PUT', `/admin/questions/${single.id}/answer-key`, author, {
         answerData: { optionKey: 'a' }, source: 'expert_review',
      }), 409, 'QUESTION_IMMUTABLE')
      expect(await api('DELETE', `/admin/questions/${single.id}`, author), 409, 'QUESTION_IMMUTABLE')
      await assert.rejects(
         client.query(`UPDATE questions SET content = '{"blocks":[]}' WHERE id = $1`, [single.id]),
         /QUESTION_IMMUTABLE/,
      )
      await assert.rejects(
         client.query(
            `UPDATE question_options SET content = '{"blocks":[]}' WHERE question_id = $1`,
            [single.id],
         ),
         /QUESTION_IMMUTABLE/,
      )
      const audit = await client.query(
         `SELECT event_code FROM audit_events
          WHERE entity_type = 'question' AND entity_id = $1 ORDER BY id`,
         [single.id],
      )
      assert.deepEqual(audit.rows.map((row) => row.event_code), [
         'question.created',
         'question.answer_key.updated',
         'question.answer_key.verified',
         'question.updated',
         'question.answer_key.verified',
         'question.published',
      ])
      const metadata = await client.query(
         `SELECT metadata::text AS metadata FROM audit_events
          WHERE entity_type = 'question' AND entity_id = $1`,
         [single.id],
      )
      assert.equal(metadata.rows.some((row) => row.metadata.includes('optionKey')), false)
   })

   await t.test('copies start as drafts with a key that must be verified again', async () => {
      const copy = expect(await api('POST', `/admin/questions/${single.id}/copy`, author), 201)
      assert.equal(copy.status, 'draft')
      assert.equal(copy.sourceQuestionId, single.id)
      assert.equal(copy.externalId, null)
      assert.equal(copy.answerKey.status, 'proposed')
      assert.deepEqual(copy.answerKey.answerData, { optionKey: 'b' })
      assert.deepEqual(copy.options.map((option) => option.key), ['a', 'b'])
      assert.deepEqual(copy.topicIds, [linear.id])
      expect(await api('DELETE', `/admin/questions/${copy.id}`, author), 200)
      expect(await api('GET', `/admin/questions/${copy.id}`, author), 404, 'QUESTION_NOT_FOUND')

      const second = expect(await api('POST', `/admin/questions/${single.id}/copy`, author), 201)
      expect(await api('POST', `/admin/questions/${second.id}/copy`, author), 201)
      expect(await api('DELETE', `/admin/questions/${second.id}`, author), 409, 'QUESTION_IN_USE')

      expect(await api('POST', `/admin/questions/${single.id}/archive`, admin), 200)
      expect(await api('POST', `/admin/questions/${single.id}/archive`, admin), 409, 'INVALID_QUESTION_TRANSITION')
   })

   await t.test('matching keys follow interaction rules and reset when items disappear', async () => {
      const matching = expect(await api('POST', `/admin/question-banks/${bank.id}/questions`, author, {
         questionType: 'matching',
         content: text('Match'),
         interactionSettings: { requireAllLeft: true, allowRightReuse: false },
         matching: {
            left: [{ key: '1', content: text('x + 1 = 2') }, { key: '2', content: text('x + 2 = 5') }],
            right: [{ key: 'a', content: text('1') }, { key: 'b', content: text('3') }],
         },
      }), 201)
      assert.equal(matching.matching.left.length, 2)
      expect(await api('PUT', `/admin/questions/${matching.id}/answer-key`, author, {
         answerData: { pairs: [{ left: '1', right: 'a' }] }, source: 'expert_review',
      }), 400, 'ANSWER_KEY_INVALID')
      expect(await api('PUT', `/admin/questions/${matching.id}/answer-key`, author, {
         answerData: { pairs: [{ left: '1', right: 'a' }, { left: '2', right: 'a' }] }, source: 'expert_review',
      }), 400, 'ANSWER_KEY_INVALID')
      expect(await api('PUT', `/admin/questions/${matching.id}/answer-key`, author, {
         answerData: { pairs: [{ left: '1', right: 'a' }, { left: '2', right: 'b' }] }, source: 'expert_review',
      }), 200)
      const changed = expect(await api('PATCH', `/admin/questions/${matching.id}`, author, {
         matching: {
            left: [{ key: '1', content: text('x + 1 = 2') }, { key: '2', content: text('x + 2 = 5') }],
            right: [{ key: 'a', content: text('1') }, { key: 'c', content: text('3') }],
         },
      }), 200)
      assert.equal(changed.answerKey.status, 'unknown')
      assert.equal(changed.answerKey.answerData, null)

      const numeric = expect(await api('POST', `/admin/question-banks/${bank.id}/questions`, author, {
         questionType: 'numeric', content: text('x = ?'), languageCode: 'ru',
      }), 201)
      expect(await api('PUT', `/admin/questions/${numeric.id}/answer-key`, author, {
         answerData: { value: '3' }, source: 'expert_review',
      }), 400, 'ANSWER_KEY_INVALID')
      expect(await api('PUT', `/admin/questions/${numeric.id}/answer-key`, author, {
         answerData: { value: 3 }, source: 'expert_review',
      }), 200)
      const shortText = expect(await api('POST', `/admin/question-banks/${bank.id}/questions`, author, {
         questionType: 'short_text', content: text('Capital?'),
      }), 201)
      expect(await api('PUT', `/admin/questions/${shortText.id}/answer-key`, author, {
         answerData: { acceptedAnswers: ['Dushanbe', 'Душанбе'] }, source: 'official_key',
      }), 200)
   })

   await t.test('question images must be ready images the author may use', async () => {
      const insertAsset = async (ownerId, mimeType, status = 'ready') => (await client.query(
         `INSERT INTO assets (storage_key, mime_type, size_bytes, status, uploaded_by)
          VALUES ($1, $2, 10, $3, $4) RETURNING id`,
         [`m08/${randomUUID()}`, mimeType, status, ownerId],
      )).rows[0].id
      const foreign = await insertAsset(readerId, 'image/png')
      const own = await insertAsset(authorId, 'image/png')
      const pdf = await insertAsset(authorId, 'application/pdf')
      const image = (assetId) => ({
         blocks: [{ type: 'text', text: 'Look' }, { type: 'image', assetId, alt: 'figure' }],
      })
      const body = (assetId) => ({
         questionType: 'numeric',
         content: image(assetId),
      })
      expect(await api('POST', `/admin/question-banks/${bank.id}/questions`, author, body(foreign)), 422, 'QUESTION_ASSET_NOT_USABLE')
      expect(await api('POST', `/admin/question-banks/${bank.id}/questions`, author, body(pdf)), 422, 'QUESTION_ASSET_NOT_USABLE')
      const created = expect(await api('POST', `/admin/question-banks/${bank.id}/questions`, author, body(own)), 201)
      assert.deepEqual(created.assetIds, [own])
      const keyed = expect(await api('PUT', `/admin/questions/${created.id}/answer-key`, author, {
         answerData: { value: 1 }, source: 'expert_review', explanation: image(own),
      }), 200)
      assert.deepEqual(keyed.assetIds, [own])
      const cleared = expect(await api('PATCH', `/admin/questions/${created.id}`, author, {
         content: text('No image'),
      }), 200)
      assert.deepEqual(cleared.assetIds, [own])
   })

   await t.test('referenced taxonomy cannot be deleted', async () => {
      expect(await api('DELETE', `/admin/subjects/${math.id}`, admin), 409, 'SUBJECT_IN_USE')
      expect(await api('DELETE', `/admin/topics/${linear.id}`, admin), 409, 'TOPIC_IN_USE')
      const spare = expect(await api('POST', `/admin/subjects/${biology.id}/sections`, admin, {
         code: 'spare', translations: { tg: { title: 'Spare' } },
      }), 201)
      expect(await api('DELETE', `/admin/sections/${spare.id}`, admin), 200)
      expect(await api('DELETE', '/admin/subjects/abc', admin), 400, 'INVALID_SUBJECT_ID')
   })
})
