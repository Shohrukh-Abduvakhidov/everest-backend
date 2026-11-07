import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import pg from 'pg'

import { createApp } from '../../src/app.js'
import env from '../../src/configs/env.js'
import { startAttemptSweepWorker } from '../../src/jobs/attempt-sweep-worker.js'
import { withTransaction } from '../../src/repositories/transaction-repository.js'
import { issueSessionService } from '../../src/services/auth/session-service.js'
import {
   grantCourseEnrollmentService,
   grantModuleAccessService,
} from '../../src/services/course-access-service.js'
import {
   listLearnerCourseModulesService,
   listLearnerCoursesService,
} from '../../src/services/learner-course-service.js'
import {
   getLearnerLessonService,
   listLearnerLessonsService,
   saveLessonProgressService,
} from '../../src/services/learner-lesson-service.js'
import { createLessonService, publishLessonService } from '../../src/services/lesson-service.js'
import {
   createQuestionBankService,
   createQuestionService,
   publishQuestionService,
   replaceAnswerKeyService,
   verifyAnswerKeyService,
} from '../../src/services/question-bank-service.js'
import { createSubjectService } from '../../src/services/taxonomy-service.js'
import {
   finalizeNextExpiredAttemptService,
   getAssignmentResultService,
   getAttemptResultService,
   listMyAssignmentsService,
   saveAnswerService,
   startAttemptService,
   submitAttemptService,
} from '../../src/services/test-attempt-service.js'
import {
   getTestAttemptService,
   listTestAttemptsService,
   regradeAttemptService,
} from '../../src/services/test-results-service.js'
import {
   addTestQuestionsService,
   createAssignmentService,
   createTestService,
   publishTestService,
   revokeAssignmentService,
} from '../../src/services/test-service.js'

const { Client } = pg
const config = {
   ...env,
   jwtAccessSecret: 'm11-gaps-integration-secret-longer-than-32-chars',
   authSessionTtlSeconds: 900,
   authRefreshTtlSeconds: 86400,
   authAdminRateLimit: 1000,
}
const suffix = randomUUID().slice(0, 8)
const text = (value) => ({ blocks: [{ type: 'text', text: value }] })
const minute = 60000
const later = (minutes) => new Date(Date.now() + minutes * minute)
const at = (minutes) => ({ clock: () => later(minutes) })
const rejects = (promise, code) => assert.rejects(promise, { code })

test('M11 gaps integration', async (t) => {
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
      code: `gap-${suffix}`,
      primaryLanguage: 'en',
      translations: { en: { title: 'Gaps' } },
   })
   const bank = await createQuestionBankService(adminId, {
      code: `gap-bank-${suffix}`, title: 'Gaps', subjectId: subject.id, visibility: 'staff',
   })
   const created = await createQuestionService(adminId, bank.id, {
      questionType: 'single_choice',
      languageCode: 'en',
      content: text('Pick A'),
      options: [{ key: 'A', content: text('Right') }, { key: 'B', content: text('Wrong') }],
   })
   await replaceAnswerKeyService(adminId, created.id, {
      answerData: { optionKey: 'A' }, source: 'expert_review', explanation: text('Because A'),
   })
   await verifyAnswerKeyService(adminId, created.id, { source: 'expert_review' })
   await publishQuestionService(adminId, created.id)
   const questionId = created.id

   let courseIndex = 0
   async function course() {
      courseIndex += 1
      const row = await client.query(
         `INSERT INTO courses (title, subject_id, status, created_by)
          VALUES ($1, $2, 'published', $3) RETURNING id`,
         [`Gaps ${courseIndex} ${suffix}`, subject.id, adminId],
      )
      const courseId = row.rows[0].id
      const modules = await client.query(
         `INSERT INTO course_modules (course_id, title, position, status)
          VALUES ($1, 'Open', 1, 'published'), ($1, 'Locked', 2, 'published') RETURNING id`,
         [courseId],
      )
      return { courseId, moduleId: modules.rows[0].id, lockedModuleId: modules.rows[1].id }
   }

   let titleIndex = 0
   async function publishedTest(courseId, settings = {}) {
      titleIndex += 1
      const quiz = await createTestService(adminId, {
         courseId, title: `Quiz ${titleIndex} ${suffix}`, mode: 'practice', maxAttempts: null, ...settings,
      })
      // One question of 2 points, so a regrade to 1 point is 50 percent.
      await addTestQuestionsService(adminId, quiz.id, { questions: [{ questionId, points: '2' }] })
      await publishTestService(adminId, quiz.id)
      return quiz
   }

   async function lesson(courseId, moduleId, testId, title = 'Lesson') {
      const row = await createLessonService(adminId, courseId, moduleId, {
         title: `${title} ${suffix}`, lessonType: 'test', testId,
      })
      await publishLessonService(adminId, courseId, row.id)
      return row.id
   }

   async function student(courseId, moduleId) {
      const id = await createUser('student')
      await grantCourseEnrollmentService(adminId, courseId, { userId: id, expiresAt: null })
      if (moduleId) await grantModuleAccessService(adminId, courseId, id, { moduleId, expiresAt: null })
      return id
   }

   async function progressRows(userId, lessonIds) {
      const { rows } = await client.query(
         `SELECT lesson_id, status, completed_at, revision FROM lesson_progress
          WHERE user_id = $1 AND lesson_id = ANY($2::bigint[]) ORDER BY lesson_id`,
         [userId, lessonIds],
      )
      return rows
   }

   async function take(learner, assignmentId, optionKey, overrides) {
      const view = await startAttemptService(learner, assignmentId, overrides)
      if (optionKey) {
         await saveAnswerService(learner, view.attempt.id, view.questions[0].id, {
            answer: { optionKey }, revision: 1,
         }, overrides)
      }
      return view
   }

   async function sweepUntil(attemptId, overrides) {
      const worker = startAttemptSweepWorker({ intervalMs: 5, overrides })
      for (let tries = 0; tries < 200; tries += 1) {
         const { rows } = await client.query('SELECT status FROM test_attempts WHERE id = $1', [attemptId])
         if (rows[0].status !== 'in_progress') break
         await new Promise((resolve) => { setTimeout(resolve, 10) })
      }
      await worker.stop()
   }

   await t.test('without passPercent any submit completes every linked lesson, once', async () => {
      const { courseId, moduleId } = await course()
      const quiz = await publishedTest(courseId)
      const lessons = [await lesson(courseId, moduleId, quiz.id, 'First'), await lesson(courseId, moduleId, quiz.id, 'Second')]
      const learner = await student(courseId, moduleId)
      const other = await student(courseId, moduleId)
      const assignment = await createAssignmentService(adminId, quiz.id, { userId: learner })

      const first = await take(learner, assignment.id, 'B')
      assert.deepEqual(await progressRows(learner, lessons), [])
      const result = await submitAttemptService(learner, first.attempt.id)
      assert.equal(result.passPercent, null)
      assert.equal(result.passed, null)
      const done = await progressRows(learner, lessons)
      assert.equal(done.length, 2)
      assert.ok(done.every((row) => row.status === 'completed' && row.completed_at && row.revision === '1'))

      // A repeated submit and a worse retake change nothing.
      await submitAttemptService(learner, first.attempt.id)
      const retake = await take(learner, assignment.id, null)
      await submitAttemptService(learner, retake.attempt.id)
      assert.deepEqual(await progressRows(learner, lessons), done)
      // Another student is untouched.
      assert.deepEqual(await progressRows(other, lessons), [])

      // The player still sees the server write and cannot undo it.
      const lessonView = await getLearnerLessonService(learner, courseId, lessons[0])
      assert.equal(lessonView.lesson.progress.status, 'completed')
      // The player cannot complete a lesson with a test; the server write stays as it was.
      await assert.rejects(
         saveLessonProgressService(learner, courseId, lessons[0], { revision: 1, completed: true }),
         { code: 'LESSON_COMPLETES_BY_TEST' },
      )
      assert.deepEqual(await progressRows(learner, lessons), done)
   })

   await t.test('with passPercent only a passing attempt completes, and regrade follows the rule', async () => {
      const { courseId, moduleId } = await course()
      const quiz = await publishedTest(courseId, { passPercent: 60, maxAttempts: 2 })
      const lessons = [await lesson(courseId, moduleId, quiz.id)]
      const learner = await student(courseId, moduleId)
      const assignment = await createAssignmentService(adminId, quiz.id, { userId: learner })

      const failed = await take(learner, assignment.id, 'B')
      const result = await submitAttemptService(learner, failed.attempt.id)
      assert.equal(result.percent, 0)
      assert.equal(result.passPercent, 60)
      assert.equal(result.passed, false)
      assert.deepEqual(await progressRows(learner, lessons), [])

      // Exhausted attempts without a pass leave the lesson open.
      const second = await take(learner, assignment.id, 'B')
      await submitAttemptService(learner, second.attempt.id)
      await rejects(startAttemptService(learner, assignment.id), 'ATTEMPTS_EXHAUSTED')
      assert.deepEqual(await progressRows(learner, lessons), [])

      // Staff see the same snapshot threshold.
      const listed = await listTestAttemptsService(adminId, quiz.id)
      assert.ok(listed.attempts.every((item) => item.passPercent === 60))
      const detail = await getTestAttemptService(adminId, quiz.id, failed.attempt.id)
      assert.equal(detail.attempt.passPercent, 60)
      assert.ok(!/answerData|grading_snapshot|Because/.test(JSON.stringify(detail)))

      const regrade = (points, key) => regradeAttemptService(adminId, quiz.id, failed.attempt.id, {
         reason: 'Review', idempotencyKey: `${key}-${suffix}`,
         overrides: [{ attemptQuestionId: failed.questions[0].id, points }],
      })
      await regrade('1.00', 'below')
      assert.deepEqual(await progressRows(learner, lessons), [], '50 percent is below 60')
      await regrade('2.00', 'up')
      const passed = await progressRows(learner, lessons)
      assert.equal(passed.length, 1)
      assert.equal(passed[0].status, 'completed')
      await regrade('0.00', 'down')
      assert.deepEqual(await progressRows(learner, lessons), passed, 'regrade down does not undo')
      assert.equal((await getAttemptResultService(learner, failed.attempt.id)).passed, false)
   })

   await t.test('a timer close without answers completes nothing; the worker is idempotent', async () => {
      const { courseId, moduleId } = await course()
      const quiz = await publishedTest(courseId, { timeLimitMinutes: 10 })
      const lessons = [await lesson(courseId, moduleId, quiz.id)]
      const silent = await student(courseId, moduleId)
      const answered = await student(courseId, moduleId)
      const silentView = await take(silent, (await createAssignmentService(adminId, quiz.id, { userId: silent })).id, null)
      const answeredView = await take(answered, (await createAssignmentService(adminId, quiz.id, { userId: answered })).id, 'B')

      await sweepUntil(silentView.attempt.id, at(11))
      await sweepUntil(answeredView.attempt.id, at(11))
      assert.equal((await getAttemptResultService(silent, silentView.attempt.id)).attempt.status, 'expired')
      assert.deepEqual(await progressRows(silent, lessons), [])
      const done = await progressRows(answered, lessons)
      assert.equal(done.length, 1, 'an expired attempt with an answer completes when passPercent is null')

      // Retries find nothing to do and leave completed_at alone.
      assert.equal(await finalizeNextExpiredAttemptService({ userId: answered }, at(12)), false)
      await sweepUntil(answeredView.attempt.id, at(13))
      assert.deepEqual(await progressRows(answered, lessons), done)
      const audits = await client.query(
         `SELECT count(*)::integer AS total FROM audit_events
          WHERE event_code = 'test.attempt_expired' AND subject_user_id = $1`,
         [answered],
      )
      assert.equal(audits.rows[0].total, 1)
   })

   await t.test('a revoked assignment keeps history for its owner only and never restarts', async () => {
      const { courseId, moduleId } = await course()
      const quiz = await publishedTest(courseId, { answerRevealPolicy: 'after_submission', maxAttempts: 2 })
      const lessonId = await lesson(courseId, moduleId, quiz.id)
      const learner = await student(courseId, moduleId)
      const stranger = await student(courseId, moduleId)
      const assignment = await createAssignmentService(adminId, quiz.id, { userId: learner })
      const unusedQuiz = await publishedTest(courseId)
      const unused = await createAssignmentService(adminId, unusedQuiz.id, { userId: learner })
      const view = await take(learner, assignment.id, 'A')
      await submitAttemptService(learner, view.attempt.id)

      await revokeAssignmentService(adminId, quiz.id, assignment.id)
      await revokeAssignmentService(adminId, unusedQuiz.id, unused.id)
      await rejects(startAttemptService(learner, assignment.id), 'ASSIGNMENT_NOT_FOUND')

      const { assignments } = await listMyAssignmentsService(learner, courseId)
      assert.deepEqual(assignments.map((item) => [item.id, item.state]), [[assignment.id, 'revoked']])
      assert.equal(assignments[0].attempts.status, 'submitted')

      const summary = await getAssignmentResultService(learner, assignment.id)
      assert.equal(summary.state, 'revoked')
      assert.equal(summary.attempts.length, 1)
      const result = await getAttemptResultService(learner, view.attempt.id)
      // One attempt is left by policy, so the keys stay hidden even though no start is possible.
      assert.equal(result.revealed, false)
      assert.deepEqual(result.questions, [])
      assert.ok(!/correctAnswer|explanation|Because/.test(JSON.stringify(result)))

      const lessonTest = (await getLearnerLessonService(learner, courseId, lessonId)).lesson.test
      assert.equal(lessonTest.assignment.state, 'revoked')
      assert.equal(lessonTest.attempts.status, 'submitted')

      await rejects(getAssignmentResultService(stranger, assignment.id), 'ASSIGNMENT_NOT_FOUND')
      await rejects(getAttemptResultService(stranger, view.attempt.id), 'ATTEMPT_NOT_FOUND')
      assert.deepEqual((await listMyAssignmentsService(stranger, courseId)).assignments, [])
      await rejects(getAssignmentResultService(learner, unused.id), 'ASSIGNMENT_NOT_FOUND')
   })

   await t.test('lesson lists carry testId and courses report progress over accessible lessons', async () => {
      const { courseId, moduleId, lockedModuleId } = await course()
      const quiz = await publishedTest(courseId)
      const lockedQuiz = await publishedTest(courseId)
      const testLesson = await lesson(courseId, moduleId, quiz.id, 'Open test')
      const plain = await createLessonService(adminId, courseId, moduleId, { title: `Text ${suffix}`, lessonType: 'text' })
      await publishLessonService(adminId, courseId, plain.id)
      await createLessonService(adminId, courseId, moduleId, { title: `Draft ${suffix}`, lessonType: 'text' })
      await lesson(courseId, lockedModuleId, lockedQuiz.id, 'Locked test')
      const learner = await student(courseId, moduleId)

      const open = await listLearnerLessonsService(learner, courseId, moduleId)
      assert.deepEqual(open.lessons.map((item) => item.testId), [quiz.id, null])
      const locked = await listLearnerLessonsService(learner, courseId, lockedModuleId)
      assert.deepEqual(locked.lessons.map((item) => [item.access.granted, item.testId]), [[false, null]])
      const modules = await listLearnerCourseModulesService(learner, courseId)
      assert.ok(modules.modules.every((item) => !('lessons' in item) && !('lessonCount' in item)))

      const progress = async () => (await listLearnerCourseModulesService(learner, courseId)).course.progress
      assert.deepEqual(await progress(), { completedLessons: 0, totalLessons: 2, percent: 0 })
      const assignment = await createAssignmentService(adminId, quiz.id, { userId: learner })
      await submitAttemptService(learner, (await take(learner, assignment.id, 'A')).attempt.id)
      assert.deepEqual(await progress(), { completedLessons: 1, totalLessons: 2, percent: 50 })
      const card = (await listLearnerCoursesService(learner)).courses.find((item) => item.id === courseId)
      assert.deepEqual(card.progress, { completedLessons: 1, totalLessons: 2, percent: 50 })

      // Granting the locked module adds its lesson to the total.
      await grantModuleAccessService(adminId, courseId, learner, { moduleId: lockedModuleId, expiresAt: null })
      assert.deepEqual(await progress(), { completedLessons: 1, totalLessons: 3, percent: 33 })
      const other = await student(courseId, moduleId)
      assert.deepEqual((await listLearnerCourseModulesService(other, courseId)).course.progress, {
         completedLessons: 0, totalLessons: 2, percent: 0,
      })
   })

   await t.test('the HTTP responses carry the new fields', async () => {
      const app = createApp({
         telegramAuth: { config },
         passwordAuth: { config },
         authProtection: { config },
         authorization: {},
      })
      const server = await new Promise((resolve) => {
         const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
      })
      t.after(() => new Promise((resolve) => { server.close(resolve) }))
      const { port } = server.address()
      const session = (userId) => withTransaction((transactionClient) => issueSessionService({
         userId,
         requestContext: { userAgent: 'M11 gaps integration', ipAddress: '127.0.0.1' },
         client: transactionClient,
      }, { config }))
      async function api(method, path, actor) {
         const headers = { 'content-type': 'application/json' }
         if (actor) headers.authorization = `Bearer ${actor.accessToken}`
         const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, { method, headers })
         return { status: response.status, body: await response.json() }
      }

      const { courseId, moduleId } = await course()
      const quiz = await publishedTest(courseId, { passPercent: 50 })
      await lesson(courseId, moduleId, quiz.id)
      const learner = await student(courseId, moduleId)
      const stranger = await student(courseId, moduleId)
      const assignment = await createAssignmentService(adminId, quiz.id, { userId: learner })
      const view = await take(learner, assignment.id, 'A')
      const actor = await session(learner)
      const other = await session(stranger)

      const submitted = await api('POST', `/tests/attempts/${view.attempt.id}/submit`, actor)
      assert.equal(submitted.status, 200)
      assert.equal(submitted.body.data.passPercent, 50)
      assert.equal(submitted.body.data.passed, true)

      const courses = await api('GET', '/courses', actor)
      const card = courses.body.data.courses.find((item) => item.id === courseId)
      assert.deepEqual(card.progress, { completedLessons: 1, totalLessons: 1, percent: 100 })
      const modules = await api('GET', `/courses/${courseId}/modules`, actor)
      assert.deepEqual(modules.body.data.course.progress, { completedLessons: 1, totalLessons: 1, percent: 100 })
      const lessons = await api('GET', `/courses/${courseId}/modules/${moduleId}/lessons`, actor)
      assert.equal(lessons.body.data.lessons[0].testId, quiz.id)

      await revokeAssignmentService(adminId, quiz.id, assignment.id)
      const history = await api('GET', `/tests/assignments/${assignment.id}/result`, actor)
      assert.equal(history.status, 200)
      assert.equal(history.body.data.state, 'revoked')
      assert.equal((await api('GET', `/tests/assignments/${assignment.id}/result`, other)).status, 404)
      assert.equal((await api('GET', `/tests/attempts/${view.attempt.id}/result`, other)).status, 404)
      assert.equal((await api('POST', `/tests/assignments/${assignment.id}/start`, actor)).status, 404)

      const admin = await session(adminId)
      const staff = await api('GET', `/admin/tests/${quiz.id}/attempts`, admin)
      assert.equal(staff.body.data.attempts[0].passPercent, 50)
   })
})
