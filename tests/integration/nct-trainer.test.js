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
   getAttemptService,
   saveAnswerService,
   submitAttemptService,
} from '../../src/services/test-attempt-service.js'
import { listTestAttemptsService } from '../../src/services/test-results-service.js'
import { listTestsService } from '../../src/services/test-service.js'
import {
   createTrainerAttemptService,
   getTrainerCatalogService,
   getTrainerOverviewService,
   listTrainerHistoryService,
   splitByShares,
} from '../../src/services/trainer-service.js'
import { createMemoryStorageProvider } from '../helpers/memory-storage-provider.js'

const { Client } = pg
const suffix = randomUUID().slice(0, 8)
const text = (value) => ({ blocks: [{ type: 'text', text: value }] })
const topicByDifficulty = (difficulty) => (difficulty <= 2 ? 'grammar' : difficulty === 3 ? 'spelling' : 'reading')

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
      readinessWindow: 5,
      weakTopicMinAnswers: 2,
      weakTopicsLimit: 5,
      recentResultsLimit: 5,
   }
   const deps = { storage, trainerConfig }

   async function createUser(role, status = 'active') {
      const { rows } = await client.query(
         `INSERT INTO users (status, onboarding_completed_at, blocked_at)
          VALUES ($1::varchar, CURRENT_TIMESTAMP, CASE WHEN $1::varchar = 'blocked' THEN CURRENT_TIMESTAMP END)
          RETURNING id`,
         [status],
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
   const enrolledId = await createUser('student')
   const pendingId = await createUser('student', 'pending')
   const blockedId = await createUser('student', 'blocked')
   const teacherId = await createUser('teacher')
   const ownerId = await createUser('owner')
   const subject = await createSubjectService(adminId, {
      code: `trainer-${suffix}`, primaryLanguage: 'en', translations: { en: { title: 'Trainer subject' } },
   })
   // Only enrolledId has a course enrollment, to show that it plays no part in the trainer.
   const course = await client.query(
      `INSERT INTO courses (title, subject_id, status, created_by) VALUES ($1, $2, 'published', $3) RETURNING id`,
      [`Trainer ${suffix}`, subject.id, adminId],
   )
   await client.query(
      'INSERT INTO course_enrollments (user_id, course_id, granted_by) VALUES ($1, $2, $3)',
      [enrolledId, course.rows[0].id, adminId],
   )
   const section = await createSectionService(adminId, subject.id, {
      code: 'part-a', primaryLanguage: 'en', translations: { en: { title: 'Part A' } },
   })
   const topicIds = {}
   for (const code of ['grammar', 'spelling', 'reading']) {
      topicIds[code] = (await createTopicService(adminId, subject.id, {
         code, primaryLanguage: 'en', translations: { en: { title: code } }, sectionId: section.id,
      })).id
   }
   const bank = await createQuestionBankService(adminId, {
      code: `nct-${suffix}-bank`, title: 'NCT', subjectId: subject.id, visibility: 'staff',
   })
   const otherBank = await createQuestionBankService(adminId, {
      code: `other-${suffix}`, title: 'Not NCT', subjectId: subject.id, visibility: 'staff',
   })

   // Topic per question id: easy = grammar, medium = spelling, hard = reading. The key is B.
   const topicOf = new Map()
   async function addQuestion(bankId, difficulty, { publish = true, withImage = false } = {}) {
      const content = withImage
         ? { blocks: [{ type: 'text', text: 'Look' }, { type: 'image', assetId: await insertAsset(adminId), alt: 'fig' }] }
         : text(`Question ${difficulty}`)
      const question = await createQuestionService(adminId, bankId, {
         questionType: 'single_choice',
         languageCode: 'en',
         difficulty,
         difficultySource: 'expert',
         topicIds: [topicIds[topicByDifficulty(difficulty)]],
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
      topicOf.set(String(question.id), topicByDifficulty(difficulty))
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

   await t.test('catalog counts published verified NCT questions per difficulty, section and topic', async () => {
      const catalog = await getTrainerCatalogService(studentId, deps)
      assert.deepEqual(catalog.options.difficulties, ['easy', 'medium', 'hard', 'mixed'])
      assert.deepEqual(catalog.options.mixedShares, { easy: 30, medium: 40, hard: 30 })
      const entry = catalog.subjects.find((row) => row.code === subject.code)
      assert.equal(Object.hasOwn(entry, 'accessible'), false)
      assert.deepEqual(entry.languages, [{ language: 'en', total: 12, difficulties: { easy: 4, medium: 5, hard: 3 } }])
      assert.deepEqual(entry.sections, [{ code: 'part-a', titles: { en: 'Part A' }, total: 12 }])
      assert.deepEqual(entry.topics.map((topic) => [topic.code, topic.sectionCode, topic.total]), [
         ['grammar', 'part-a', 4], ['reading', 'part-a', 3], ['spelling', 'part-a', 5],
      ])
   })

   await t.test('only active students, administrators and owners may use the trainer; courses play no part', async () => {
      for (const userId of [pendingId, blockedId]) {
         await assert.rejects(getTrainerCatalogService(userId, deps), { code: 'ACCOUNT_NOT_ACTIVE' })
         await assert.rejects(createTrainerAttemptService(userId, request(), deps), { code: 'ACCOUNT_NOT_ACTIVE' })
         await assert.rejects(getTrainerOverviewService(userId, deps), { code: 'ACCOUNT_NOT_ACTIVE' })
         await assert.rejects(listTrainerHistoryService(userId, {}, deps), { code: 'ACCOUNT_NOT_ACTIVE' })
      }
      await assert.rejects(getTrainerCatalogService(teacherId, deps), { code: 'TRAINER_STUDENT_ROLE_REQUIRED' })
      await assert.rejects(createTrainerAttemptService(teacherId, request(), deps), { code: 'TRAINER_STUDENT_ROLE_REQUIRED' })
      const { rows } = await client.query('SELECT count(*)::integer AS total FROM course_enrollments WHERE user_id = $1', [studentId])
      assert.equal(rows[0].total, 0)
   })

   await t.test('validation and shortage are refused with stable codes', async () => {
      await assert.rejects(createTrainerAttemptService(studentId, request({ count: 7 }), deps), { code: 'VALIDATION_ERROR' })
      await assert.rejects(createTrainerAttemptService(studentId, request({ difficulty: 'extreme' }), deps), { code: 'VALIDATION_ERROR' })
      await assert.rejects(createTrainerAttemptService(studentId, request({ subject: 'missing-subject' }), deps), { code: 'SUBJECT_NOT_FOUND' })
      await assert.rejects(
         createTrainerAttemptService(studentId, request({ difficulty: 'easy', count: 10 }), deps),
         (error) => error.code === 'TRAINER_NOT_ENOUGH_QUESTIONS' && error.details[0].message === '4',
      )
      await assert.rejects(
         createTrainerAttemptService(studentId, request({ count: 20 }), deps),
         (error) => error.code === 'TRAINER_NOT_ENOUGH_QUESTIONS' && error.details[0].message === '12',
      )
   })

   await t.test('an empty overview is a state, not an error', async () => {
      assert.deepEqual(await getTrainerOverviewService(studentId, deps), {
         empty: true,
         readinessPercent: null,
         completedTrainings: 0,
         readinessWindow: 5,
         subjects: [],
         weakTopics: [],
         recentResults: [],
      })
   })

   await t.test('a student without enrollments creates a 30/40/30 training without keys', async () => {
      const view = await createTrainerAttemptService(studentId, request({ idempotencyKey: `key-${suffix}-1` }), deps)
      assert.equal(view.resumed, false)
      attemptId = view.attempt.id
      assert.equal(view.questions.length, 10)
      const created = await client.query(
         'SELECT course_id, origin FROM tests WHERE id = (SELECT test_id FROM test_attempts WHERE id = $1)',
         [attemptId],
      )
      assert.deepEqual(created.rows[0], { course_id: null, origin: 'trainer' })
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
      const items = await client.query(
         'SELECT id::text AS id, question_id::text AS question_id FROM attempt_questions WHERE attempt_id = $1',
         [attemptId],
      )
      const questionOf = new Map(items.rows.map((row) => [row.id, row.question_id]))
      // Grammar and reading right (3 + 3), spelling wrong (4).
      for (const question of view.questions) {
         const wrong = topicOf.get(questionOf.get(String(question.id))) === 'spelling'
         await saveAnswerService(studentId, attemptId, question.id, { answer: { optionKey: wrong ? 'A' : 'B' }, revision: 1 }, deps)
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
         'SELECT item.question_id::text AS id FROM attempt_questions AS item WHERE item.attempt_id = $1',
         [attemptId],
      )
      const seen = new Set(rows.map((row) => row.id))
      const unseenEasy = easy.filter((id) => !seen.has(id))
      assert.equal(unseenEasy.length, 1)
      const view = await createTrainerAttemptService(studentId, request({ difficulty: 'easy', count: 1 }), deps)
      const picked = await client.query('SELECT question_id::text AS id FROM attempt_questions WHERE attempt_id = $1', [view.attempt.id])
      assert.deepEqual(picked.rows.map((row) => row.id), unseenEasy)
      // Submitted unanswered: one wrong grammar question.
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

      const trainerTests = await client.query(`SELECT id::text AS id FROM tests WHERE origin = 'trainer'`)
      const listed = (await listTestsService(adminId, { limit: '100' })).tests.map((row) => String(row.id))
      assert.equal(listed.some((id) => trainerTests.rows.some((row) => row.id === id)), false)
   })

   await t.test('parallel creates start exactly one training', async () => {
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

   await t.test('overview: readiness, weak topics and recent results of my own trainings only', async () => {
      // The outsider finishes its training of two unanswered spelling questions.
      const running = await client.query(
         `SELECT id FROM test_attempts WHERE user_id = $1 AND status = 'in_progress'`,
         [outsiderId],
      )
      await submitAttemptService(outsiderId, running.rows[0].id, deps)

      const overview = await getTrainerOverviewService(studentId, deps)
      assert.equal(overview.empty, false)
      assert.equal(overview.completedTrainings, 2)
      // (6 + 0) / (10 + 1) over both trainings of the subject.
      assert.equal(overview.readinessPercent, 54.55)
      assert.deepEqual(overview.subjects.map((row) => [row.subjectCode, row.readinessPercent, row.trainings]), [
         [subject.code, 54.55, 2],
      ])
      assert.ok(overview.subjects[0].lastSubmittedAt)
      assert.deepEqual(overview.weakTopics.map((row) => [row.topicCode, row.answered, row.correct, row.correctPercent]), [
         ['spelling', 4, 0, 0],
         ['grammar', 4, 3, 75],
      ])
      assert.equal(overview.weakTopics[0].subjectCode, subject.code)
      assert.deepEqual(overview.recentResults.map((row) => [row.difficulty, row.questionCount, row.percent]), [
         ['easy', 1, 0],
         ['mixed', 10, 60],
      ])
      assert.equal(overview.recentResults[1].attemptId, attemptId)

      const other = await getTrainerOverviewService(outsiderId, deps)
      assert.equal(other.completedTrainings, 1)
      assert.equal(other.readinessPercent, 0)
      assert.deepEqual(other.weakTopics.map((row) => [row.topicCode, row.answered]), [['spelling', 2]])
      assert.equal(other.recentResults.length, 1)
   })

   await t.test('a running training does not depend on course enrollments; blocking stops it', async () => {
      const view = await createTrainerAttemptService(enrolledId, request({ difficulty: 'hard', count: 2 }), deps)
      await client.query(
         'UPDATE course_enrollments SET revoked_at = CURRENT_TIMESTAMP, revoked_by = $2 WHERE user_id = $1',
         [enrolledId, adminId],
      )
      await saveAnswerService(enrolledId, view.attempt.id, view.questions[0].id, { answer: { optionKey: 'B' }, revision: 1 }, deps)
      assert.equal((await getAttemptService(enrolledId, view.attempt.id, deps)).questions.length, 2)
      const result = await submitAttemptService(enrolledId, view.attempt.id, deps)
      assert.equal(Number(result.attempt.score), 1)

      const next = await createTrainerAttemptService(enrolledId, request({ difficulty: 'easy', count: 1 }), deps)
      await client.query(`UPDATE users SET status = 'blocked', blocked_at = CURRENT_TIMESTAMP WHERE id = $1`, [enrolledId])
      await assert.rejects(getAttemptService(enrolledId, next.attempt.id, deps), { code: 'ACCOUNT_NOT_ACTIVE' })
      await assert.rejects(
         saveAnswerService(enrolledId, next.attempt.id, next.questions[0].id, { answer: { optionKey: 'B' }, revision: 1 }, deps),
         { code: 'ACCOUNT_NOT_ACTIVE' },
      )
   })
   await t.test('administrators and owners train like students, in isolation from students and each other', async () => {
      const readStudentSide = async () => JSON.stringify([
         await getTrainerOverviewService(studentId, deps),
         await listTrainerHistoryService(studentId, {}, deps),
         await listTrainerHistoryService(outsiderId, {}, deps),
         (await client.query(
            `SELECT count(*)::integer AS total, coalesce(sum(score), 0)::text AS points
             FROM test_attempts WHERE user_id = ANY($1::bigint[])`,
            [[studentId, outsiderId, enrolledId]],
         )).rows,
      ])
      const before = await readStudentSide()
      const attemptsOf = {}

      for (const [label, userId] of [['admin', adminId], ['owner', ownerId]]) {
         const catalog = await getTrainerCatalogService(userId, deps)
         assert.equal(catalog.subjects.some((item) => item.code === subject.code), true)
         assert.equal((await getTrainerOverviewService(userId, deps)).empty, true, label)

         const view = await createTrainerAttemptService(userId, request({ difficulty: 'easy', count: 2 }), deps)
         assert.equal(view.questions.length, 2)
         assert.equal(JSON.stringify(view).includes('correctAnswer'), false)
         // One running training per account, and only its own.
         await assert.rejects(
            createTrainerAttemptService(userId, request({ difficulty: 'easy', count: 4 }), deps),
            (error) => error.code === 'TRAINER_ATTEMPT_IN_PROGRESS' && error.details[0].message === String(view.attempt.id),
         )

         await saveAnswerService(userId, view.attempt.id, view.questions[0].id, { answer: { optionKey: 'B' }, revision: 1 }, deps)
         assert.equal((await getAttemptService(userId, view.attempt.id, deps)).questions.length, 2)
         const submitted = await submitAttemptService(userId, view.attempt.id, deps)
         assert.equal(Number(submitted.attempt.score), 1)
         const result = await getAttemptResultService(userId, view.attempt.id, deps)
         assert.equal(result.revealed, true)
         assert.equal(result.questions.filter((question) => question.correct).length, 1)

         const overview = await getTrainerOverviewService(userId, deps)
         assert.equal(overview.completedTrainings, 1)
         assert.equal(overview.recentResults[0].attemptId, String(view.attempt.id))
         const history = await listTrainerHistoryService(userId, {}, deps)
         assert.deepEqual(history.attempts.map((row) => row.attemptId), [String(view.attempt.id)])
         attemptsOf[label] = String(view.attempt.id)
      }

      // Own trainings only: the other staff account cannot read them, and no authoring screen lists them.
      await assert.rejects(getAttemptService(adminId, attemptsOf.owner, deps), { code: 'ATTEMPT_NOT_FOUND' })
      await assert.rejects(getAttemptResultService(ownerId, attemptsOf.admin, deps), { code: 'ATTEMPT_NOT_FOUND' })
      const { rows } = await client.query('SELECT test_id::text AS id FROM test_attempts WHERE id = $1', [attemptsOf.owner])
      await assert.rejects(listTestAttemptsService(adminId, rows[0].id, {}), { code: 'TEST_NOT_FOUND' })
      const listed = (await listTestsService(ownerId, { limit: '100' })).tests.map((row) => String(row.id))
      assert.equal(listed.includes(rows[0].id), false)

      // Student statistics, histories and attempt rows are exactly as before.
      assert.equal(await readStudentSide(), before)

      // Teachers stay out; students still work.
      await assert.rejects(getTrainerOverviewService(teacherId, deps), { code: 'TRAINER_STUDENT_ROLE_REQUIRED' })
      await assert.rejects(listTrainerHistoryService(teacherId, {}, deps), { code: 'TRAINER_STUDENT_ROLE_REQUIRED' })
      assert.equal((await getTrainerCatalogService(studentId, deps)).subjects.length > 0, true)
   })
})
