import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import pg from 'pg'

import env from '../../src/configs/env.js'
import {
   grantCourseEnrollmentService,
   grantModuleAccessService,
} from '../../src/services/course-access-service.js'
import { saveLessonProgressService } from '../../src/services/learner-lesson-service.js'
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
   saveAnswerService,
   startAttemptService,
   submitAttemptService,
} from '../../src/services/test-attempt-service.js'
import { getTestAttemptService, listTestAttemptsService } from '../../src/services/test-results-service.js'
import {
   addTestQuestionsService,
   createAssignmentService,
   createTestService,
   publishTestService,
} from '../../src/services/test-service.js'

const { Client } = pg
const suffix = randomUUID().slice(0, 8)
const text = (value) => ({ blocks: [{ type: 'text', text: value }] })
const rejects = (promise, code) => assert.rejects(promise, { code })

test('lesson completion guard and staff passed', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   t.after(() => client.end())

   async function createUser(role) {
      const { rows } = await client.query(
         `INSERT INTO users (status, onboarding_completed_at) VALUES ('active', CURRENT_TIMESTAMP) RETURNING id`,
      )
      await client.query(
         'INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2',
         [rows[0].id, role],
      )
      return rows[0].id
   }

   const adminId = await createUser('admin')
   const subject = await createSubjectService(adminId, {
      code: `lg-${suffix}`, primaryLanguage: 'en', translations: { en: { title: 'Guard' } },
   })
   const bank = await createQuestionBankService(adminId, {
      code: `lg-bank-${suffix}`, title: 'Guard', subjectId: subject.id, visibility: 'staff',
   })
   const question = await createQuestionService(adminId, bank.id, {
      questionType: 'single_choice',
      languageCode: 'en',
      content: text('Pick A'),
      options: [{ key: 'A', content: text('Right') }, { key: 'B', content: text('Wrong') }],
   })
   await replaceAnswerKeyService(adminId, question.id, { answerData: { optionKey: 'A' }, source: 'expert_review' })
   await verifyAnswerKeyService(adminId, question.id, { source: 'expert_review' })
   await publishQuestionService(adminId, question.id)
   const course = await client.query(
      `INSERT INTO courses (title, subject_id, status, created_by) VALUES ($1, $2, 'published', $3) RETURNING id`,
      [`Guard ${suffix}`, subject.id, adminId],
   )
   const courseId = course.rows[0].id
   const moduleRow = await client.query(
      `INSERT INTO course_modules (course_id, title, position, status) VALUES ($1, 'M', 1, 'published') RETURNING id`,
      [courseId],
   )
   const moduleId = moduleRow.rows[0].id
   // A ready video asset with a duration; the player rule needs only its duration.
   const video = await client.query(
      `INSERT INTO assets (storage_key, mime_type, size_bytes, duration_seconds, status, kind, processing_status)
       VALUES ($1, 'video/mp4', 1000, 100, 'ready', 'video', 'not_required') RETURNING id`,
      [`guard-${suffix}`],
   )
   const videoId = video.rows[0].id

   let index = 0
   async function quiz(settings = {}) {
      index += 1
      const created = await createTestService(adminId, {
         courseId, title: `Guard ${index} ${suffix}`, mode: 'practice', maxAttempts: null, ...settings,
      })
      await addTestQuestionsService(adminId, created.id, { questions: [{ questionId: question.id, points: '2' }] })
      await publishTestService(adminId, created.id)
      return created
   }

   async function lesson(testId, type, withVideo = false) {
      index += 1
      const created = await createLessonService(adminId, courseId, moduleId, {
         title: `Lesson ${index} ${suffix}`, lessonType: type, ...(testId ? { testId } : {}),
      })
      if (withVideo) await client.query('UPDATE lessons SET video_asset_id = $2 WHERE id = $1', [created.id, videoId])
      await publishLessonService(adminId, courseId, created.id)
      return created.id
   }

   async function student() {
      const id = await createUser('student')
      await grantCourseEnrollmentService(adminId, courseId, { userId: id, expiresAt: null })
      await grantModuleAccessService(adminId, courseId, id, { moduleId, expiresAt: null })
      return id
   }

   const progress = async (learner, lessonId) => (await client.query(
      'SELECT status, watched_seconds, completed_at FROM lesson_progress WHERE user_id = $1 AND lesson_id = $2',
      [learner, lessonId],
   )).rows[0]

   await t.test('a lesson with a test cannot be completed from the player', async () => {
      const linked = await quiz()
      const textLesson = await lesson(linked.id, 'test')
      const mixedVideo = await lesson(linked.id, 'mixed', true)
      const plain = await lesson(null, 'text')
      const learner = await student()

      await rejects(saveLessonProgressService(learner, courseId, textLesson, { revision: 0, completed: true }), 'LESSON_COMPLETES_BY_TEST')
      await rejects(saveLessonProgressService(learner, courseId, mixedVideo, { revision: 0, completed: true }), 'LESSON_COMPLETES_BY_TEST')
      assert.equal(await progress(learner, textLesson), undefined)

      // Watching saves, even past 90 percent, but never completes the lesson.
      const watched = await saveLessonProgressService(learner, courseId, mixedVideo, {
         revision: 0, playbackSeconds: 99, watchedSeconds: 99,
      })
      assert.equal(watched.progress.status, 'in_progress')
      assert.equal(watched.progress.watchedSeconds, 99)
      assert.equal(watched.progress.completedAt, null)

      // Lessons without a test work as before.
      const done = await saveLessonProgressService(learner, courseId, plain, { revision: 0, completed: true })
      assert.equal(done.progress.status, 'completed')

      // The test result still completes the lessons, and later watching keeps them completed.
      const assignment = await createAssignmentService(adminId, linked.id, { userId: learner })
      const view = await startAttemptService(learner, assignment.id)
      await saveAnswerService(learner, view.attempt.id, view.questions[0].id, { answer: { optionKey: 'A' }, revision: 1 })
      await submitAttemptService(learner, view.attempt.id)
      assert.equal((await progress(learner, textLesson)).status, 'completed')
      const after = await progress(learner, mixedVideo)
      assert.equal(after.status, 'completed')
      const current = await saveLessonProgressService(learner, courseId, mixedVideo, {
         revision: 2, playbackSeconds: 10, watchedSeconds: 10,
      })
      assert.equal(current.progress.status, 'completed')
      assert.equal(new Date(current.progress.completedAt).getTime(), after.completed_at.getTime())
   })

   await t.test('staff attempts report passed like the learner result', async () => {
      const withPass = await quiz({ passPercent: 50 })
      const withoutPass = await quiz()
      const answer = async (test, optionKey, finish = true) => {
         const learner = await student()
         const assignment = await createAssignmentService(adminId, test.id, { userId: learner })
         const view = await startAttemptService(learner, assignment.id)
         if (optionKey) {
            await saveAnswerService(learner, view.attempt.id, view.questions[0].id, { answer: { optionKey }, revision: 1 })
         }
         const result = finish ? await submitAttemptService(learner, view.attempt.id) : null
         return { view, result }
      }
      const passed = await answer(withPass, 'A')
      const failed = await answer(withPass, 'B')
      const running = await answer(withPass, 'A', false)
      const noThreshold = await answer(withoutPass, 'B')
      const noThresholdRunning = await answer(withoutPass, null, false)

      const staff = async (test, attemptId) => (await getTestAttemptService(adminId, test.id, attemptId)).attempt
      assert.equal((await staff(withPass, passed.view.attempt.id)).passed, true)
      assert.equal(passed.result.passed, true)
      assert.equal((await staff(withPass, failed.view.attempt.id)).passed, false)
      assert.equal(failed.result.passed, false)
      assert.equal((await staff(withPass, running.view.attempt.id)).passed, null, 'in progress')
      assert.equal((await staff(withoutPass, noThreshold.view.attempt.id)).passed, null, 'no passPercent')
      assert.equal((await staff(withoutPass, noThresholdRunning.view.attempt.id)).passed, null)
      assert.equal(noThreshold.result.passed, null)

      const listed = (await listTestAttemptsService(adminId, withPass.id)).attempts
      const byId = new Map(listed.map((item) => [item.id, item.passed]))
      assert.equal(byId.get(passed.view.attempt.id), true)
      assert.equal(byId.get(failed.view.attempt.id), false)
      assert.equal(byId.get(running.view.attempt.id), null)
   })
})
