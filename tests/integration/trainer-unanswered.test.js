import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import pg from 'pg'

import env from '../../src/configs/env.js'
import {
   createQuestionBankService,
   createQuestionService,
   publishQuestionService,
   replaceAnswerKeyService,
   verifyAnswerKeyService,
} from '../../src/services/question-bank-service.js'
import { createSectionService, createSubjectService, createTopicService } from '../../src/services/taxonomy-service.js'
import {
   getAttemptResultService,
   saveAnswerService,
   submitAttemptService,
} from '../../src/services/test-attempt-service.js'
import {
   createTrainerAttemptService,
   getReadinessSummaryService,
   getTrainerAvailabilityService,
   getTrainerOverviewService,
   listTrainerHistoryService,
} from '../../src/services/trainer-service.js'
import { createMemoryStorageProvider } from '../helpers/memory-storage-provider.js'

const { Client } = pg
const suffix = randomUUID().slice(0, 8)
const text = (value) => ({ blocks: [{ type: 'text', text: value }] })

// Mode "unanswered": a training of the questions a finished attempt left blank, and the
// correct / wrong / unanswered counts of every attempt result.
test('NCT trainer: unanswered mode and result counts', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   t.after(() => client.end())
   const trainerConfig = {
      ...env.trainer,
      bankCodePrefix: `nct-${suffix}-`,
      questionCounts: [2, 5],
      maxQuestions: 2,
      readinessWindow: 5,
   }
   const deps = { storage: createMemoryStorageProvider(), trainerConfig }

   async function createUser(role) {
      const { rows } = await client.query(
         `INSERT INTO users (status, onboarding_completed_at) VALUES ('active', CURRENT_TIMESTAMP) RETURNING id`,
      )
      await client.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2', [rows[0].id, role])
      return String(rows[0].id)
   }

   const adminId = await createUser('admin')
   const studentId = await createUser('student')
   const otherId = await createUser('student')
   const subject = await createSubjectService(adminId, {
      code: `unanswered-${suffix}`, primaryLanguage: 'en', translations: { en: { title: 'Unanswered subject' } },
   })
   const section = await createSectionService(adminId, subject.id, {
      code: 'part', primaryLanguage: 'en', translations: { en: { title: 'Part' } },
   })
   const topic = await createTopicService(adminId, subject.id, {
      code: 'only', primaryLanguage: 'en', translations: { en: { title: 'Only' } }, sectionId: section.id,
   })
   const bank = await createQuestionBankService(adminId, {
      code: `nct-${suffix}-bank`, title: 'NCT', subjectId: subject.id, visibility: 'staff',
   })
   // Every key is B.
   for (let index = 0; index < 6; index += 1) {
      const question = await createQuestionService(adminId, bank.id, {
         questionType: 'single_choice',
         languageCode: 'en',
         difficulty: 1,
         difficultySource: 'expert',
         topicIds: [topic.id],
         content: text(`question ${index}`),
         options: [{ key: 'A', content: text('A') }, { key: 'B', content: text('B') }],
      })
      await replaceAnswerKeyService(adminId, question.id, { answerData: { optionKey: 'B' }, source: 'expert_review' })
      await verifyAnswerKeyService(adminId, question.id, { source: 'expert_review' })
      await publishQuestionService(adminId, question.id)
   }

   const create = (userId, body) => createTrainerAttemptService(userId, body, deps)
   const availability = (userId, query) => getTrainerAvailabilityService(userId, query, deps)
   const itemsOf = async (attemptId) => (await client.query(
      `SELECT item.id::text AS id, item.question_id::text AS question_id
       FROM attempt_questions AS item WHERE item.attempt_id = $1 ORDER BY item.position`,
      [attemptId],
   )).rows
   const answer = (userId, attemptId, itemId, optionKey) => saveAnswerService(
      userId, attemptId, itemId, { answer: { optionKey }, revision: 1 }, deps,
   )

   // Source: 5 questions; position 1 right, position 2 wrong, positions 3-5 left blank.
   const source = await create(studentId, { subject: subject.code, difficulty: 'mixed', count: 5 })
   const sourceId = String(source.attempt.id)
   const sourceItems = await itemsOf(sourceId)
   await answer(studentId, sourceId, sourceItems[0].id, 'B')
   await answer(studentId, sourceId, sourceItems[1].id, 'A')

   await t.test('a running source is refused', async () => {
      await assert.rejects(create(studentId, { mode: 'unanswered', sourceAttemptId: sourceId }), (error) => (
         // The running source is also the running training; finishing comes first either way.
         error.code === 'ATTEMPT_NOT_FINISHED'
      ))
      await assert.rejects(availability(studentId, { mode: 'unanswered', sourceAttemptId: sourceId }), {
         code: 'ATTEMPT_NOT_FINISHED',
      })
   })

   await t.test('the result counts correct, wrong and unanswered questions', async () => {
      const submitted = await submitAttemptService(studentId, sourceId, deps)
      assert.deepEqual(submitted.counts, { correct: 1, wrong: 1, unanswered: 3, pending: 0 })
      const result = await getAttemptResultService(studentId, sourceId, deps)
      assert.deepEqual(result.counts, { correct: 1, wrong: 1, unanswered: 3, pending: 0 })
   })

   await t.test('validation: sourceAttemptId is required, the source sets subject and filters', async () => {
      await assert.rejects(create(studentId, { mode: 'unanswered' }), (error) => (
         error.code === 'VALIDATION_ERROR' && error.details[0].field === 'sourceAttemptId'
      ))
      await assert.rejects(create(studentId, { mode: 'unanswered', sourceAttemptId: 'abc' }), (error) => (
         error.code === 'VALIDATION_ERROR' && error.details[0].field === 'sourceAttemptId'
      ))
      for (const [field, value] of [['subject', subject.code], ['language', 'en'], ['difficulty', 'easy'], ['topicCodes', ['only']]]) {
         await assert.rejects(create(studentId, { mode: 'unanswered', sourceAttemptId: sourceId, [field]: value }), (error) => (
            error.code === 'VALIDATION_ERROR' && error.details[0].field === field
         ))
      }
      await assert.rejects(
         create(studentId, { subject: subject.code, difficulty: 'mixed', count: 2, sourceAttemptId: sourceId }),
         (error) => error.code === 'VALIDATION_ERROR' && error.details[0].field === 'sourceAttemptId',
      )
   })

   await t.test("another student's attempt or an unknown one is 404", async () => {
      await assert.rejects(create(otherId, { mode: 'unanswered', sourceAttemptId: sourceId }), { code: 'ATTEMPT_NOT_FOUND' })
      await assert.rejects(availability(otherId, { mode: 'unanswered', sourceAttemptId: sourceId }), { code: 'ATTEMPT_NOT_FOUND' })
      await assert.rejects(create(studentId, { mode: 'unanswered', sourceAttemptId: '999999999' }), { code: 'ATTEMPT_NOT_FOUND' })
   })

   const key = `nct-${randomUUID()}`
   let repeatId

   await t.test('availability and the training: blank questions in source order, capped by maxQuestions', async () => {
      const counted = await availability(studentId, { mode: 'unanswered', sourceAttemptId: sourceId })
      assert.deepEqual({ ...counted, subjectId: String(counted.subjectId) }, {
         mode: 'unanswered',
         sourceAttemptId: sourceId,
         subjectId: String(subject.id),
         language: 'en',
         available: 3,
         questionCount: 2,
         questionCounts: [2, 5],
         allowsAll: true,
      })
      const view = await create(studentId, { mode: 'unanswered', sourceAttemptId: Number(sourceId), idempotencyKey: key })
      repeatId = String(view.attempt.id)
      assert.equal(view.resumed, false)
      assert.deepEqual(view.unanswered, { sourceAttemptId: sourceId, available: 3, questionCount: 2 })
      assert.deepEqual(
         (await itemsOf(repeatId)).map((item) => item.question_id),
         sourceItems.slice(2, 4).map((item) => item.question_id),
      )
      const { rows } = await client.query(
         `SELECT origin, generation_filters ->> 'mode' AS mode, generation_filters ->> 'sourceAttemptId' AS source,
             generation_filters ->> 'language' AS language, generation_filters ->> 'subjectId' AS subject_id
          FROM tests WHERE id = (SELECT test_id FROM test_attempts WHERE id = $1)`,
         [repeatId],
      )
      assert.deepEqual(rows[0], { origin: 'trainer', mode: 'unanswered', source: sourceId, language: 'en', subject_id: String(subject.id) })

      // A repeated key returns the same training; another request with it is refused.
      const again = await create(studentId, { mode: 'unanswered', sourceAttemptId: sourceId, idempotencyKey: key })
      assert.equal(again.resumed, true)
      assert.equal(String(again.attempt.id), repeatId)
      assert.deepEqual(again.unanswered, { sourceAttemptId: sourceId, available: 3, questionCount: 2 })
      await assert.rejects(
         create(studentId, { mode: 'unanswered', sourceAttemptId: sourceId, count: 5, idempotencyKey: key }),
         { code: 'IDEMPOTENCY_KEY_REUSED' },
      )
      // One running training at a time.
      await assert.rejects(create(studentId, { mode: 'unanswered', sourceAttemptId: sourceId }), {
         code: 'TRAINER_ATTEMPT_IN_PROGRESS',
      })
   })

   await t.test('no blank questions is 409; history and readiness', async () => {
      for (const item of await itemsOf(repeatId)) await answer(studentId, repeatId, item.id, 'B')
      const submitted = await submitAttemptService(studentId, repeatId, deps)
      assert.deepEqual(submitted.counts, { correct: 2, wrong: 0, unanswered: 0, pending: 0 })
      await assert.rejects(create(studentId, { mode: 'unanswered', sourceAttemptId: repeatId }), {
         code: 'TRAINER_NO_UNANSWERED',
      })
      const empty = await availability(studentId, { mode: 'unanswered', sourceAttemptId: repeatId })
      assert.equal(empty.available, 0)
      assert.deepEqual(empty.questionCounts, [])
      assert.equal(empty.allowsAll, false)

      const history = (await listTrainerHistoryService(studentId, {}, deps)).attempts
      assert.equal(history[0].mode, 'unanswered')
      assert.equal(history[0].sourceAttemptId, sourceId)
      assert.equal(history[0].questionCount, 2)
      assert.equal(history[1].sourceAttemptId, null)

      // Readiness uses the standard training only (1 of 5); the unanswered one (2 of 2) would
      // make it 3 of 7. It still counts as a training.
      const overview = await getTrainerOverviewService(studentId, deps)
      const entry = overview.subjects.find((row) => row.subjectCode === subject.code)
      assert.equal(entry.readinessPercent, 20)
      assert.equal(entry.trainings, 2)
      const home = (await getReadinessSummaryService(studentId, deps)).subjects.find((row) => row.subjectCode === subject.code)
      assert.equal(home.readinessPercent, 20)
   })
})
