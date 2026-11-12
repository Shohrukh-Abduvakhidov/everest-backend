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
import { createTrainerAttemptService } from '../../src/services/trainer-service.js'
import { createMemoryStorageProvider } from '../helpers/memory-storage-provider.js'

const { Client } = pg
const suffix = randomUUID().slice(0, 8)
const text = (value) => ({ blocks: [{ type: 'text', text: value }] })

test('trainer cells questions use the mock exam digits format', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   t.after(() => client.end())
   const prefix = `nctd-${suffix}-`
   const deps = {
      storage: createMemoryStorageProvider(),
      trainerConfig: { ...env.trainer, bankCodePrefix: prefix, questionCounts: [1, 2] },
   }

   async function createUser(role) {
      const { rows } = await client.query(
         `INSERT INTO users (status, onboarding_completed_at) VALUES ('active', CURRENT_TIMESTAMP) RETURNING id`,
      )
      await client.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2', [rows[0].id, role])
      return String(rows[0].id)
   }

   const adminId = await createUser('admin')
   const studentId = await createUser('student')

   async function subjectWithBank(code) {
      const subject = await createSubjectService(adminId, {
         code, primaryLanguage: 'en', translations: { en: { title: code } },
      })
      const bank = await createQuestionBankService(adminId, {
         code: `${prefix}${code}`, title: code, subjectId: subject.id, visibility: 'staff',
      })
      return { subject, bank }
   }

   async function addNumeric(bankId, value) {
      const question = await createQuestionService(adminId, bankId, {
         questionType: 'numeric',
         languageCode: 'en',
         difficulty: 1,
         difficultySource: 'expert',
         content: text(`How many? ${value}`),
      })
      await replaceAnswerKeyService(adminId, question.id, { answerData: { value }, source: 'expert_review' })
      await verifyAnswerKeyService(adminId, question.id, { source: 'expert_review' })
      await publishQuestionService(adminId, question.id)
      return String(question.id)
   }

   // A subject with an answer-sheet cells item in an active blueprint, as in nct-a5.
   const cellsSubject = await subjectWithBank(`cells-${suffix}`)
   const { rows: [blueprint] } = await client.query(
      `INSERT INTO exam_blueprints (code, titles, language_code, bank_code_prefix, duration_minutes)
       VALUES ($1, '{"en":"Digits"}', 'en', $2, 60) RETURNING id`,
      [`digits-${suffix}`, prefix],
   )
   const { rows: [section] } = await client.query(
      `INSERT INTO exam_blueprint_sections (blueprint_id, position, subject_code) VALUES ($1, 1, $2) RETURNING id`,
      [blueprint.id, cellsSubject.subject.code],
   )
   await client.query(
      `INSERT INTO exam_blueprint_items (section_id, first_position, last_position, item_kind, points, scoring, max_digits)
       VALUES ($1, 1, 1, 'cells', 2, 'all_or_nothing', 4)`,
      [section.id],
   )
   const cellsId = await addNumeric(cellsSubject.bank.id, 1434)
   const fractionId = await addNumeric(cellsSubject.bank.id, 12.5)
   t.after(async () => {
      const admin = new Client(env.database)
      await admin.connect()
      await admin.query(`UPDATE exam_blueprints SET status = 'inactive' WHERE id = $1`, [blueprint.id])
      await admin.end()
   })

   let attemptId
   await t.test('only questions that pass the mock exam cells filter get the cells fields', async () => {
      const view = await createTrainerAttemptService(studentId, {
         subject: cellsSubject.subject.code, difficulty: 'mixed', count: 2, language: 'en',
      }, deps)
      attemptId = view.attempt.id
      const cells = view.questions.find((question) => String(question.questionType) === 'numeric'
         && question.kind === 'cells')
      const plain = view.questions.find((question) => question !== cells)
      assert.ok(cells)
      assert.deepEqual(
         { kind: cells.kind, answerFormat: cells.answerFormat, maxDigits: cells.maxDigits, points: cells.points },
         { kind: 'cells', answerFormat: 'digits', maxDigits: 4, points: '2.00' },
      )
      assert.equal(plain.kind, undefined)
      assert.equal(plain.answerFormat, undefined)
      assert.equal(plain.points, '1.00')
      const again = await getAttemptService(studentId, attemptId, deps)
      assert.equal(again.questions.find((question) => question.id === cells.id).answerFormat, 'digits')
      const { rows } = await client.query(
         'SELECT question_id, grading_snapshot FROM attempt_questions WHERE attempt_id = $1',
         [attemptId],
      )
      const snapshot = rows.find((row) => String(row.question_id) === cellsId).grading_snapshot
      assert.deepEqual(snapshot.acceptedDigits, ['1434'])
      assert.equal(rows.find((row) => String(row.question_id) === fractionId).grading_snapshot.answerFormat, undefined)
   })

   await t.test('cells take { digits } (and { value } as digits), plain numeric keeps { value }', async () => {
      const view = await getAttemptService(studentId, attemptId, deps)
      const cells = view.questions.find((question) => question.kind === 'cells')
      const plain = view.questions.find((question) => question.kind !== 'cells')
      for (const answer of [{ digits: '12345' }, { digits: '1a' }, { value: 1.5 }, { value: -1 }, { text: '1434' }]) {
         await assert.rejects(
            saveAnswerService(studentId, attemptId, cells.id, { answer, revision: 1 }, deps),
            { code: 'VALIDATION_ERROR' },
         )
      }
      const legacy = await saveAnswerService(studentId, attemptId, cells.id, { answer: { value: 1434 }, revision: 1 }, deps)
      assert.deepEqual(legacy.answer, { digits: '1434' })
      await saveAnswerService(studentId, attemptId, cells.id, { answer: { digits: '1434' }, revision: 2 }, deps)
      await assert.rejects(
         saveAnswerService(studentId, attemptId, plain.id, { answer: { digits: '12' }, revision: 1 }, deps),
         { code: 'VALIDATION_ERROR' },
      )
      await saveAnswerService(studentId, attemptId, plain.id, { answer: { value: 12.5 }, revision: 1 }, deps)
   })

   await t.test('the result shows the cells sheet and the 2-point award', async () => {
      await submitAttemptService(studentId, attemptId, deps)
      const result = await getAttemptResultService(studentId, attemptId, deps)
      assert.equal(result.attempt.score, '3.00')
      assert.equal(result.attempt.maxScore, '3.00')
      const cells = result.questions.find((question) => question.kind === 'cells')
      assert.equal(cells.awardedPoints, '2.00')
      assert.deepEqual(cells.correctAnswer, { value: 1434 })
      assert.deepEqual(cells.sheet, { digits: '1434', correctDigits: '1434', acceptedDigits: ['1434'], maxDigits: 4 })
      const plain = result.questions.find((question) => question.kind !== 'cells')
      assert.equal(plain.sheet, undefined)
      assert.equal(plain.awardedPoints, '1.00')
   })

   await t.test('a subject without a cells item keeps the plain numeric format', async () => {
      const other = await subjectWithBank(`plain-${suffix}`)
      await addNumeric(other.bank.id, 7)
      const view = await createTrainerAttemptService(studentId, {
         subject: other.subject.code, difficulty: 'mixed', count: 1, language: 'en',
      }, deps)
      const [question] = view.questions
      assert.equal(question.kind, undefined)
      await assert.rejects(
         saveAnswerService(studentId, view.attempt.id, question.id, { answer: { digits: '7' }, revision: 1 }, deps),
         { code: 'VALIDATION_ERROR' },
      )
      await saveAnswerService(studentId, view.attempt.id, question.id, { answer: { value: 7 }, revision: 1 }, deps)
      await submitAttemptService(studentId, view.attempt.id, deps)
      const result = await getAttemptResultService(studentId, view.attempt.id, deps)
      assert.equal(result.questions[0].awardedPoints, '1.00')
   })
})
