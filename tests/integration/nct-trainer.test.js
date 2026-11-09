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
import { createSubjectService } from '../../src/services/taxonomy-service.js'
import {
   getAttemptResultService,
   getAttemptService,
   saveAnswerService,
   submitAttemptService,
} from '../../src/services/test-attempt-service.js'
import { listTestsService } from '../../src/services/test-service.js'
import {
   createTrainerAttemptService,
   getTrainerCatalogService,
   listTrainerHistoryService,
   splitByShares,
} from '../../src/services/trainer-service.js'
import { createMemoryStorageProvider } from '../helpers/memory-storage-provider.js'

const { Client } = pg
const suffix = randomUUID().slice(0, 8)
const text = (value) => ({ blocks: [{ type: 'text', text: value }] })

test('NCT trainer integration', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   t.after(() => client.end())
   const storage = createMemoryStorageProvider()
   // A private bank prefix keeps other tests' banks out of these counts.
   const trainerConfig = {
      ...env.trainer,
      bankCodePrefix: `nct-${suffix}-`,
      questionCounts: [1, 2, 4, 10, 20],
   }
   const deps = { storage, trainerConfig }

   async function createUser(role) {
      const { rows } = await client.query(
         `INSERT INTO users (status, onboarding_completed_at) VALUES ('active', CURRENT_TIMESTAMP) RETURNING id`,
      )
      await client.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2', [rows[0].id, role])
      return String(rows[0].id)
   }

   async function insertAsset(ownerId) {
      const { rows } = await client.query(
         `INSERT INTO assets (storage_key, mime_type, size_bytes, status, uploaded_by)
          VALUES ($1, 'image/png', 10, 'ready', $2) RETURNING id`,
         [`questions/trainer-${randomUUID()}.png`, ownerId],
      )
      return String(rows[0].id)
   }

   const adminId = await createUser('admin')
   const studentId = await createUser('student')
   const outsiderId = await createUser('student')
   const subject = await createSubjectService(adminId, {
      code: `trainer-${suffix}`, primaryLanguage: 'en', translations: { en: { title: 'Trainer subject' } },
   })
   const course = await client.query(
      `INSERT INTO courses (title, subject_id, status, created_by) VALUES ($1, $2, 'published', $3) RETURNING id`,
      [`Trainer ${suffix}`, subject.id, adminId],
   )
   await client.query(
      'INSERT INTO course_enrollments (user_id, course_id, granted_by) VALUES ($1, $2, $3)',
      [studentId, course.rows[0].id, adminId],
   )
   const bank = await createQuestionBankService(adminId, {
      code: `nct-${suffix}-bank`, title: 'NCT', subjectId: subject.id, visibility: 'staff',
   })
   const otherBank = await createQuestionBankService(adminId, {
      code: `other-${suffix}`, title: 'Not NCT', subjectId: subject.id, visibility: 'staff',
   })

   // Correct option per question id, to answer later.
   const keys = new Map()
   async function addQuestion(bankId, difficulty, { publish = true, withImage = false } = {}) {
      const content = withImage
         ? { blocks: [{ type: 'text', text: 'Look' }, { type: 'image', assetId: await insertAsset(adminId), alt: 'fig' }] }
         : text(`Question ${difficulty}`)
      const question = await createQuestionService(adminId, bankId, {
         questionType: 'single_choice',
         languageCode: 'en',
         difficulty,
         difficultySource: 'expert',
         content,
         options: [{ key: 'A', content: text('A') }, { key: 'B', content: text('B') }],
      })
      await replaceAnswerKeyService(adminId, question.id, {
         answerData: { optionKey: 'B' }, source: 'expert_review', explanation: text('Because B'),
      })
      if (publish) {
         await verifyAnswerKeyService(adminId, question.id, { source: 'expert_review' })
         await publishQuestionService(adminId, question.id)
      }
      keys.set(String(question.id), 'B')
      return String(question.id)
   }

   const easy = []
   for (let index = 0; index < 4; index += 1) easy.push(await addQuestion(bank.id, index % 2 ? 1 : 2))
   for (let index = 0; index < 5; index += 1) await addQuestion(bank.id, 3)
   for (let index = 0; index < 3; index += 1) await addQuestion(bank.id, 4, { withImage: true })
   await addQuestion(bank.id, 3, { publish: false })
   await addQuestion(otherBank.id, 3)

   const request = (body) => ({ subject: subject.code, difficulty: 'mixed', count: 10, ...body })
   let attemptId

   await t.test('shares split by largest remainder', () => {
      assert.deepEqual(splitByShares(10, [30, 40, 30]), [3, 4, 3])
      assert.deepEqual(splitByShares(20, [30, 40, 30]), [6, 8, 6])
      assert.deepEqual(splitByShares(1, [30, 40, 30]), [0, 1, 0])
   })

   await t.test('catalog counts published verified NCT questions per difficulty', async () => {
      const catalog = await getTrainerCatalogService(studentId, deps)
      assert.deepEqual(catalog.options.difficulties, ['easy', 'medium', 'hard', 'mixed'])
      assert.deepEqual(catalog.options.mixedShares, { easy: 30, medium: 40, hard: 30 })
      const entry = catalog.subjects.find((row) => row.code === subject.code)
      assert.equal(entry.accessible, true)
      assert.deepEqual(entry.languages, [{ language: 'en', total: 12, difficulties: { easy: 4, medium: 5, hard: 3 } }])
      const outsider = await getTrainerCatalogService(outsiderId, deps)
      assert.equal(outsider.subjects.find((row) => row.code === subject.code).accessible, false)
   })

   await t.test('validation, access and shortage are refused with stable codes', async () => {
      await assert.rejects(createTrainerAttemptService(studentId, request({ count: 7 }), deps), { code: 'VALIDATION_ERROR' })
      await assert.rejects(createTrainerAttemptService(studentId, request({ difficulty: 'extreme' }), deps), { code: 'VALIDATION_ERROR' })
      await assert.rejects(createTrainerAttemptService(studentId, request({ subject: 'missing-subject' }), deps), { code: 'SUBJECT_NOT_FOUND' })
      await assert.rejects(createTrainerAttemptService(outsiderId, request(), deps), { code: 'TRAINER_ACCESS_DENIED' })
      await assert.rejects(
         createTrainerAttemptService(studentId, request({ difficulty: 'easy', count: 10 }), deps),
         (error) => error.code === 'TRAINER_NOT_ENOUGH_QUESTIONS' && error.details[0].message === '4',
      )
      await assert.rejects(
         createTrainerAttemptService(studentId, request({ count: 20 }), deps),
         (error) => error.code === 'TRAINER_NOT_ENOUGH_QUESTIONS' && error.details[0].message === '12',
      )
   })

   await t.test('mixed creates a 30/40/30 attempt without keys', async () => {
      const view = await createTrainerAttemptService(studentId, request({ idempotencyKey: `key-${suffix}-1` }), deps)
      assert.equal(view.resumed, false)
      attemptId = view.attempt.id
      assert.equal(view.questions.length, 10)
      const serialized = JSON.stringify(view)
      for (const secret of ['correctAnswer', 'answerData', 'grading', 'explanation', 'Because B']) {
         assert.equal(serialized.includes(secret), false, secret)
      }
      const { rows } = await client.query(
         `SELECT question.difficulty, count(*)::integer AS total
          FROM attempt_questions AS item JOIN questions AS question ON question.id = item.question_id
          WHERE item.attempt_id = $1 GROUP BY 1 ORDER BY 1`,
         [attemptId],
      )
      const byLevel = { easy: 0, medium: 0, hard: 0 }
      for (const row of rows) byLevel[row.difficulty <= 2 ? 'easy' : row.difficulty === 3 ? 'medium' : 'hard'] += row.total
      assert.deepEqual(byLevel, { easy: 3, medium: 4, hard: 3 })
      // Hard questions carry images, signed like any attempt view.
      const imageBlocks = view.questions.flatMap((question) => question.content.blocks).filter((block) => block.type === 'image')
      assert.equal(imageBlocks.length, 3)
      assert.ok(imageBlocks.every((block) => /^https:\/\/storage\.test\/signed\//.test(block.url)))
   })

   await t.test('repeats, a running training and foreign attempts are handled', async () => {
      const again = await createTrainerAttemptService(studentId, request({ idempotencyKey: `key-${suffix}-1` }), deps)
      assert.equal(again.resumed, true)
      assert.equal(again.attempt.id, attemptId)
      await assert.rejects(
         createTrainerAttemptService(studentId, request({ count: 4, idempotencyKey: `key-${suffix}-1` }), deps),
         { code: 'IDEMPOTENCY_KEY_REUSED' },
      )
      await assert.rejects(
         createTrainerAttemptService(studentId, request({ count: 4 }), deps),
         (error) => error.code === 'TRAINER_ATTEMPT_IN_PROGRESS' && error.details[0].message === String(attemptId),
      )
      await assert.rejects(getAttemptService(outsiderId, attemptId, deps), { code: 'ATTEMPT_NOT_FOUND' })
      await assert.rejects(submitAttemptService(outsiderId, attemptId, deps), { code: 'ATTEMPT_NOT_FOUND' })
      await assert.rejects(getAttemptResultService(studentId, attemptId, deps), { code: 'RESULT_NOT_READY' })
   })

   await t.test('submit grades with the engine and reveals keys; a repeat changes nothing', async () => {
      const view = await getAttemptService(studentId, attemptId, deps)
      // Right on the first six, wrong on the rest.
      for (const [index, question] of view.questions.entries()) {
         await saveAnswerService(studentId, attemptId, question.id, { answer: { optionKey: index < 6 ? 'B' : 'A' }, revision: 1 }, deps)
      }
      const result = await submitAttemptService(studentId, attemptId, deps)
      assert.equal(result.revealed, true)
      assert.equal(Number(result.attempt.score), 6)
      assert.equal(Number(result.attempt.maxScore), 10)
      assert.equal(result.questions.filter((question) => question.correct).length, 6)
      assert.ok(result.questions.every((question) => question.correctAnswer.optionKey === 'B'))
      assert.ok(result.questions.every((question) => question.explanation.blocks[0].text === 'Because B'))
      const imageBlocks = result.questions.flatMap((question) => question.content.blocks).filter((block) => block.type === 'image')
      assert.ok(imageBlocks.every((block) => typeof block.url === 'string'))

      const repeat = await submitAttemptService(studentId, attemptId, deps)
      assert.equal(repeat.attempt.score, result.attempt.score)
      assert.equal(repeat.attempt.submittedAt, result.attempt.submittedAt)
   })

   await t.test('unseen questions are picked first', async () => {
      const { rows } = await client.query(
         `SELECT item.question_id::text AS id FROM attempt_questions AS item WHERE item.attempt_id = $1`,
         [attemptId],
      )
      const seen = new Set(rows.map((row) => row.id))
      const unseenEasy = easy.filter((id) => !seen.has(id))
      assert.equal(unseenEasy.length, 1)
      const view = await createTrainerAttemptService(studentId, request({ difficulty: 'easy', count: 1 }), deps)
      const picked = await client.query('SELECT question_id::text AS id FROM attempt_questions WHERE attempt_id = $1', [view.attempt.id])
      assert.deepEqual(picked.rows.map((row) => row.id), unseenEasy)
      await submitAttemptService(studentId, view.attempt.id, deps)
   })

   await t.test('history and statistics; trainer tests stay out of authoring lists', async () => {
      const history = await listTrainerHistoryService(studentId, {}, deps)
      assert.equal(history.attempts.length, 2)
      assert.equal(history.attempts[1].attemptId, attemptId)
      assert.equal(history.attempts[1].percent, 60)
      assert.equal(history.attempts[1].difficulty, 'mixed')
      assert.deepEqual(history.stats.map((row) => [row.subjectId, row.attempts, row.averagePercent]), [
         [String(subject.id), 2, 30],
      ])
      assert.equal((await listTrainerHistoryService(outsiderId, {}, deps)).attempts.length, 0)

      const tests = await listTestsService(adminId, { courseId: String(course.rows[0].id) })
      assert.equal(tests.tests.length, 0)
   })

   await t.test('parallel creates start exactly one training', async () => {
      await client.query(
         'INSERT INTO course_enrollments (user_id, course_id, granted_by) VALUES ($1, $2, $3)',
         [outsiderId, course.rows[0].id, adminId],
      )
      const outcomes = await Promise.allSettled([1, 2, 3].map(() => (
         createTrainerAttemptService(outsiderId, request({ difficulty: 'medium', count: 2 }), deps)
      )))
      assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
      assert.ok(outcomes
         .filter((outcome) => outcome.status === 'rejected')
         .every((outcome) => outcome.reason.code === 'TRAINER_ATTEMPT_IN_PROGRESS'))
      const { rows } = await client.query(
         `SELECT count(*)::integer AS total FROM test_attempts AS attempt
          JOIN tests AS test ON test.id = attempt.test_id AND test.origin = 'trainer'
          WHERE attempt.user_id = $1`,
         [outsiderId],
      )
      assert.equal(rows[0].total, 1)
   })
})
