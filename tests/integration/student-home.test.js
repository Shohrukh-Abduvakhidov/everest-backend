import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import pg from 'pg'

import env from '../../src/configs/env.js'
import * as learningActivity from '../../src/repositories/learning-activity-repository.js'
import {
   grantCourseEnrollmentService,
   grantModuleAccessService,
   revokeCourseEnrollmentService,
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
import { getStudentHomeService, listStudentAttemptsService } from '../../src/services/student-home-service.js'
import { createSubjectService } from '../../src/services/taxonomy-service.js'
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
const rejects = (promise, code) => assert.rejects(promise, { code })
const noThrottle = { progressMinIntervalSeconds: 0 }

test('student home, attempt history and learning activity events', async (t) => {
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
      code: `sh-${suffix}`, primaryLanguage: 'en', translations: { en: { title: 'Home' } },
   })
   const bank = await createQuestionBankService(adminId, {
      code: `sh-bank-${suffix}`, title: 'Home', subjectId: subject.id, visibility: 'staff',
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
   const courseId = (await client.query(
      `INSERT INTO courses (title, subject_id, status, created_by) VALUES ($1, $2, 'published', $3) RETURNING id`,
      [`Home ${suffix}`, subject.id, adminId],
   )).rows[0].id
   const moduleId = (await client.query(
      `INSERT INTO course_modules (course_id, title, position, status) VALUES ($1, 'M', 1, 'published') RETURNING id`,
      [courseId],
   )).rows[0].id
   const videoId = (await client.query(
      `INSERT INTO assets (storage_key, mime_type, size_bytes, duration_seconds, status, kind, processing_status)
       VALUES ($1, 'video/mp4', 1000, 100, 'ready', 'video', 'not_required') RETURNING id`,
      [`home-${suffix}`],
   )).rows[0].id

   let index = 0
   async function lesson({ testId = null, video = false } = {}) {
      index += 1
      const created = await createLessonService(adminId, courseId, moduleId, {
         title: `Lesson ${index} ${suffix}`,
         lessonType: testId ? 'test' : video ? 'video' : 'text',
         ...(testId ? { testId } : {}),
      })
      if (video) await client.query('UPDATE lessons SET video_asset_id = $2 WHERE id = $1', [created.id, videoId])
      await publishLessonService(adminId, courseId, created.id)
      return created.id
   }

   async function quiz(settings = {}) {
      index += 1
      const created = await createTestService(adminId, {
         courseId, title: `Quiz ${index} ${suffix}`, mode: 'practice', maxAttempts: 2, ...settings,
      })
      await addTestQuestionsService(adminId, created.id, { questions: [{ questionId: question.id, points: '2' }] })
      await publishTestService(adminId, created.id)
      return created
   }

   async function student() {
      const id = await createUser('student')
      await grantCourseEnrollmentService(adminId, courseId, { userId: id, expiresAt: null })
      await grantModuleAccessService(adminId, courseId, id, { moduleId, expiresAt: null })
      return id
   }

   const events = async (userId, code) => (await client.query(
      'SELECT source_event_key, metadata FROM learning_activity_events WHERE user_id = $1 AND event_code = $2 ORDER BY id',
      [userId, code],
   )).rows

   const videoLesson = await lesson({ video: true })
   const textLesson = await lesson()

   await t.test('player reports write one watch row per hour and one completion event', async () => {
      const learner = await student()
      await saveLessonProgressService(learner, courseId, videoLesson, {
         revision: 0, playbackSeconds: 30, watchedRanges: [[0, 30]],
      }, noThrottle)
      // The same seconds again add nothing; new seconds add only the growth.
      await saveLessonProgressService(learner, courseId, videoLesson, {
         revision: 1, playbackSeconds: 30, watchedRanges: [[10, 30]],
      }, noThrottle)
      await saveLessonProgressService(learner, courseId, videoLesson, {
         revision: 2, playbackSeconds: 50, watchedRanges: [[30, 50]],
      }, noThrottle)
      const watch = await events(learner, 'watch_hour')
      assert.equal(watch.length, 1, 'one row for the hour')
      assert.equal(watch[0].metadata.seconds, 50)
      assert.match(watch[0].source_event_key, new RegExp(`^watch:${videoLesson}:\\d{4}-\\d{2}-\\d{2}T\\d{2}$`))
      assert.equal((await events(learner, 'lesson_completed')).length, 0)

      // 90 percent of 100 s completes the lesson: one event, never a second one.
      await saveLessonProgressService(learner, courseId, videoLesson, {
         revision: 3, playbackSeconds: 95, watchedRanges: [[50, 95]],
      }, noThrottle)
      await saveLessonProgressService(learner, courseId, videoLesson, {
         revision: 4, playbackSeconds: 96, watchedRanges: [[95, 96]],
      }, noThrottle)
      const done = await events(learner, 'lesson_completed')
      assert.equal(done.length, 1)
      assert.equal(done[0].source_event_key, `lesson_completed:${videoLesson}`)
      assert.equal((await events(learner, 'watch_hour'))[0].metadata.seconds, 96)

      // A stale revision writes neither progress nor events.
      await rejects(saveLessonProgressService(learner, courseId, videoLesson, {
         revision: 0, playbackSeconds: 1, watchedRanges: [[0, 1]],
      }, noThrottle), 'PROGRESS_REVISION_CONFLICT')
      assert.equal((await events(learner, 'watch_hour'))[0].metadata.seconds, 96)

      // Manual completion of a lesson without video.
      await saveLessonProgressService(learner, courseId, textLesson, { revision: 0, completed: true })
      assert.equal((await events(learner, 'lesson_completed')).length, 2)
   })

   await t.test('recordActivityEvent is idempotent per source key', async () => {
      const learner = await student()
      const event = {
         userId: learner, code: 'lesson_completed', sourceEventKey: `lesson_completed:${textLesson}`,
         lessonId: textLesson, occurredAt: new Date(),
      }
      assert.equal(await learningActivity.recordActivityEvent(event, client), true)
      assert.equal(await learningActivity.recordActivityEvent(event, client), false)
      assert.equal((await events(learner, 'lesson_completed')).length, 1)
   })

   await t.test('home: continue lesson, courses, open and upcoming tests', async () => {
      const learner = await student()
      const withTest = await quiz({ passPercent: 50 })
      const later = await quiz()
      const opensAt = new Date(Date.now() + 3 * 86400000)
      const closesAt = new Date(Date.now() + 10 * 86400000)
      await createAssignmentService(adminId, withTest.id, { userId: learner, closesAt: closesAt.toISOString() })
      await createAssignmentService(adminId, later.id, { userId: learner, opensAt: opensAt.toISOString() })

      let home = await getStudentHomeService(learner)
      assert.equal(home.continueLesson, null)
      assert.equal(home.courses.length, 1)
      assert.equal(home.courses[0].id, courseId)
      assert.equal(home.courses[0].lastActivityAt, null)
      assert.equal(home.tests.open.length, 1)
      assert.equal(home.tests.open[0].testId, withTest.id)
      assert.equal(home.tests.open[0].courseId, courseId)
      assert.equal(home.tests.open[0].deadlineAt, closesAt.toISOString())
      assert.equal(home.tests.open[0].attempts.remainingAttempts, 2)
      assert.equal(home.tests.upcoming.length, 1)
      assert.equal(home.tests.upcoming[0].testId, later.id)
      assert.equal(home.tests.upcoming[0].opensAt, opensAt.toISOString())
      assert.equal(home.readiness.empty, true)
      assert.equal(home.readiness.readinessPercent, null)
      assert.equal(home.readiness.lastMockExam, null)
      assert.deepEqual(home.recentResults, [])
      assert.equal(home.week.days.length, 7)
      assert.equal(home.week.totalWatchSeconds, 0)
      assert.ok(home.serverNow)

      await saveLessonProgressService(learner, courseId, videoLesson, {
         revision: 0, playbackSeconds: 40, watchedRanges: [[0, 40]],
      }, noThrottle)
      home = await getStudentHomeService(learner)
      assert.equal(home.continueLesson.lessonId, videoLesson)
      assert.equal(home.continueLesson.courseId, courseId)
      assert.equal(home.continueLesson.playbackSeconds, 40)
      assert.equal(home.continueLesson.durationSeconds, 100)
      assert.ok(home.courses[0].lastActivityAt)
      assert.equal(home.week.totalWatchSeconds, 40)
      assert.equal(home.week.days.at(-1).watchSeconds, 40)

      // A running attempt keeps the test in "open" with its attempt deadline.
      const view = await startAttemptService(learner, home.tests.open[0].id)
      home = await getStudentHomeService(learner)
      assert.equal(home.tests.open[0].attempts.status, 'in_progress')
      assert.equal(home.tests.open[0].attempts.attemptId, view.attempt.id)

      // Finishing it moves the result to recentResults and records one attempt_finished event.
      await saveAnswerService(learner, view.attempt.id, view.questions[0].id, { answer: { optionKey: 'A' }, revision: 1 })
      await submitAttemptService(learner, view.attempt.id)
      await submitAttemptService(learner, view.attempt.id)
      const finished = await events(learner, 'attempt_finished')
      assert.equal(finished.length, 1)
      assert.equal(finished[0].source_event_key, `attempt_finished:${view.attempt.id}`)
      home = await getStudentHomeService(learner)
      assert.equal(home.recentResults.length, 1)
      const result = home.recentResults[0]
      assert.equal(result.attemptId, view.attempt.id)
      assert.equal(result.origin, 'authored')
      assert.equal(result.title, withTest.title)
      assert.equal(result.percent, 100)
      assert.equal(result.passPercent, 50)
      assert.equal(result.passed, true)
      assert.equal(home.week.days.at(-1).attemptsFinished, 1)
      // One attempt of two is still left, so the test stays open.
      assert.equal(home.tests.open[0].attempts.remainingAttempts, 1)
   })

   await t.test('access changes remove content from the home page', async () => {
      const learner = await student()
      const gated = await quiz()
      await createAssignmentService(adminId, gated.id, { userId: learner })
      await saveLessonProgressService(learner, courseId, videoLesson, {
         revision: 0, playbackSeconds: 5, watchedRanges: [[0, 5]],
      }, noThrottle)
      let home = await getStudentHomeService(learner)
      assert.equal(home.tests.open.length, 1)
      assert.ok(home.continueLesson)

      // Module access revoked: the lesson and the test are gone, the enrollment stays.
      await client.query('UPDATE module_access_grants SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = $1', [learner])
      home = await getStudentHomeService(learner)
      assert.equal(home.continueLesson, null)
      assert.equal(home.courses.length, 1)

      await revokeCourseEnrollmentService(adminId, courseId, learner)
      home = await getStudentHomeService(learner)
      assert.equal(home.courses.length, 0)
      assert.equal(home.tests.open.length, 0)
      assert.equal(home.tests.upcoming.length, 0)

      // A closed assignment window is not listed either.
      const other = await student()
      const expired = await quiz()
      await createAssignmentService(adminId, expired.id, { userId: other })
      await client.query(
         `UPDATE test_assignments SET opens_at = CURRENT_TIMESTAMP - interval '2 days',
             closes_at = CURRENT_TIMESTAMP - interval '1 day' WHERE test_id = $1`,
         [expired.id],
      )
      assert.equal((await getStudentHomeService(other)).tests.open.length, 0)
   })

   await t.test('blocked and unknown accounts are refused', async () => {
      const blocked = await createUser('student', 'blocked')
      await rejects(getStudentHomeService(blocked), 'ACCOUNT_NOT_ACTIVE')
      await rejects(listStudentAttemptsService(blocked, {}), 'ACCOUNT_NOT_ACTIVE')
      await rejects(getStudentHomeService('abc'), 'INVALID_USER_ID')
   })

   await t.test('week buckets events by the learner time zone', async () => {
      const learner = await student()
      await client.query(
         `INSERT INTO user_profiles (user_id, timezone) VALUES ($1, 'Asia/Dushanbe')
          ON CONFLICT (user_id) DO UPDATE SET timezone = 'Asia/Dushanbe'`,
         [learner],
      )
      const insert = (code, at, seconds = null) => client.query(
         `INSERT INTO learning_activity_events (user_id, event_code, source_event_key, occurred_at, metadata)
          VALUES ($1, $2, $3, $4, $5::jsonb)`,
         [learner, code, `${code}:${at}`, at, JSON.stringify(seconds === null ? {} : { seconds })],
      )
      // UTC+5: 20:00Z on 10 June is already 11 June (01:00); 18:59Z stays on 10 June.
      await insert('watch_hour', '2026-06-10T20:00:00Z', 600)
      await insert('watch_hour', '2026-06-10T18:00:00Z', 300)
      await insert('lesson_completed', '2026-06-05T05:00:00Z')
      await insert('lesson_completed', '2026-06-03T05:00:00Z')
      const home = await getStudentHomeService(learner, { clock: () => new Date('2026-06-11T10:00:00Z') })
      assert.equal(home.week.timeZone, 'Asia/Dushanbe')
      assert.deepEqual(home.week.days.map((day) => day.date), [
         '2026-06-05', '2026-06-06', '2026-06-07', '2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11',
      ])
      const byDate = new Map(home.week.days.map((day) => [day.date, day]))
      assert.equal(byDate.get('2026-06-11').watchSeconds, 600)
      assert.equal(byDate.get('2026-06-10').watchSeconds, 300)
      assert.equal(byDate.get('2026-06-05').lessonsCompleted, 1)
      assert.equal(home.week.totalWatchSeconds, 900)
      // 2026-06-03 is outside the seven days.
      assert.equal(home.week.days.reduce((sum, day) => sum + day.lessonsCompleted, 0), 1)

      // Unknown zone names fall back to UTC, where both events fall on 10 June.
      await client.query("UPDATE user_profiles SET timezone = 'Nowhere/Zone' WHERE user_id = $1", [learner])
      const fallback = await getStudentHomeService(learner, { clock: () => new Date('2026-06-11T10:00:00Z') })
      assert.equal(fallback.week.timeZone, 'UTC')
      assert.equal(new Map(fallback.week.days.map((day) => [day.date, day])).get('2026-06-10').watchSeconds, 900)
   })

   await t.test('attempt history: origins, filters, paging and privacy', async () => {
      const learner = await student()
      const other = await student()
      const first = await quiz({ passPercent: 100 })
      const assignment = await createAssignmentService(adminId, first.id, { userId: learner })
      const wrong = await startAttemptService(learner, assignment.id)
      await saveAnswerService(learner, wrong.attempt.id, wrong.questions[0].id, { answer: { optionKey: 'B' }, revision: 1 })
      await submitAttemptService(learner, wrong.attempt.id)
      const right = await startAttemptService(learner, assignment.id)
      await saveAnswerService(learner, right.attempt.id, right.questions[0].id, { answer: { optionKey: 'A' }, revision: 1 })
      await submitAttemptService(learner, right.attempt.id)
      // Running attempts are not history.
      const running = await quiz()
      const runningAssignment = await createAssignmentService(adminId, running.id, { userId: learner })
      await startAttemptService(learner, runningAssignment.id)

      const all = await listStudentAttemptsService(learner, {})
      assert.deepEqual(all.pagination, { limit: 20, offset: 0, total: 2, hasMore: false })
      assert.deepEqual(all.attempts.map((item) => item.attemptId), [right.attempt.id, wrong.attempt.id])
      assert.deepEqual(all.attempts.map((item) => item.passed), [true, false])
      assert.equal(all.attempts[1].percent, 0)
      assert.equal(all.attempts[0].attemptNumber, 2)
      assert.equal(all.attempts[0].subjectId, subject.id)
      assert.equal(all.attempts[0].assignmentId, assignment.id)
      const keys = Object.keys(all.attempts[0])
      for (const secret of ['answers', 'questions', 'policy_snapshot', 'gradingSnapshot', 'userId']) {
         assert.equal(keys.includes(secret), false, secret)
      }

      const page = await listStudentAttemptsService(learner, { limit: '1', offset: '1' })
      assert.deepEqual(page.pagination, { limit: 1, offset: 1, total: 2, hasMore: false })
      assert.equal(page.attempts[0].attemptId, wrong.attempt.id)
      const firstPage = await listStudentAttemptsService(learner, { limit: '1' })
      assert.equal(firstPage.pagination.hasMore, true)

      assert.equal((await listStudentAttemptsService(learner, { origin: 'authored' })).pagination.total, 2)
      assert.equal((await listStudentAttemptsService(learner, { origin: 'trainer' })).pagination.total, 0)
      assert.equal((await listStudentAttemptsService(learner, { origin: 'mock_exam' })).pagination.total, 0)
      assert.equal((await listStudentAttemptsService(learner, { subjectId: subject.id })).pagination.total, 2)
      assert.equal((await listStudentAttemptsService(learner, { subjectId: '999999999' })).pagination.total, 0)
      // Another student never sees these attempts.
      assert.equal((await listStudentAttemptsService(other, {})).pagination.total, 0)

      for (const query of [
         { origin: 'bonus' }, { subjectId: 'x' }, { limit: '0' }, { limit: '101' }, { offset: '-1' }, { limit: 'a' },
      ]) await rejects(listStudentAttemptsService(learner, query), 'VALIDATION_ERROR')
   })

   await t.test('the migration backfill restores earlier events once', async () => {
      const learner = await student()
      const gated = await quiz()
      const assignment = await createAssignmentService(adminId, gated.id, { userId: learner })
      const view = await startAttemptService(learner, assignment.id)
      await saveAnswerService(learner, view.attempt.id, view.questions[0].id, { answer: { optionKey: 'A' }, revision: 1 })
      await submitAttemptService(learner, view.attempt.id)
      await saveLessonProgressService(learner, courseId, textLesson, { revision: 0, completed: true })
      const before = (await client.query(
         'SELECT event_code, source_event_key FROM learning_activity_events WHERE user_id = $1 ORDER BY source_event_key',
         [learner],
      )).rows
      assert.equal(before.length, 2)

      // Rows that existed before this release have no events: run the migration's own backfill.
      await client.query('DELETE FROM learning_activity_events WHERE user_id = $1', [learner])
      const migration = await import('../../src/migrations/20261116010000000_add-student-progress-reads.js')
      let sql = ''
      migration.up({ sql: (value) => { sql += value } })
      const backfill = sql.split(';').map((statement) => statement.trim())
         .filter((statement) => statement.startsWith('INSERT INTO learning_activity_events'))
      assert.equal(backfill.length, 2)
      for (const run of [1, 2]) {
         for (const statement of backfill) await client.query(statement)
         const after = (await client.query(
            'SELECT event_code, source_event_key FROM learning_activity_events WHERE user_id = $1 ORDER BY source_event_key',
            [learner],
         )).rows
         assert.deepEqual(after, before, `run ${run} gives the same keys the application writes`)
      }
   })

   await t.test('readiness lists every trainable subject; subjects without trainings have null', async () => {
      async function trainableSubject(code, title, { published = true, nctBank = true } = {}) {
         const created = await createSubjectService(adminId, {
            code: `ra-${code}-${suffix}`, primaryLanguage: 'en', translations: { en: { title } },
         })
         const bankRow = await createQuestionBankService(adminId, {
            code: `${nctBank ? 'nct' : 'plain'}-ra-${code}-${suffix}`, title, subjectId: created.id, visibility: 'staff',
         })
         const made = await createQuestionService(adminId, bankRow.id, {
            questionType: 'single_choice', languageCode: 'en', content: text(`Q ${code}`),
            options: [{ key: 'A', content: text('Right') }, { key: 'B', content: text('Wrong') }],
         })
         if (published) {
            await replaceAnswerKeyService(adminId, made.id, { answerData: { optionKey: 'A' }, source: 'expert_review' })
            await verifyAnswerKeyService(adminId, made.id, { source: 'expert_review' })
            await publishQuestionService(adminId, made.id)
         }
         return created.id
      }
      // Titles sort Alpha before Zeta although Zeta is created first.
      const zeta = await trainableSubject('zeta', 'Zeta')
      const alpha = await trainableSubject('alpha', 'Alpha')
      const draftOnly = await trainableSubject('draft', 'Draft only', { published: false })
      const noNctBank = await trainableSubject('plain', 'Plain bank', { nctBank: false })
      const mine = new Set([zeta, alpha, draftOnly, noNctBank])
      const listed = (home) => home.readiness.subjects.filter((entry) => mine.has(entry.subjectId))

      const fresh = await student()
      const home = await getStudentHomeService(fresh)
      assert.deepEqual(listed(home).map((entry) => entry.subjectId), [alpha, zeta], 'only trainable subjects, ordered by title')
      assert.ok(home.readiness.subjects.every((entry) => entry.readinessPercent === null), 'nothing trained yet')
      const entry = listed(home)[0]
      assert.deepEqual(Object.keys(entry).sort(), [
         'color', 'lastSubmittedAt', 'readinessPercent', 'subjectCode', 'subjectId', 'titles', 'trainings',
      ])
      assert.equal(entry.titles.en, 'Alpha')
      assert.equal(entry.trainings, 0)
      assert.equal(entry.lastSubmittedAt, null)
      assert.equal(home.readiness.empty, true)
      assert.equal(home.readiness.readinessPercent, null)

      // One finished training on Zeta: 75% there, null elsewhere, and the mean ignores the others.
      const trained = await student()
      const trainerTest = await client.query(
         `INSERT INTO tests (title, mode, status, origin, created_by, generation_filters)
          VALUES ('Generated', 'practice', 'draft', 'trainer', $1, $2::jsonb) RETURNING id`,
         [trained, JSON.stringify({ subjectId: zeta, subjectCode: `ra-zeta-${suffix}` })],
      )
      const assignment = await client.query(
         'INSERT INTO test_assignments (test_id, user_id, assigned_by) VALUES ($1, $2, $2) RETURNING id',
         [trainerTest.rows[0].id, trained],
      )
      await client.query(
         `INSERT INTO test_attempts (test_id, assignment_id, user_id, attempt_number, status, submitted_at,
            graded_at, score, max_score, policy_snapshot)
          VALUES ($1, $2, $3, 1, 'graded', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 3, 4, '{}'::jsonb)`,
         [trainerTest.rows[0].id, assignment.rows[0].id, trained],
      )
      const after = await getStudentHomeService(trained)
      const bySubject = new Map(listed(after).map((item) => [item.subjectId, item]))
      assert.deepEqual([...bySubject.keys()], [alpha, zeta])
      assert.equal(bySubject.get(zeta).readinessPercent, 75)
      assert.equal(bySubject.get(zeta).trainings, 1)
      assert.equal(bySubject.get(alpha).readinessPercent, null)
      assert.equal(after.readiness.readinessPercent, 75, 'subjects without data stay out of the mean')
      assert.equal(after.readiness.empty, false)

      // A subject with trainings stays listed after its questions are withdrawn.
      await client.query("UPDATE questions SET status = 'archived' WHERE subject_id = $1", [zeta])
      const withdrawn = await getStudentHomeService(trained)
      assert.equal(listed(withdrawn).find((item) => item.subjectId === zeta).readinessPercent, 75)
      assert.equal(listed(await getStudentHomeService(fresh)).some((item) => item.subjectId === zeta), false)
   })

   await t.test('trainer and mock exam attempts appear with their origin and subject', async () => {
      const learner = await student()
      const trainerTest = await client.query(
         `INSERT INTO tests (title, mode, status, origin, created_by, generation_filters)
          VALUES ('Generated', 'practice', 'draft', 'trainer', $1, $2::jsonb) RETURNING id`,
         [learner, JSON.stringify({ subjectId: subject.id, subjectCode: `sh-${suffix}` })],
      )
      const assignment = await client.query(
         `INSERT INTO test_assignments (test_id, user_id, assigned_by) VALUES ($1, $2, $2) RETURNING id`,
         [trainerTest.rows[0].id, learner],
      )
      await client.query(
         `INSERT INTO test_attempts (test_id, assignment_id, user_id, attempt_number, status, submitted_at,
            graded_at, score, max_score, policy_snapshot)
          VALUES ($1, $2, $3, 1, 'graded', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 3, 4, '{}'::jsonb)`,
         [trainerTest.rows[0].id, assignment.rows[0].id, learner],
      )
      const history = await listStudentAttemptsService(learner, {})
      assert.equal(history.attempts.length, 1)
      assert.equal(history.attempts[0].origin, 'trainer')
      assert.equal(history.attempts[0].title, null, 'generated titles are built by the client')
      assert.equal(history.attempts[0].assignmentId, null)
      assert.equal(history.attempts[0].subjectId, subject.id)
      assert.equal(history.attempts[0].percent, 75)
      assert.equal(history.attempts[0].passed, null)
      assert.equal((await listStudentAttemptsService(learner, { origin: 'trainer', subjectId: subject.id })).pagination.total, 1)
      assert.equal((await listStudentAttemptsService(learner, { origin: 'authored' })).pagination.total, 0)
      const home = await getStudentHomeService(learner)
      assert.equal(home.recentResults[0].origin, 'trainer')
      assert.equal(home.readiness.empty, false, 'a finished training counts for readiness')
      assert.equal(home.readiness.readinessPercent, 75)
      assert.equal(home.tests.open.length, 0, 'generated tests are never listed as course tests')
   })
})
