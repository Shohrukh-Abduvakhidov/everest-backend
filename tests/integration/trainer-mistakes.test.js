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
import { saveAnswerService, submitAttemptService } from '../../src/services/test-attempt-service.js'
import {
   createTrainerAttemptService,
   getTrainerAvailabilityService,
   getTrainerCatalogService,
   getTrainerOverviewService,
   listTrainerHistoryService,
} from '../../src/services/trainer-service.js'
import { createMemoryStorageProvider } from '../helpers/memory-storage-provider.js'

const { Client } = pg
const suffix = randomUUID().slice(0, 8)
const text = (value) => ({ blocks: [{ type: 'text', text: value }] })

// Mistakes mode, several topics, count "all", time limits and the exact catalog counts.
test('NCT trainer: mistakes, topics, small choices and time limits', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   t.after(() => client.end())
   const trainerConfig = {
      ...env.trainer,
      bankCodePrefix: `nct-${suffix}-`,
      questionCounts: [5, 10],
      maxQuestions: 50,
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
   const learnerId = await createUser('student')
   const subject = await createSubjectService(adminId, {
      code: `mistakes-${suffix}`, primaryLanguage: 'en', translations: { en: { title: 'Mistakes subject' } },
   })
   const sectionIds = {}
   for (const code of ['part-a', 'part-b']) {
      sectionIds[code] = (await createSectionService(adminId, subject.id, {
         code, primaryLanguage: 'en', translations: { en: { title: code } },
      })).id
   }
   const topicIds = {}
   for (const [code, section] of [['alpha', 'part-a'], ['beta', 'part-a'], ['gamma', 'part-b'], ['tiny', 'part-b'], ['empty', 'part-b']]) {
      topicIds[code] = (await createTopicService(adminId, subject.id, {
         code, primaryLanguage: 'en', translations: { en: { title: code } }, sectionId: sectionIds[section],
      })).id
   }
   const bank = await createQuestionBankService(adminId, {
      code: `nct-${suffix}-bank`, title: 'NCT', subjectId: subject.id, visibility: 'staff',
   })

   // Every key is B. topicOf maps a question id to its topic.
   const topicOf = new Map()
   async function addQuestion(topic, difficulty, languageCode = 'en') {
      const question = await createQuestionService(adminId, bank.id, {
         questionType: 'single_choice',
         languageCode,
         difficulty,
         difficultySource: 'expert',
         topicIds: [topicIds[topic]],
         content: text(`${topic} ${difficulty}`),
         options: [{ key: 'A', content: text('A') }, { key: 'B', content: text('B') }],
      })
      await replaceAnswerKeyService(adminId, question.id, { answerData: { optionKey: 'B' }, source: 'expert_review' })
      await verifyAnswerKeyService(adminId, question.id, { source: 'expert_review' })
      await publishQuestionService(adminId, question.id)
      topicOf.set(String(question.id), topic)
      return String(question.id)
   }

   for (let index = 0; index < 4; index += 1) await addQuestion('alpha', 1)
   for (let index = 0; index < 2; index += 1) await addQuestion('alpha', 1, 'ru')
   for (let index = 0; index < 4; index += 1) await addQuestion('beta', 3)
   for (let index = 0; index < 3; index += 1) await addQuestion('gamma', 4)
   const tinyIds = [await addQuestion('tiny', 1), await addQuestion('tiny', 2)]

   const create = (userId, body) => createTrainerAttemptService(userId, { subject: subject.code, ...body }, deps)
   const questionIdsOf = async (attemptId) => (await client.query(
      `SELECT item.id::text AS id, item.question_id::text AS question_id
       FROM attempt_questions AS item WHERE item.attempt_id = $1 ORDER BY item.position`,
      [attemptId],
   )).rows
   // Answers every question: wrong (A) for the ids in wrongIds, right (B) otherwise; then submits.
   async function finish(userId, attemptId, wrongIds = [], { skip = [] } = {}) {
      for (const item of await questionIdsOf(attemptId)) {
         if (skip.includes(item.question_id)) continue
         const optionKey = wrongIds.includes(item.question_id) ? 'A' : 'B'
         await saveAnswerService(userId, attemptId, item.id, { answer: { optionKey }, revision: 1 }, deps)
      }
      return submitAttemptService(userId, attemptId, deps)
   }

   await t.test('catalog counts each section and topic exactly per language and level; empty topics are absent', async () => {
      const entry = (await getTrainerCatalogService(studentId, deps)).subjects.find((row) => row.code === subject.code)
      assert.deepEqual(entry.languages, [
         { language: 'en', total: 13, difficulties: { easy: 6, medium: 4, hard: 3 } },
         { language: 'ru', total: 2, difficulties: { easy: 2, medium: 0, hard: 0 } },
      ])
      const topic = (code) => entry.topics.find((row) => row.code === code)
      assert.deepEqual(entry.topics.map((row) => row.code), ['alpha', 'beta', 'gamma', 'tiny'])
      assert.equal(topic('alpha').total, 6)
      assert.deepEqual(topic('alpha').languages, [
         { language: 'en', total: 4, difficulties: { easy: 4, medium: 0, hard: 0 } },
         { language: 'ru', total: 2, difficulties: { easy: 2, medium: 0, hard: 0 } },
      ])
      assert.deepEqual(topic('gamma').languages, [{ language: 'en', total: 3, difficulties: { easy: 0, medium: 0, hard: 3 } }])
      const partA = entry.sections.find((row) => row.code === 'part-a')
      assert.equal(partA.total, 10)
      assert.deepEqual(partA.languages.map((row) => [row.language, row.total]), [['en', 8], ['ru', 2]])
      assert.equal(entry.mistakes, 0)
      const { options } = await getTrainerCatalogService(studentId, deps)
      assert.deepEqual(options.modes, ['standard', 'mistakes'])
      assert.equal(options.countAll, 'all')
      assert.deepEqual(options.timeLimitMinutes, { min: 1, max: 1440 })
   })

   await t.test('availability is exact for a union of topics and tells which counts work', async () => {
      const check = (query) => getTrainerAvailabilityService(studentId, { subject: subject.code, difficulty: 'mixed', ...query }, deps)
      const union = await check({ topicCodes: 'beta,alpha' })
      assert.equal(String(union.subjectId), String(subject.id))
      assert.deepEqual({ ...union, subjectId: undefined }, {
         mode: 'standard', subjectId: undefined, language: 'en', available: 8, questionCounts: [5], allowsAll: false,
      })
      assert.equal((await check({ topicCodes: ['alpha', 'beta'], language: 'ru' })).available, 2)
      assert.equal((await check({ sectionCode: 'part-b', difficulty: 'hard' })).available, 3)
      const tiny = await check({ topicCode: 'tiny' })
      assert.deepEqual([tiny.available, tiny.questionCounts, tiny.allowsAll], [2, [], true])
      const mistakes = await check({ mode: 'mistakes' })
      assert.deepEqual([mistakes.available, mistakes.language, mistakes.questionCounts, mistakes.allowsAll], [0, null, [], false])
      await assert.rejects(check({ topicCode: 'tiny', topicCodes: 'alpha' }), { code: 'VALIDATION_ERROR' })
      await assert.rejects(check({ count: '5' }), { code: 'VALIDATION_ERROR' })
      await assert.rejects(check({ subject: 'missing-subject' }), { code: 'SUBJECT_NOT_FOUND' })
   })

   await t.test('validation of the new fields', async () => {
      for (const body of [
         { difficulty: 'mixed', count: 5, mode: 'review' },
         { count: 5 },
         { difficulty: 'mixed', count: 'everything' },
         { difficulty: 'mixed', count: 5, topicCode: 'alpha', topicCodes: ['beta'] },
         { difficulty: 'mixed', count: 5, topicCodes: [] },
         { difficulty: 'mixed', count: 5, topicCodes: ['Bad Code'] },
         { difficulty: 'mixed', count: 5, timeLimitMinutes: 0 },
         { difficulty: 'mixed', count: 5, timeLimitMinutes: 1441 },
         { difficulty: 'mixed', count: 5, timeLimitMinutes: 1.5 },
      ]) {
         await assert.rejects(create(studentId, body), { code: 'VALIDATION_ERROR' }, JSON.stringify(body))
      }
   })

   await t.test('several topics: only their questions, the same choice in another order repeats the request', async () => {
      const key = `topics-${suffix}`
      const view = await create(studentId, { difficulty: 'mixed', count: 5, topicCodes: ['beta', 'alpha'], idempotencyKey: key })
      const items = await questionIdsOf(view.attempt.id)
      assert.equal(items.length, 5)
      assert.ok(items.every((item) => ['alpha', 'beta'].includes(topicOf.get(item.question_id))))
      const again = await create(studentId, { difficulty: 'mixed', count: 5, topicCodes: ['alpha', 'beta'], idempotencyKey: key })
      assert.equal(again.resumed, true)
      assert.equal(again.attempt.id, view.attempt.id)
      await assert.rejects(
         create(studentId, { difficulty: 'mixed', count: 5, topicCodes: ['alpha'], idempotencyKey: key }),
         { code: 'IDEMPOTENCY_KEY_REUSED' },
      )
      await finish(studentId, view.attempt.id)
      const history = await listTrainerHistoryService(studentId, {}, deps)
      assert.deepEqual(
         [history.attempts[0].mode, history.attempts[0].topicCodes, history.attempts[0].topicCode, history.attempts[0].timeLimitMinutes],
         ['standard', ['alpha', 'beta'], null, null],
      )
      // A single topic sent the old way still reads back as topicCode.
      const single = await create(studentId, { difficulty: 'easy', count: 'all', topicCode: 'alpha', language: 'en' })
      assert.equal(single.questions.length, 4)
      await assert.rejects(create(studentId, { difficulty: 'easy', count: 5 }), { code: 'TRAINER_ATTEMPT_IN_PROGRESS' })
      await finish(studentId, single.attempt.id)
      const latest = (await listTrainerHistoryService(studentId, {}, deps)).attempts[0]
      assert.deepEqual([latest.topicCode, latest.topicCodes], ['alpha', ['alpha']])
   })

   await t.test('count "all" serves small choices only', async () => {
      const view = await create(studentId, { difficulty: 'mixed', count: 'all', topicCodes: ['tiny'] })
      assert.equal(view.questions.length, 2)
      await finish(studentId, view.attempt.id)
      await assert.rejects(
         create(studentId, { difficulty: 'mixed', count: 'all', topicCodes: ['alpha', 'beta'] }),
         (error) => error.code === 'TRAINER_COUNT_ALL_NOT_ALLOWED' && error.details[0].message === '8',
      )
      await assert.rejects(
         create(studentId, { difficulty: 'hard', count: 'all', topicCodes: ['tiny'] }),
         (error) => error.code === 'TRAINER_NOT_ENOUGH_QUESTIONS' && error.details[0].message === '0',
      )
      // An empty topic is never offered and draws nothing.
      await assert.rejects(
         create(studentId, { difficulty: 'mixed', count: 'all', topicCode: 'empty' }),
         (error) => error.code === 'TRAINER_NOT_ENOUGH_QUESTIONS' && error.details[0].message === '0',
      )
   })

   await t.test('a time limit sets the server deadline', async () => {
      const view = await create(studentId, { difficulty: 'mixed', count: 5, timeLimitMinutes: 15 })
      const seconds = (Date.parse(view.attempt.deadlineAt) - Date.parse(view.attempt.startedAt)) / 1000
      assert.equal(seconds, 900)
      const { rows } = await client.query(
         'SELECT duration_seconds FROM tests WHERE id = (SELECT test_id FROM test_attempts WHERE id = $1)',
         [view.attempt.id],
      )
      assert.equal(rows[0].duration_seconds, 900)
      await finish(studentId, view.attempt.id)
      const untimed = await create(studentId, { difficulty: 'mixed', count: 5 })
      assert.equal(untimed.attempt.deadlineAt, null)
      await finish(studentId, untimed.attempt.id)
      assert.equal((await listTrainerHistoryService(studentId, {}, deps)).attempts[1].timeLimitMinutes, 15)
   })

   await t.test('mistakes: open until solved, back after a new mistake, short sets without 409', async () => {
      await assert.rejects(create(learnerId, { mode: 'mistakes', count: 5 }), { code: 'TRAINER_NO_MISTAKES' })

      // First training: tiny[0] wrong, tiny[1] right.
      const first = await create(learnerId, { difficulty: 'mixed', count: 'all', topicCode: 'tiny' })
      await finish(learnerId, first.attempt.id, [tinyIds[0]])

      let catalog = (await getTrainerCatalogService(learnerId, deps)).subjects.find((row) => row.code === subject.code)
      assert.equal(catalog.mistakes, 1)
      assert.equal(catalog.topics.find((row) => row.code === 'tiny').mistakes, 1)
      assert.equal(catalog.topics.find((row) => row.code === 'alpha').mistakes, 0)
      assert.equal(catalog.sections.find((row) => row.code === 'part-b').mistakes, 1)
      let overview = await getTrainerOverviewService(learnerId, deps)
      assert.equal(String(overview.mistakes.subjects[0].subjectId), String(subject.id))
      assert.deepEqual(overview.mistakes, {
         total: 1,
         subjects: [{
            subjectId: overview.mistakes.subjects[0].subjectId,
            total: 1,
            sections: [{ code: 'part-b', total: 1 }],
            topics: [{ code: 'tiny', sectionCode: 'part-b', total: 1 }],
         }],
      })
      // Other students' mistakes are their own.
      assert.equal((await getTrainerOverviewService(adminId, deps)).mistakes.total, 0)
      assert.equal((await getTrainerAvailabilityService(learnerId, { subject: subject.code, mode: 'mistakes' }, deps)).available, 1)
      await assert.rejects(create(learnerId, { mode: 'mistakes', count: 5, topicCodes: ['alpha'] }), { code: 'TRAINER_NO_MISTAKES' })

      // Asked for 5, one mistake exists: the training has 1 question, origin trainer, mode mistakes.
      const repeat = await create(learnerId, { mode: 'mistakes', count: 5 })
      assert.equal(repeat.questions.length, 1)
      assert.deepEqual((await questionIdsOf(repeat.attempt.id)).map((item) => item.question_id), [tinyIds[0]])
      const { rows } = await client.query(
         `SELECT origin, generation_filters ->> 'mode' AS mode, generation_filters ->> 'language' AS language
          FROM tests WHERE id = (SELECT test_id FROM test_attempts WHERE id = $1)`,
         [repeat.attempt.id],
      )
      assert.deepEqual(rows[0], { origin: 'trainer', mode: 'mistakes', language: null })
      await finish(learnerId, repeat.attempt.id)
      await assert.rejects(create(learnerId, { mode: 'mistakes', count: 'all' }), { code: 'TRAINER_NO_MISTAKES' })
      assert.equal((await getTrainerOverviewService(learnerId, deps)).mistakes.total, 0)

      // A new wrong answer (an unanswered question counts) brings the question back.
      const second = await create(learnerId, { difficulty: 'mixed', count: 'all', topicCode: 'tiny' })
      await finish(learnerId, second.attempt.id, [], { skip: [tinyIds[0]] })
      overview = await getTrainerOverviewService(learnerId, deps)
      assert.equal(overview.mistakes.total, 1)
      catalog = (await getTrainerCatalogService(learnerId, deps)).subjects.find((row) => row.code === subject.code)
      assert.equal(catalog.mistakes, 1)

      // Readiness uses the two standard trainings only: (1 + 1) / (2 + 2); the mistakes training
      // (1 / 1) would make it 60. It still counts as a training.
      const readiness = overview.subjects.find((row) => row.subjectCode === subject.code)
      assert.equal(readiness.readinessPercent, 50)
      assert.equal(readiness.trainings, 3)
      assert.equal(overview.recentResults[1].mode, 'mistakes')
   })
})
