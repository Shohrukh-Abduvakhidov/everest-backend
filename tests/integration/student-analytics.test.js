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
import { getStudentAnalyticsService } from '../../src/services/student-home-service.js'
import { createSubjectService, createTopicService } from '../../src/services/taxonomy-service.js'
import {
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
const day = 86400000

test('student analytics: totals, first attempts and topics', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   t.after(() => client.end())

   async function createUser(role, status = 'active') {
      const { rows } = await client.query(
         `INSERT INTO users (status, onboarding_completed_at, blocked_at)
          VALUES ($1::varchar, CURRENT_TIMESTAMP, CASE WHEN $1::varchar = 'blocked' THEN CURRENT_TIMESTAMP END)
          RETURNING id`,
         [status],
      )
      await client.query(
         'INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2',
         [rows[0].id, role],
      )
      return rows[0].id
   }

   const adminId = await createUser('admin')
   const subject = await createSubjectService(adminId, {
      code: `sa-${suffix}`, primaryLanguage: 'en', translations: { en: { title: 'Analytics' } },
   })
   const topics = {}
   for (const code of ['strong', 'weak', 'few']) {
      topics[code] = (await createTopicService(adminId, subject.id, {
         code, primaryLanguage: 'en', translations: { en: { title: `Topic ${code}` } },
      })).id
   }
   const bank = await createQuestionBankService(adminId, {
      code: `sa-bank-${suffix}`, title: 'Analytics', subjectId: subject.id, visibility: 'staff',
   })
   async function question(topicCode) {
      const created = await createQuestionService(adminId, bank.id, {
         questionType: 'single_choice',
         languageCode: 'en',
         content: text(`Pick A ${topicCode ?? 'none'}`),
         options: [{ key: 'A', content: text('Right') }, { key: 'B', content: text('Wrong') }],
         ...(topicCode ? { topicIds: [topics[topicCode]] } : {}),
      })
      await replaceAnswerKeyService(adminId, created.id, { answerData: { optionKey: 'A' }, source: 'expert_review' })
      await verifyAnswerKeyService(adminId, created.id, { source: 'expert_review' })
      await publishQuestionService(adminId, created.id)
      return created.id
   }
   // 5 + 5 + 2 questions with topics; one more without a topic.
   const byTopic = { strong: [], weak: [], few: [] }
   for (const [code, count] of [['strong', 5], ['weak', 5], ['few', 2]]) {
      for (let index = 0; index < count; index += 1) byTopic[code].push(await question(code))
   }
   const untagged = await question(null)

   const courseId = (await client.query(
      `INSERT INTO courses (title, subject_id, status, created_by) VALUES ($1, $2, 'published', $3) RETURNING id`,
      [`Analytics ${suffix}`, subject.id, adminId],
   )).rows[0].id
   const moduleId = (await client.query(
      `INSERT INTO course_modules (course_id, title, position, status) VALUES ($1, 'M', 1, 'published') RETURNING id`,
      [courseId],
   )).rows[0].id
   const videoId = (await client.query(
      `INSERT INTO assets (storage_key, mime_type, size_bytes, duration_seconds, status, kind, processing_status)
       VALUES ($1, 'video/mp4', 1000, 100, 'ready', 'video', 'not_required') RETURNING id`,
      [`analytics-${suffix}`],
   )).rows[0].id
   const video = await createLessonService(adminId, courseId, moduleId, { title: `Video ${suffix}`, lessonType: 'video' })
   await client.query('UPDATE lessons SET video_asset_id = $2 WHERE id = $1', [video.id, videoId])
   await publishLessonService(adminId, courseId, video.id)
   const reading = await createLessonService(adminId, courseId, moduleId, { title: `Text ${suffix}`, lessonType: 'text' })
   await publishLessonService(adminId, courseId, reading.id)

   async function quiz(questionIds, settings = {}) {
      const created = await createTestService(adminId, {
         courseId, title: `Quiz ${randomUUID().slice(0, 6)}`, mode: 'practice', maxAttempts: 2, ...settings,
      })
      await addTestQuestionsService(adminId, created.id, {
         questions: questionIds.map((questionId) => ({ questionId, points: '1' })),
      })
      await publishTestService(adminId, created.id)
      return created
   }

   async function student() {
      const id = await createUser('student')
      await grantCourseEnrollmentService(adminId, courseId, { userId: id, expiresAt: null })
      await grantModuleAccessService(adminId, courseId, id, { moduleId, expiresAt: null })
      return id
   }

   // Answers by question id: 'A' right, 'B' wrong, missing = unanswered.
   async function run(learner, assignmentId, answers) {
      const view = await startAttemptService(learner, assignmentId)
      // The learner view hides question ids; map attempt questions back for the test only.
      const map = new Map((await client.query(
         'SELECT id, question_id FROM attempt_questions WHERE attempt_id = $1', [view.attempt.id],
      )).rows.map((row) => [row.id, row.question_id]))
      for (const item of view.questions) {
         const optionKey = answers.get(map.get(item.id))
         if (!optionKey) continue
         await saveAnswerService(learner, view.attempt.id, item.id, { answer: { optionKey }, revision: 1 })
      }
      await submitAttemptService(learner, view.attempt.id)
      return view.attempt.id
   }

   const mainQuestions = [...byTopic.strong, ...byTopic.weak, ...byTopic.few]
   const learner = await student()
   const main = await quiz(mainQuestions, { passPercent: 50 })
   const mainAssignment = await createAssignmentService(adminId, main.id, { userId: learner })
   // First attempt: strong 5/5, weak 1 right + 1 wrong + 3 unanswered, few 0/2 → 6/12 = 50%.
   const first = await run(learner, mainAssignment.id, new Map([
      ...byTopic.strong.map((id) => [id, 'A']),
      [byTopic.weak[0], 'A'], [byTopic.weak[1], 'B'],
      ...byTopic.few.map((id) => [id, 'B']),
   ]))
   // Second attempt: strong 5/5 only.
   await run(learner, mainAssignment.id, new Map(byTopic.strong.map((id) => [id, 'A'])))
   const other = await quiz([untagged])
   const otherAssignment = await createAssignmentService(adminId, other.id, { userId: learner })
   await run(learner, otherAssignment.id, new Map([[untagged, 'B']]))

   await saveLessonProgressService(learner, courseId, video.id, {
      revision: 0, playbackSeconds: 30, watchedRanges: [[0, 30]],
   }, { progressMinIntervalSeconds: 0 })
   await saveLessonProgressService(learner, courseId, video.id, {
      revision: 1, playbackSeconds: 60, watchedRanges: [[10, 30], [50, 60]],
   }, { progressMinIntervalSeconds: 0 })
   await saveLessonProgressService(learner, courseId, reading.id, { revision: 0, completed: true })

   await t.test('totals, first attempts and topic lists', async () => {
      const analytics = await getStudentAnalyticsService(learner)
      assert.equal(analytics.windowDays, 90)
      assert.deepEqual(analytics.totals, { watchSeconds: 40, lessonsCompleted: 1, attemptsFinished: 3 })
      // 50% (threshold 50, passed) and 0% (no threshold); the second attempt is not a first attempt.
      assert.deepEqual(analytics.firstAttempt, {
         count: 2, averagePercent: 25, withPassPercent: 1, passed: 1, passRate: 100,
      })
      assert.equal(analytics.topics.minQuestions, 5)
      assert.equal(analytics.topics.weakBelowPercent, 60)
      assert.equal(analytics.topics.strongFromPercent, 85)
      assert.deepEqual(analytics.topics.strong.map((item) => [item.topicId, item.questions, item.points, item.percent]), [
         [topics.strong, 10, '10.00', 100],
      ])
      // weak: 1 point of 10 (unanswered questions earn 0); few: 4 questions, below the minimum.
      assert.deepEqual(analytics.topics.weak.map((item) => [item.topicId, item.questions, item.points, item.maxPoints, item.percent]), [
         [topics.weak, 10, '1.00', '10.00', 10],
      ])
      assert.equal(analytics.topics.weak[0].subjectId, subject.id)
      assert.equal(analytics.topics.weak[0].titles.en, 'Topic weak')
      assert.equal(analytics.topics.weak[0].topicCode, 'weak')
   })

   await t.test('the 90-day window includes its first instant and drops older attempts', async () => {
      const now = new Date()
      const clock = () => now
      await client.query('UPDATE test_attempts SET submitted_at = $2 WHERE id = $1', [first, new Date(now.getTime() - 90 * day)])
      let analytics = await getStudentAnalyticsService(learner, { clock })
      assert.equal(analytics.since, new Date(now.getTime() - 90 * day).toISOString())
      assert.equal(analytics.topics.weak[0].questions, 10, 'exactly 90 days ago still counts')

      await client.query('UPDATE test_attempts SET submitted_at = $2 WHERE id = $1', [first, new Date(now.getTime() - 90 * day - 1000)])
      analytics = await getStudentAnalyticsService(learner, { clock })
      // Only the second attempt is left: strong 5/5; weak 0/5 (all unanswered); few 0/2 stays out.
      assert.deepEqual(analytics.topics.strong.map((item) => [item.topicId, item.questions]), [[topics.strong, 5]])
      assert.deepEqual(analytics.topics.weak.map((item) => [item.topicId, item.questions, item.percent]), [[topics.weak, 5, 0]])
      // Totals and first attempts are all-time.
      assert.equal(analytics.totals.attemptsFinished, 3)
      assert.equal(analytics.firstAttempt.count, 2)
   })

   await t.test('another student and empty or blocked accounts', async () => {
      const fresh = await student()
      const empty = await getStudentAnalyticsService(fresh)
      assert.deepEqual(empty.totals, { watchSeconds: 0, lessonsCompleted: 0, attemptsFinished: 0 })
      assert.deepEqual(empty.firstAttempt, { count: 0, averagePercent: null, withPassPercent: 0, passed: 0, passRate: null })
      assert.deepEqual(empty.topics.strong, [])
      assert.deepEqual(empty.topics.weak, [])
      const blocked = await createUser('student', 'blocked')
      await assert.rejects(getStudentAnalyticsService(blocked), { code: 'ACCOUNT_NOT_ACTIVE' })
   })
})
