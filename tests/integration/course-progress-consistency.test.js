import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import pg from 'pg'

import env from '../../src/configs/env.js'
import { errorHandler } from '../../src/configs/error-handler.js'
import { withTransaction } from '../../src/repositories/transaction-repository.js'
import {
   grantCourseEnrollmentService,
   grantModuleAccessService,
} from '../../src/services/course-access-service.js'
import { completeMissedTestLessonsService } from '../../src/services/lesson-completion-service.js'
import {
   listLearnerCourseModulesService,
   listLearnerCoursesService,
} from '../../src/services/learner-course-service.js'
import { saveLessonProgressService } from '../../src/services/learner-lesson-service.js'
import {
   createLessonService,
   publishLessonService,
   updateLessonService,
} from '../../src/services/lesson-service.js'
import {
   createQuestionBankService,
   createQuestionService,
   publishQuestionService,
   replaceAnswerKeyService,
   verifyAnswerKeyService,
} from '../../src/services/question-bank-service.js'
import { getStudentHomeService } from '../../src/services/student-home-service.js'
import { createSubjectService } from '../../src/services/taxonomy-service.js'
import {
   getAttemptResultService,
   saveAnswerService,
   startAttemptService,
   submitAttemptService,
} from '../../src/services/test-attempt-service.js'
import {
   addTestQuestionsService,
   createAssignmentService,
   createTestService,
   publishTestService,
} from '../../src/services/test-service.js'

const { Client } = pg
const suffix = randomUUID().slice(0, 8)
const text = (value) => ({ blocks: [{ type: 'text', text: value }] })

test('course and module progress, test lesson completion, database errors', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   t.after(() => client.end())

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

   const adminId = await createUser('admin')
   const subject = await createSubjectService(adminId, {
      code: `biologiya-${suffix}`,
      primaryLanguage: 'tg',
      translations: { tg: { title: 'Биология' } },
   })
   const bank = await createQuestionBankService(adminId, {
      code: `progress-bank-${suffix}`, title: 'Progress', subjectId: subject.id, visibility: 'staff',
   })
   // Two questions of one point: one right answer is exactly 50 percent.
   const questionIds = []
   for (const title of ['First', 'Second']) {
      const created = await createQuestionService(adminId, bank.id, {
         questionType: 'single_choice',
         languageCode: 'tg',
         content: text(`${title} ${suffix}`),
         options: [{ key: 'A', content: text('Right') }, { key: 'B', content: text('Wrong') }],
      })
      await replaceAnswerKeyService(adminId, created.id, { answerData: { optionKey: 'A' }, source: 'expert_review' })
      await verifyAnswerKeyService(adminId, created.id, { source: 'expert_review' })
      await publishQuestionService(adminId, created.id)
      questionIds.push(created.id)
   }

   let courseIndex = 0
   async function course() {
      courseIndex += 1
      const row = await client.query(
         `INSERT INTO courses (title, subject_id, status, created_by)
          VALUES ($1, $2, 'published', $3) RETURNING id`,
         [`Биология ${courseIndex} ${suffix}`, subject.id, adminId],
      )
      const courseId = row.rows[0].id
      const modules = await client.query(
         `INSERT INTO course_modules (course_id, title, position, status)
          VALUES ($1, 'Мундарича', 1, 'published'), ($1, 'Locked', 2, 'published') RETURNING id`,
         [courseId],
      )
      return { courseId, moduleId: modules.rows[0].id, lockedModuleId: modules.rows[1].id }
   }

   async function publishedTest(courseId, settings = {}) {
      const quiz = await createTestService(adminId, {
         courseId, title: `Quiz ${randomUUID().slice(0, 6)}`, mode: 'practice', maxAttempts: 3, ...settings,
      })
      await addTestQuestionsService(adminId, quiz.id, {
         questions: questionIds.map((questionId) => ({ questionId, points: '1' })),
      })
      await publishTestService(adminId, quiz.id)
      return quiz
   }

   async function lesson(courseId, moduleId, body) {
      const row = await createLessonService(adminId, courseId, moduleId, { title: `L ${randomUUID().slice(0, 6)}`, ...body })
      await publishLessonService(adminId, courseId, row.id)
      return row.id
   }

   async function student(courseId, moduleId) {
      const id = await createUser('student')
      await grantCourseEnrollmentService(adminId, courseId, { userId: id, expiresAt: null })
      await grantModuleAccessService(adminId, courseId, id, { moduleId, expiresAt: null })
      return id
   }

   // Answers the first question with firstKey and the second with B (wrong), then submits.
   const assignments = new Map()
   async function attempt(learner, quizId, firstKey) {
      const key = `${learner}:${quizId}`
      if (!assignments.has(key)) assignments.set(key, await createAssignmentService(adminId, quizId, { userId: learner }))
      const assignment = assignments.get(key)
      const view = await startAttemptService(learner, assignment.id)
      await saveAnswerService(learner, view.attempt.id, view.questions[0].id, { answer: { optionKey: firstKey }, revision: 1 })
      await saveAnswerService(learner, view.attempt.id, view.questions[1].id, { answer: { optionKey: 'B' }, revision: 1 })
      await submitAttemptService(learner, view.attempt.id)
      return view.attempt.id
   }

   async function progressOf(learner, lessonId) {
      const { rows } = await client.query(
         'SELECT status, completed_at FROM lesson_progress WHERE user_id = $1 AND lesson_id = $2',
         [learner, lessonId],
      )
      return rows[0] || null
   }

   async function views(learner, courseId) {
      const detail = await listLearnerCourseModulesService(learner, courseId)
      const card = (await listLearnerCoursesService(learner)).courses.find((item) => item.id === courseId)
      return { detail, card }
   }

   await t.test('a passed test lesson completes, and the module and the course agree', async () => {
      const { courseId, moduleId, lockedModuleId } = await course()
      const quiz = await publishedTest(courseId, { passPercent: 50 })
      const textLesson = await lesson(courseId, moduleId, { lessonType: 'text' })
      const testLesson = await lesson(courseId, moduleId, { lessonType: 'test', testId: quiz.id })
      await lesson(courseId, moduleId, { lessonType: 'text' })
      await lesson(courseId, lockedModuleId, { lessonType: 'text' })
      const learner = await student(courseId, moduleId)

      await saveLessonProgressService(learner, courseId, textLesson, { revision: 0, completed: true })
      const attemptId = await attempt(learner, quiz.id, 'A')
      const result = await getAttemptResultService(learner, attemptId)
      assert.equal(result.percent, 50)
      assert.equal(result.passed, true, 'exactly passPercent passes')
      assert.equal((await progressOf(learner, testLesson)).status, 'completed')

      const { detail, card } = await views(learner, courseId)
      const [open, locked] = detail.modules
      assert.deepEqual(open.progress, { completedLessons: 2, totalLessons: 3, percent: 66 })
      assert.equal(locked.access.granted, false)
      assert.equal(locked.progress, null, 'a locked module shows no counts')
      assert.deepEqual(detail.course.progress, open.progress, 'course = sum of open modules')
      assert.deepEqual(card.progress, detail.course.progress, 'course card uses the same rule')
      assert.equal(card.subject.code, `biologiya-${suffix}`)
      assert.equal(detail.course.subject.code, `biologiya-${suffix}`)

      // Home: the same course card and the subject code of the finished attempt.
      const home = await getStudentHomeService(learner)
      assert.deepEqual(home.courses.find((item) => item.id === courseId).progress, card.progress)
      const recent = home.recentResults.find((item) => item.attemptId === attemptId)
      assert.equal(recent.subjectCode, `biologiya-${suffix}`)
      assert.equal(recent.subjectId, subject.id)
   })

   await t.test('a failed test does not complete, and the module still matches the course', async () => {
      const { courseId, moduleId } = await course()
      const quiz = await publishedTest(courseId, { passPercent: 70 })
      const testLesson = await lesson(courseId, moduleId, { lessonType: 'test', testId: quiz.id })
      const learner = await student(courseId, moduleId)
      const attemptId = await attempt(learner, quiz.id, 'A')
      assert.equal((await getAttemptResultService(learner, attemptId)).passed, false)
      assert.equal(await progressOf(learner, testLesson), null)
      const { detail, card } = await views(learner, courseId)
      assert.deepEqual(detail.modules[0].progress, { completedLessons: 0, totalLessons: 1, percent: 0 })
      assert.deepEqual(card.progress, detail.course.progress)
   })

   await t.test('linking a lesson to a test the student already passed completes it', async () => {
      const { courseId, moduleId } = await course()
      const passedQuiz = await publishedTest(courseId, { passPercent: 50 })
      const failedQuiz = await publishedTest(courseId, { passPercent: 60 })
      const learner = await student(courseId, moduleId)
      const other = await student(courseId, moduleId)
      const passedAttempt = await attempt(learner, passedQuiz.id, 'A')
      await attempt(other, passedQuiz.id, 'B')
      await attempt(learner, failedQuiz.id, 'A')
      const { rows } = await client.query('SELECT submitted_at FROM test_attempts WHERE id = $1', [passedAttempt])

      // Created after the attempt: completed from it, completed_at is when the attempt finished.
      const created = await lesson(courseId, moduleId, { lessonType: 'test', testId: passedQuiz.id })
      const done = await progressOf(learner, created)
      assert.equal(done.status, 'completed')
      assert.equal(done.completed_at.toISOString(), rows[0].submitted_at.toISOString())
      assert.equal(await progressOf(other, created), null, 'a failed attempt completes nothing')
      const events = await client.query(
         `SELECT metadata FROM learning_activity_events
          WHERE user_id = $1 AND lesson_id = $2 AND event_code = 'lesson_completed'`,
         [learner, created],
      )
      assert.equal(events.rows.length, 1)
      assert.equal(events.rows[0].metadata.attemptId, passedAttempt)

      // Relinked from a failed test to a passed one.
      const relinked = await lesson(courseId, moduleId, { lessonType: 'test', testId: failedQuiz.id })
      assert.equal(await progressOf(learner, relinked), null)
      await updateLessonService(adminId, courseId, relinked, { testId: passedQuiz.id })
      assert.equal((await progressOf(learner, relinked)).status, 'completed')
   })

   await t.test('the recompute plan finds a lesson the rule missed; apply is idempotent', async () => {
      const { courseId, moduleId } = await course()
      const quiz = await publishedTest(courseId, { passPercent: 50 })
      const testLesson = await lesson(courseId, moduleId, { lessonType: 'test', testId: quiz.id })
      const learner = await student(courseId, moduleId)
      const first = await attempt(learner, quiz.id, 'A')
      await attempt(learner, quiz.id, 'B')
      // As on 2026-11-05: the attempt finished before the completion rule existed.
      await client.query('DELETE FROM lesson_progress WHERE user_id = $1 AND lesson_id = $2', [learner, testLesson])
      await client.query('DELETE FROM learning_activity_events WHERE user_id = $1 AND lesson_id = $2', [learner, testLesson])

      const planned = await withTransaction((tx) => completeMissedTestLessonsService({ lessonId: testLesson, apply: false }, tx))
      assert.deepEqual(planned.map((item) => [item.userId, item.attemptId]), [[learner, first]])
      assert.equal(await progressOf(learner, testLesson), null, 'the dry run writes nothing')

      const written = await withTransaction((tx) => completeMissedTestLessonsService({ lessonId: testLesson }, tx))
      assert.equal(written.length, 1)
      assert.equal((await progressOf(learner, testLesson)).status, 'completed')
      const again = await withTransaction((tx) => completeMissedTestLessonsService({ lessonId: testLesson }, tx))
      assert.deepEqual(again, [])
      const { detail, card } = await views(learner, courseId)
      assert.deepEqual(detail.modules[0].progress, { completedLessons: 1, totalLessons: 1, percent: 100 })
      assert.deepEqual(card.progress, detail.modules[0].progress)
   })

   await t.test('real PostgreSQL integrity errors answer 400 or 409 without SQL', async (t2) => {
      t2.mock.method(console, 'error', () => {})
      async function failure(sql, params) {
         await client.query('BEGIN')
         try {
            await client.query(sql, params)
            assert.fail('expected a database error')
         } catch (error) {
            return error
         } finally {
            await client.query('ROLLBACK')
         }
      }
      function answer(error, method = 'POST') {
         const response = {
            status(code) { this.statusCode = code; return this },
            json(body) { this.body = body; return this },
            set() { return this },
         }
         errorHandler(error, { method, originalUrl: '/api/v1/admin/tests' }, response, () => {})
         return response
      }
      // The scenario of the logged 23514: a standalone test against a schema without that origin.
      const check = await failure(
         `INSERT INTO tests (title, mode, created_by, origin) VALUES ('x', 'practice', $1, 'unknown')`,
         [adminId],
      )
      assert.equal(check.code, '23514')
      const checked = answer(check)
      assert.equal(checked.statusCode, 400)
      assert.equal(checked.body.error.code, 'VALIDATION_ERROR')
      assert.ok(!/tests_|INSERT|unknown/.test(JSON.stringify(checked.body)))

      const notNull = await failure('INSERT INTO tests (mode, created_by) VALUES ($1, $2)', ['practice', adminId])
      assert.equal(notNull.code, '23502')
      assert.equal(answer(notNull).statusCode, 400)

      const duplicate = await failure(
         `INSERT INTO subjects (code, primary_language) VALUES ($1, 'tg')`,
         [`biologiya-${suffix}`],
      )
      assert.equal(duplicate.code, '23505')
      assert.equal(answer(duplicate).body.error.code, 'CONFLICT')
      assert.equal(answer(duplicate).statusCode, 409)

      const missing = await failure(
         `INSERT INTO tests (title, mode, created_by, course_id) VALUES ('x', 'practice', $1, 999999999999)`,
         [adminId],
      )
      assert.equal(missing.code, '23503')
      assert.equal(answer(missing).body.error.code, 'REFERENCE_NOT_FOUND')
      const inUse = await failure('DELETE FROM subjects WHERE id = $1', [subject.id])
      assert.ok(['23503', '23001'].includes(inUse.code))
      assert.equal(answer(inUse, 'DELETE').statusCode, 409)
      assert.equal(answer(inUse, 'DELETE').body.error.code, 'REFERENCE_IN_USE')
   })
})
