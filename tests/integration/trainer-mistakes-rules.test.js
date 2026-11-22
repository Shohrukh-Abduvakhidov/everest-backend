import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import pg from 'pg'

import env from '../../src/configs/env.js'
import * as mockExamRepository from '../../src/repositories/mock-exam-repository.js'
import { withTransaction } from '../../src/repositories/transaction-repository.js'
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
   getAttemptService,
   saveAnswerService,
   startAttemptInTransactionService,
   submitAttemptService,
} from '../../src/services/test-attempt-service.js'
import {
   createTrainerAttemptService,
   getTrainerAvailabilityService,
   getTrainerCatalogService,
   listTrainerHistoryService,
} from '../../src/services/trainer-service.js'
import { createMemoryStorageProvider } from '../helpers/memory-storage-provider.js'

const { Client } = pg
const suffix = randomUUID().slice(0, 8)
const text = (value) => ({ blocks: [{ type: 'text', text: value }] })

// Mistakes rules of 2026-11-22: only answered occurrences count, the freshest mistakes are
// picked first, plannedCount, sourceAttemptId, and the training block of results and history.
test('NCT trainer: mistakes rules (answered occurrences, order, plannedCount, sourceAttemptId)', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   t.after(() => client.end())
   const trainerConfig = {
      ...env.trainer,
      bankCodePrefix: `nct-${suffix}-`,
      questionCounts: [5, 10],
      maxQuestions: 10,
      readinessWindow: 5,
   }
   const storage = createMemoryStorageProvider()
   const depsWith = (maxQuestions) => ({ storage, trainerConfig: { ...trainerConfig, maxQuestions } })
   const deps = depsWith(10)

   async function createUser(role) {
      const { rows } = await client.query(
         `INSERT INTO users (status, onboarding_completed_at) VALUES ('active', CURRENT_TIMESTAMP) RETURNING id`,
      )
      await client.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2', [rows[0].id, role])
      return String(rows[0].id)
   }

   const adminId = await createUser('admin')
   const subject = await createSubjectService(adminId, {
      code: `rules-${suffix}`, primaryLanguage: 'en', translations: { en: { title: 'Rules subject' } },
   })
   const section = await createSectionService(adminId, subject.id, {
      code: 'part', primaryLanguage: 'en', translations: { en: { title: 'Part' } },
   })
   const topicIds = {}
   for (const code of ['alpha', 'beta', 'gamma']) {
      topicIds[code] = (await createTopicService(adminId, subject.id, {
         code, primaryLanguage: 'en', translations: { en: { title: code } }, sectionId: section.id,
      })).id
   }
   const bank = await createQuestionBankService(adminId, {
      code: `nct-${suffix}-bank`, title: 'NCT', subjectId: subject.id, visibility: 'staff',
   })

   async function publish(question, answerData) {
      await replaceAnswerKeyService(adminId, question.id, { answerData, source: 'expert_review' })
      await verifyAnswerKeyService(adminId, question.id, { source: 'expert_review' })
      await publishQuestionService(adminId, question.id)
      return String(question.id)
   }
   // Single choice, key B.
   const single = async (topic, label) => publish(await createQuestionService(adminId, bank.id, {
      questionType: 'single_choice', languageCode: 'en', difficulty: 2, difficultySource: 'expert',
      topicIds: [topicIds[topic]], content: text(label),
      options: [{ key: 'A', content: text('A') }, { key: 'B', content: text('B') }],
   }), { optionKey: 'B' })
   // Matching, key 1-a and 2-b: one right pair earns half the points.
   const matching = async (topic, label) => publish(await createQuestionService(adminId, bank.id, {
      questionType: 'matching', languageCode: 'en', difficulty: 2, difficultySource: 'expert',
      topicIds: [topicIds[topic]], content: text(label),
      interactionSettings: { requireAllLeft: false, allowRightReuse: false },
      matching: {
         left: [{ key: '1', content: text('one') }, { key: '2', content: text('two') }],
         right: [{ key: 'a', content: text('a') }, { key: 'b', content: text('b') }],
      },
   }), { pairs: [{ left: '1', right: 'a' }, { left: '2', right: 'b' }] })

   // 4 questions per topic, so count "all" serves each topic (4 < the smallest count 5).
   const alpha = [await single('alpha', 'a0'), await single('alpha', 'a1'), await single('alpha', 'a2'), await single('alpha', 'a3')]
   const beta = [await single('beta', 'b0'), await single('beta', 'b1'), await single('beta', 'b2'), await single('beta', 'b3')]
   const gamma = {
      m1: await matching('gamma', 'm1'),
      m2: await matching('gamma', 'm2'),
      g1: await single('gamma', 'g1'),
      g2: await single('gamma', 'g2'),
   }

   const WRONG = { optionKey: 'A' }
   const RIGHT = { optionKey: 'B' }
   const PARTIAL = { pairs: [{ left: '1', right: 'a' }] }
   const create = (userId, body, options = deps) => createTrainerAttemptService(userId, body, options)
   const availability = (userId, query, options = deps) => getTrainerAvailabilityService(userId, query, options)
   const itemsOf = async (attemptId) => (await client.query(
      `SELECT item.id::text AS id, item.question_id::text AS question_id
       FROM attempt_questions AS item WHERE item.attempt_id = $1 ORDER BY item.position`,
      [attemptId],
   )).rows
   const questionIdsOf = async (attemptId) => (await itemsOf(attemptId)).map((item) => item.question_id)
   // Answers by question id (absent = left blank), then submits.
   async function finish(userId, attemptId, answers) {
      for (const item of await itemsOf(attemptId)) {
         const answer = answers[item.question_id]
         if (answer) await saveAnswerService(userId, attemptId, item.id, { answer, revision: 1 }, deps)
      }
      return submitAttemptService(userId, attemptId, deps)
   }
   const train = async (userId, topic, answers) => {
      const view = await create(userId, { subject: subject.code, difficulty: 'mixed', count: 'all', topicCode: topic })
      await finish(userId, view.attempt.id, answers)
      return String(view.attempt.id)
   }
   const mistakesOf = async (userId) => (await availability(userId, { subject: subject.code, mode: 'mistakes' })).available
   // A finished mock exam attempt over these questions (origin mock_exam, in their order), built
   // with the mock exam repository; blueprints and sheets are in nct-mock-exam.test.js.
   async function mockExam(userId, questionIds, answers) {
      const attemptId = await withTransaction(async (tx) => {
         const testId = await mockExamRepository.createMockExamTest({
            title: 'Mock exam', durationSeconds: 3600, generationFilters: {}, createdBy: userId,
         }, tx)
         await mockExamRepository.addMockExamQuestions(
            testId,
            questionIds.map((questionId, index) => ({ question_id: questionId, position: index + 1, points: 1 })),
            tx,
         )
         await mockExamRepository.publishMockExamTest(testId, tx)
         const assignmentId = await mockExamRepository.createMockExamAssignment(testId, userId, new Date(), tx)
         return startAttemptInTransactionService(userId, assignmentId, tx, deps)
      })
      await finish(userId, String(attemptId), answers)
      return String(attemptId)
   }

   await t.test('an empty occurrence neither opens nor closes a mistake, timed-out ones included', async () => {
      const studentId = await createUser('student')
      // a0 wrong, a1 right, a2 blank, a3 wrong: mistakes a0 and a3; the blank a2 is none.
      await train(studentId, 'alpha', { [alpha[0]]: WRONG, [alpha[1]]: RIGHT, [alpha[3]]: WRONG })
      assert.equal(await mistakesOf(studentId), 2)
      const catalog = (await getTrainerCatalogService(studentId, deps)).subjects.find((row) => row.code === subject.code)
      assert.equal(catalog.mistakes, 2)
      assert.equal(catalog.topics.find((row) => row.code === 'alpha').mistakes, 2)

      // a0 and a1 blank (a0 stays a mistake, a1 stays solved), a2 right, a3 right (closes it).
      await train(studentId, 'alpha', { [alpha[2]]: RIGHT, [alpha[3]]: RIGHT })
      assert.equal(await mistakesOf(studentId), 1)
      const repeat = await create(studentId, { subject: subject.code, mode: 'mistakes', count: 'all' })
      assert.deepEqual(await questionIdsOf(repeat.attempt.id), [alpha[0]])
      // Closed by the timer without any answer: still nothing changes.
      await client.query(
         `UPDATE test_attempts SET started_at = CURRENT_TIMESTAMP - interval '5 minutes',
             expires_at = CURRENT_TIMESTAMP - interval '1 minute' WHERE id = $1`,
         [repeat.attempt.id],
      )
      assert.equal((await getAttemptService(studentId, repeat.attempt.id, deps)).attempt.status, 'expired')
      assert.equal(await mistakesOf(studentId), 1)
   })

   await t.test('a mock exam without answers gives no mistakes; its wrong answers do', async () => {
      const blankId = await createUser('student')
      await mockExam(blankId, beta, {})
      assert.equal(await mistakesOf(blankId), 0)
      assert.equal((await getTrainerCatalogService(blankId, deps)).subjects.find((row) => row.code === subject.code).mistakes, 0)
      await assert.rejects(create(blankId, { subject: subject.code, mode: 'mistakes', count: 'all' }), { code: 'TRAINER_NO_MISTAKES' })

      const answeredId = await createUser('student')
      await mockExam(answeredId, beta, { [beta[0]]: WRONG, [beta[1]]: RIGHT })
      assert.equal(await mistakesOf(answeredId), 1)
   })

   // One student for order, plannedCount, sourceAttemptId and the training block.
   const learnerId = await createUser('student')
   let olderId
   let newerId

   await t.test('freshest mistakes first, wrong before partial; met-in-trainer does not matter', async () => {
      // Oldest: a mock exam occurrence, b1 wrong. The old rule (not met in the trainer first)
      // would pick it before everything else.
      await mockExam(learnerId, [beta[1]], { [beta[1]]: WRONG })
      // Older training: a0 and a1 wrong.
      olderId = await train(learnerId, 'alpha', { [alpha[0]]: WRONG, [alpha[1]]: WRONG, [alpha[2]]: RIGHT, [alpha[3]]: RIGHT })
      // Newer training: m1 and m2 partial, g1 wrong, g2 right.
      newerId = await train(learnerId, 'gamma', { [gamma.m1]: PARTIAL, [gamma.m2]: PARTIAL, [gamma.g1]: WRONG, [gamma.g2]: RIGHT })
      assert.equal(await mistakesOf(learnerId), 6)

      const pick = async (maxQuestions) => {
         const options = depsWith(maxQuestions)
         const view = await create(learnerId, { subject: subject.code, mode: 'mistakes', count: 'all' }, options)
         const ids = await questionIdsOf(view.attempt.id)
         // Left blank: the mistakes stay as they were.
         await submitAttemptService(learnerId, view.attempt.id, deps)
         return ids
      }
      assert.deepEqual(await pick(1), [gamma.g1])
      assert.deepEqual((await pick(3)).sort(), [gamma.g1, gamma.m1, gamma.m2].sort())
      assert.deepEqual((await pick(5)).sort(), [gamma.g1, gamma.m1, gamma.m2, alpha[0], alpha[1]].sort())
      assert.equal(await mistakesOf(learnerId), 6)
   })

   await t.test('availability: plannedCount is what count "all" really takes', async () => {
      const query = { subject: subject.code, mode: 'mistakes' }
      let counted = await availability(learnerId, query, depsWith(3))
      assert.deepEqual([counted.available, counted.plannedCount, counted.sourceAttemptId], [6, 3, null])
      counted = await availability(learnerId, query, depsWith(50))
      assert.equal(counted.plannedCount, 6)
      counted = await availability(learnerId, { ...query, topicCodes: 'gamma' }, depsWith(50))
      assert.deepEqual([counted.available, counted.plannedCount], [3, 3])
      const standard = await availability(learnerId, { subject: subject.code, difficulty: 'mixed' })
      assert.equal('plannedCount' in standard, false)
   })

   await t.test('sourceAttemptId: only the mistakes of that finished training', async () => {
      const counted = await availability(learnerId, { mode: 'mistakes', sourceAttemptId: newerId })
      assert.deepEqual([counted.available, counted.plannedCount, counted.sourceAttemptId, counted.language], [3, 3, newerId, 'en'])
      assert.equal(String(counted.subjectId), String(subject.id))

      const view = await create(learnerId, { mode: 'mistakes', sourceAttemptId: newerId, count: 'all' })
      assert.deepEqual((await questionIdsOf(view.attempt.id)).sort(), [gamma.g1, gamma.m1, gamma.m2].sort())
      const { rows } = await client.query(
         `SELECT generation_filters ->> 'sourceAttemptId' AS source, generation_filters ->> 'subjectId' AS subject_id
          FROM tests WHERE id = (SELECT test_id FROM test_attempts WHERE id = $1)`,
         [view.attempt.id],
      )
      assert.deepEqual(rows[0], { source: newerId, subject_id: String(subject.id) })
      // A running source is refused; this one is the running training.
      await assert.rejects(availability(learnerId, { mode: 'mistakes', sourceAttemptId: String(view.attempt.id) }), {
         code: 'ATTEMPT_NOT_FINISHED',
      })
      // Solving them closes them; the source has no open mistakes left.
      await finish(learnerId, view.attempt.id, {
         [gamma.g1]: RIGHT, [gamma.m1]: { pairs: [{ left: '1', right: 'a' }, { left: '2', right: 'b' }] },
         [gamma.m2]: { pairs: [{ left: '1', right: 'a' }, { left: '2', right: 'b' }] },
      })
      await assert.rejects(create(learnerId, { mode: 'mistakes', sourceAttemptId: newerId, count: 'all' }), {
         code: 'TRAINER_NO_MISTAKES',
      })
      // The older training still has its own.
      assert.equal((await availability(learnerId, { mode: 'mistakes', sourceAttemptId: olderId })).available, 2)

      const otherId = await createUser('student')
      await assert.rejects(create(otherId, { mode: 'mistakes', sourceAttemptId: olderId, count: 'all' }), { code: 'ATTEMPT_NOT_FOUND' })
      await assert.rejects(availability(otherId, { mode: 'mistakes', sourceAttemptId: olderId }), { code: 'ATTEMPT_NOT_FOUND' })
      for (const [field, value] of [['subject', subject.code], ['language', 'en']]) {
         await assert.rejects(
            create(learnerId, { mode: 'mistakes', sourceAttemptId: olderId, count: 'all', [field]: value }),
            (error) => error.code === 'VALIDATION_ERROR' && error.details[0].field === field,
         )
      }
      await assert.rejects(
         create(learnerId, { subject: subject.code, difficulty: 'mixed', count: 5, sourceAttemptId: olderId }),
         (error) => error.code === 'VALIDATION_ERROR' && error.details[0].field === 'sourceAttemptId',
      )
   })

   await t.test('the result and the history name the training: subject, section, topics', async () => {
      const result = await getAttemptResultService(learnerId, newerId, deps)
      assert.deepEqual({ ...result.training, subject: { ...result.training.subject, id: String(result.training.subject.id) } }, {
         subject: { id: String(subject.id), code: subject.code, titles: { en: 'Rules subject' } },
         mode: 'standard',
         difficulty: 'mixed',
         language: 'en',
         sectionCode: null,
         topicCode: 'gamma',
         topicCodes: ['gamma'],
         timeLimitMinutes: null,
         sourceAttemptId: null,
      })
      const history = (await listTrainerHistoryService(learnerId, {}, deps)).attempts
      assert.equal(history[0].mode, 'mistakes')
      assert.equal(history[0].sourceAttemptId, newerId)
      assert.deepEqual(history[0].subject.titles, { en: 'Rules subject' })
      assert.equal(history[0].subject.code, subject.code)
      const source = history.find((row) => String(row.attemptId) === newerId)
      assert.deepEqual([source.topicCodes, source.sectionCode, source.sourceAttemptId], [['gamma'], null, null])
   })
})
