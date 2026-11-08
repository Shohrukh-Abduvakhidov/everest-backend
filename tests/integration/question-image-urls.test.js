import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import pg from 'pg'

import env from '../../src/configs/env.js'
import { grantCourseEnrollmentService } from '../../src/services/course-access-service.js'
import {
   createQuestionBankService,
   createQuestionService,
   getQuestionService,
   publishQuestionService,
   replaceAnswerKeyService,
   updateQuestionService,
   verifyAnswerKeyService,
} from '../../src/services/question-bank-service.js'
import { createSubjectService } from '../../src/services/taxonomy-service.js'
import {
   getAttemptService,
   startAttemptService,
   submitAttemptService,
} from '../../src/services/test-attempt-service.js'
import {
   addTestQuestionsService,
   createAssignmentService,
   createTestService,
   publishTestService,
} from '../../src/services/test-service.js'
import { createMemoryStorageProvider } from '../helpers/memory-storage-provider.js'

// Presigned URLs for image blocks: added to responses only, never stored, signed only for
// ready images linked to the question the viewer may see.

const { Client } = pg
const suffix = randomUUID().slice(0, 8)
const text = (value) => ({ blocks: [{ type: 'text', text: value }] })
const image = (assetId, alt = 'figure') => ({ blocks: [{ type: 'text', text: 'Look' }, { type: 'image', assetId, alt }] })
const imageBlock = (content) => content.blocks.find((block) => block.type === 'image')

test('question image URLs integration', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   t.after(() => client.end())
   const storage = createMemoryStorageProvider()
   const withStorage = { storage }

   async function createUser(role) {
      const { rows } = await client.query(
         `INSERT INTO users (status, onboarding_completed_at) VALUES ('active', CURRENT_TIMESTAMP) RETURNING id`,
      )
      await client.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2', [rows[0].id, role])
      return rows[0].id
   }

   async function insertAsset(ownerId, status = 'ready', mime = 'image/png') {
      const { rows } = await client.query(
         `INSERT INTO assets (storage_key, mime_type, size_bytes, status, uploaded_by)
          VALUES ($1, $2, 10, $3, $4) RETURNING id`,
         [`questions/test-${randomUUID()}.png`, mime, status, ownerId],
      )
      return String(rows[0].id)
   }

   async function storedContent(questionId) {
      const { rows } = await client.query(
         `SELECT question.content, key.explanation,
            (SELECT jsonb_agg(option.content) FROM question_options AS option WHERE option.question_id = question.id) AS options
          FROM questions AS question LEFT JOIN question_answer_keys AS key ON key.question_id = question.id
          WHERE question.id = $1`,
         [questionId],
      )
      return rows[0]
   }

   const adminId = await createUser('admin')
   const otherId = await createUser('admin')
   const subject = await createSubjectService(adminId, {
      code: `img-${suffix}`, primaryLanguage: 'en', translations: { en: { title: 'Images' } },
   })
   const course = await client.query(
      `INSERT INTO courses (title, subject_id, status, created_by) VALUES ($1, $2, 'published', $3) RETURNING id`,
      [`Images ${suffix}`, subject.id, adminId],
   )
   const courseId = course.rows[0].id
   const bank = await createQuestionBankService(adminId, {
      code: `img-bank-${suffix}`, title: 'Images', subjectId: subject.id, visibility: 'staff',
   })

   const stemAsset = await insertAsset(adminId)
   const optionAsset = await insertAsset(adminId)
   const explanationAsset = await insertAsset(adminId)
   const created = await createQuestionService(adminId, bank.id, {
      questionType: 'single_choice',
      languageCode: 'en',
      content: image(stemAsset),
      options: [{ key: 'A', content: image(optionAsset, 'a') }, { key: 'B', content: text('B') }],
   })
   await replaceAnswerKeyService(adminId, created.id, {
      answerData: { optionKey: 'A' }, source: 'expert_review', explanation: image(explanationAsset),
   })
   await verifyAnswerKeyService(adminId, created.id, { source: 'expert_review' })
   await publishQuestionService(adminId, created.id)
   const publishedId = created.id

   await t.test('admin view signs ready images of stem, options and explanation', async () => {
      const before = storage.calls.length
      const question = await getQuestionService(adminId, publishedId, withStorage)
      for (const content of [question.content, question.options[0].content, question.answerKey.explanation]) {
         const block = imageBlock(content)
         assert.deepEqual(Object.keys(block).sort(), ['alt', 'assetId', 'expiresAt', 'type', 'url'])
         assert.match(block.url, /^https:\/\/storage\.test\/signed\//)
         assert.ok(Math.abs(new Date(block.expiresAt).getTime() - Date.now() - 300000) < 5000)
      }
      const calls = storage.calls.slice(before).filter((entry) => entry.name === 'presignDownload')
      assert.equal(calls.length, 3)
      assert.ok(calls.every((entry) => entry.expiresIn === 300 && entry.disposition === 'inline'))
      const stored = await storedContent(publishedId)
      assert.equal(JSON.stringify(stored).includes('url'), false)
      assert.equal(JSON.stringify(stored).includes('expiresAt'), false)
   })

   await t.test('unready, unlinked and unavailable storage leave the block without url', async () => {
      const draftAsset = await insertAsset(adminId)
      const draft = await createQuestionService(adminId, bank.id, {
         questionType: 'numeric', languageCode: 'en', content: image(draftAsset),
      })
      await client.query(`UPDATE assets SET status = 'archived' WHERE id = $1`, [draftAsset])
      const unready = await getQuestionService(adminId, draft.id, withStorage)
      assert.deepEqual(imageBlock(unready.content), { type: 'image', assetId: draftAsset, alt: 'figure' })

      // Another user's ready image that is not linked to this question.
      const foreignAsset = await insertAsset(otherId)
      await client.query('UPDATE questions SET content = $2 WHERE id = $1', [draft.id, image(foreignAsset)])
      const foreign = await getQuestionService(adminId, draft.id, withStorage)
      assert.equal(Object.hasOwn(imageBlock(foreign.content), 'url'), false)

      const broken = { presignDownload: async () => { throw new Error('storage down') } }
      const down = await getQuestionService(adminId, publishedId, { storage: broken })
      assert.equal(Object.hasOwn(imageBlock(down.content), 'url'), false)
      assert.equal(Object.hasOwn(imageBlock(down.content), 'expiresAt'), false)
   })

   await t.test('content sent back with url is accepted and stored without it', async () => {
      const asset = await insertAsset(adminId)
      const draft = await createQuestionService(adminId, bank.id, {
         questionType: 'numeric', languageCode: 'en', content: image(asset),
      })
      const shown = await getQuestionService(adminId, draft.id, withStorage)
      assert.ok(imageBlock(shown.content).url)
      const updated = await updateQuestionService(adminId, draft.id, { content: shown.content }, withStorage)
      assert.ok(imageBlock(updated.content).url)
      assert.deepEqual(imageBlock((await storedContent(draft.id)).content), { type: 'image', assetId: asset, alt: 'figure' })
   })

   await t.test('learners get images of their own attempt only', async () => {
      const quiz = await createTestService(adminId, {
         courseId, title: `Images ${suffix}`, mode: 'practice', maxAttempts: 1, answerRevealPolicy: 'after_submission',
      })
      await addTestQuestionsService(adminId, quiz.id, { questions: [{ questionId: publishedId, points: '1' }] })
      await publishTestService(adminId, quiz.id)
      const learner = await createUser('student')
      const stranger = await createUser('student')
      for (const userId of [learner, stranger]) {
         await grantCourseEnrollmentService(adminId, courseId, { userId, expiresAt: null })
      }
      const assignment = await createAssignmentService(adminId, quiz.id, { userId: learner })

      const view = await startAttemptService(learner, assignment.id, withStorage)
      const [item] = view.questions
      assert.ok(imageBlock(item.content).url)
      assert.ok(imageBlock(item.options.find((option) => option.key === 'A').content).url)
      assert.ok(imageBlock((await getAttemptService(learner, view.attempt.id, withStorage)).questions[0].content).url)
      await assert.rejects(getAttemptService(stranger, view.attempt.id, withStorage), { code: 'ATTEMPT_NOT_FOUND' })

      const result = await submitAttemptService(learner, view.attempt.id, withStorage)
      assert.equal(result.revealed, true)
      assert.ok(imageBlock(result.questions[0].content).url)
      assert.ok(imageBlock(result.questions[0].explanation).url)
      assert.equal(JSON.stringify(await storedContent(publishedId)).includes('url'), false)
   })
})
