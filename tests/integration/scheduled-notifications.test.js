import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import pg from 'pg'

import env from '../../src/configs/env.js'
import { runNextJob } from '../../src/jobs/job-worker.js'
import { TelegramRateLimiter } from '../../src/jobs/telegram-rate-limiter.js'
import * as jobRepository from '../../src/repositories/job-repository.js'
import { withTransaction } from '../../src/repositories/transaction-repository.js'
import { grantCourseEnrollmentService } from '../../src/services/course-access-service.js'
import {
   createNotificationJobHandlers,
   enqueueAssignmentCloseEvents,
   runNotificationFanoutService,
   runNotificationRetentionService,
   scheduleNotificationRetentionService,
} from '../../src/services/notification-service.js'
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
   saveAnswerService,
   startAttemptService,
   submitAttemptService,
} from '../../src/services/test-attempt-service.js'
import { sendTelegramBatchService } from '../../src/services/telegram-delivery-service.js'
import { grantExtraAttemptsService, regradeAttemptService } from '../../src/services/test-results-service.js'
import {
   addTestQuestionsService,
   createAssignmentService,
   createTestService,
   publishTestService,
   revokeAssignmentService,
   updateAssignmentService,
} from '../../src/services/test-service.js'

const { Client } = pg
const suffix = randomUUID().slice(0, 8)
const text = (value) => ({ blocks: [{ type: 'text', text: value }] })
const hours = (value) => value * 3600000
const isoIn = (ms) => new Date(Date.now() + ms).toISOString()
const config = {
   ...env,
   appUrl: 'https://app.example.test',
   telegram: { ...env.telegram, clientId: `scheduled-bot-${suffix}`, botToken: `scheduled-token-${suffix}` },
}

test('M14 PR 3: close-time reminders, answers, results, expiry, quiet expiry, retention', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   t.after(() => client.end())

   async function createUser(role, { language = 'ru', timezone = 'Asia/Dushanbe', status = 'active' } = {}) {
      const { rows } = await client.query(
         `INSERT INTO users (status, onboarding_completed_at) VALUES ($1, CURRENT_TIMESTAMP) RETURNING id`, [status],
      )
      await client.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2', [rows[0].id, role])
      await client.query(
         'INSERT INTO user_profiles (user_id, first_name, language_code, timezone) VALUES ($1, $2, $3, $4)',
         [rows[0].id, 'Sched', language, timezone],
      )
      return rows[0].id
   }

   const handlers = createNotificationJobHandlers({ config })
   async function drain() {
      while (await runNextJob({ handlers, workerId: `sched-${suffix}`, leaseSeconds: 30, repository: jobRepository, log: () => {} }));
   }
   async function inbox(userId, eventCode) {
      const { rows } = await client.query(
         `SELECT title, body, target_path, dedupe_key FROM notifications
          WHERE user_id = $1 AND event_code = $2 ORDER BY id`,
         [userId, eventCode],
      )
      return rows
   }
   const job = async (dedupeKey) => (await client.query(
      `SELECT status, available_at, payload FROM background_jobs WHERE dedupe_key = $1`, [`notify:${dedupeKey}`],
   )).rows[0] || null
   const makeDue = (dedupeKey) => client.query(
      `UPDATE background_jobs SET available_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE dedupe_key = $1`,
      [`notify:${dedupeKey}`],
   )
   const iso = (value) => new Date(value).toISOString()

   const adminId = await createUser('admin')
   const subject = await createSubjectService(adminId, {
      code: `sn-${suffix}`, primaryLanguage: 'en', translations: { en: { title: 'Scheduled' } },
   })
   const bank = await createQuestionBankService(adminId, {
      code: `sn-bank-${suffix}`, title: 'Scheduled', subjectId: subject.id, visibility: 'staff',
   })
   const question = await createQuestionService(adminId, bank.id, {
      questionType: 'single_choice',
      languageCode: 'en',
      content: text('Pick A'),
      options: [{ key: 'A', content: text('Right') }, { key: 'B', content: text('Wrong') }],
   })
   await replaceAnswerKeyService(adminId, question.id, {
      answerData: { optionKey: 'A' }, source: 'expert_review', explanation: text('Because A'),
   })
   await verifyAnswerKeyService(adminId, question.id, { source: 'expert_review' })
   await publishQuestionService(adminId, question.id)
   const courseId = (await client.query(
      `INSERT INTO courses (title, subject_id, status, created_by) VALUES ($1, $2, 'published', $3) RETURNING id`,
      [`Sched ${suffix}`, subject.id, adminId],
   )).rows[0].id

   let testIndex = 0
   async function publishedTest(settings = {}) {
      testIndex += 1
      const quiz = await createTestService(adminId, {
         courseId, title: `Quiz ${testIndex} ${suffix}`, mode: 'practice', maxAttempts: 1, ...settings,
      })
      await addTestQuestionsService(adminId, quiz.id, { questions: [{ questionId: question.id, points: '1' }] })
      await publishTestService(adminId, quiz.id)
      return quiz
   }
   async function student(options) {
      const userId = await createUser('student', options)
      await grantCourseEnrollmentService(adminId, courseId, { userId, expiresAt: null })
      return userId
   }
   let groupIndex = 0
   async function group(members) {
      groupIndex += 1
      const groupId = (await client.query(
         `INSERT INTO groups (code, title, created_by) VALUES ($1, 'Sched group', $2) RETURNING id`,
         [`sn-${groupIndex}-${suffix}`, adminId],
      )).rows[0].id
      for (const member of members) {
         await client.query('INSERT INTO group_members (group_id, user_id, added_by) VALUES ($1, $2, $3)', [groupId, member, adminId])
      }
      return groupId
   }
   async function finish(learner, assignmentId, optionKey = 'B') {
      const view = await startAttemptService(learner, assignmentId)
      await saveAnswerService(learner, view.attempt.id, view.questions[0].id, { answer: { optionKey }, revision: 1 })
      await submitAttemptService(learner, view.attempt.id)
      return view.attempt.id
   }

   await drain()

   await t.test('closing reminder: only those without a finished attempt and with attempts left', async () => {
      const fresh = await student({ language: 'tg' })
      const finished = await student()
      const noneLeft = await student()
      const extra = await student()
      const left = await student()
      const blocked = await student()
      const groupId = await group([fresh, finished, noneLeft, extra, left, blocked])
      const quiz = await publishedTest({ maxAttempts: 1 })
      const closesAt = isoIn(hours(48))
      const assignment = await createAssignmentService(adminId, quiz.id, { groupId, closesAt })
      const key = `test.closing_24h:${assignment.id}:${iso(closesAt)}`
      const scheduled = await job(key)
      assert.equal(scheduled.status, 'pending')
      assert.equal(iso(scheduled.available_at), iso(new Date(closesAt).getTime() - hours(24)))

      await finish(finished, assignment.id)
      await startAttemptService(noneLeft, assignment.id)
      await startAttemptService(extra, assignment.id)
      await grantExtraAttemptsService(adminId, quiz.id, assignment.id, extra, {
         count: 1, reason: 'One more', idempotencyKey: `sn-${suffix}-extra`,
      })
      await client.query("UPDATE group_members SET status = 'left', left_at = CURRENT_TIMESTAMP WHERE group_id = $1 AND user_id = $2", [groupId, left])
      await client.query("UPDATE users SET status = 'blocked', blocked_at = CURRENT_TIMESTAMP WHERE id = $1", [blocked])

      await makeDue(key)
      await drain()
      assert.deepEqual((await inbox(fresh, 'test.closing_24h')).map((row) => [row.title, row.body, row.target_path, row.dedupe_key]), [
         ['Санҷиш ба наздикӣ пӯшида мешавад', `То пӯшидани санҷиши «${quiz.title}» 24 соат монд.`, `/courses/${courseId}`, key],
      ])
      assert.equal((await inbox(extra, 'test.closing_24h')).length, 1, 'extra attempts count')
      for (const userId of [finished, noneLeft, left, blocked]) {
         assert.deepEqual(await inbox(userId, 'test.closing_24h'), [], String(userId))
      }
      assert.equal((await job(key)).status, 'completed')
   })

   await t.test('closes_at moved: the old job writes nothing, the new one has its own key', async () => {
      const learner = await student()
      const quiz = await publishedTest()
      const first = isoIn(hours(48))
      const assignment = await createAssignmentService(adminId, quiz.id, { userId: learner, closesAt: first })
      const second = isoIn(hours(72))
      await updateAssignmentService(adminId, quiz.id, assignment.id, { closesAt: second })
      const oldKey = `test.closing_24h:${assignment.id}:${iso(first)}`
      const newKey = `test.closing_24h:${assignment.id}:${iso(second)}`
      assert.ok(await job(oldKey))
      assert.ok(await job(newKey))
      await makeDue(oldKey)
      await drain()
      assert.equal((await job(oldKey)).status, 'completed')
      assert.deepEqual(await inbox(learner, 'test.closing_24h'), [])
      await makeDue(newKey)
      await drain()
      assert.deepEqual((await inbox(learner, 'test.closing_24h')).map((row) => row.dedupe_key), [newKey])
   })

   await t.test('revoked assignment: no reminder', async () => {
      const learner = await student()
      const quiz = await publishedTest()
      const closesAt = isoIn(hours(30))
      const assignment = await createAssignmentService(adminId, quiz.id, { userId: learner, closesAt })
      await revokeAssignmentService(adminId, quiz.id, assignment.id)
      const key = `test.closing_24h:${assignment.id}:${iso(closesAt)}`
      await makeDue(key)
      await drain()
      assert.equal((await job(key)).status, 'completed')
      assert.deepEqual(await inbox(learner, 'test.closing_24h'), [])
   })

   await t.test('time boundaries: exactly 24 h ahead is scheduled, less than 24 h is not', async () => {
      const learner = await student()
      const quiz = await publishedTest()
      const short = await createAssignmentService(adminId, quiz.id, { userId: learner, closesAt: isoIn(hours(23)) })
      const shortJobs = await client.query(
         `SELECT count(*)::integer AS count FROM background_jobs WHERE dedupe_key LIKE $1`,
         [`notify:test.closing_24h:${short.id}:%`],
      )
      assert.equal(shortJobs.rows[0].count, 0)

      const now = new Date('2030-03-01T08:00:00.000Z')
      const exact = new Date(now.getTime() + hours(24))
      const justUnder = new Date(now.getTime() + hours(24) - 1)
      await withTransaction(async (tx) => {
         await enqueueAssignmentCloseEvents(tx, { assignmentId: '987654321', closesAt: exact, answerRevealPolicy: 'after_submission', now })
         await enqueueAssignmentCloseEvents(tx, { assignmentId: '987654322', closesAt: justUnder, answerRevealPolicy: 'after_submission', now })
      })
      const exactJob = await job(`test.closing_24h:987654321:${exact.toISOString()}`)
      assert.equal(iso(exactJob.available_at), now.toISOString())
      assert.equal(await job(`test.closing_24h:987654322:${justUnder.toISOString()}`), null)
      await client.query(
         "DELETE FROM background_jobs WHERE dedupe_key LIKE 'notify:test.closing_24h:98765432_:%'",
      )
   })

   await t.test('answers available: only after_window, only to those with a finished attempt, at closes_at', async () => {
      const done = await student({ language: 'en' })
      const idle = await student({ language: 'en' })
      const groupId = await group([done, idle])
      const windowQuiz = await publishedTest({ answerRevealPolicy: 'after_window', maxAttempts: 2 })
      const plainQuiz = await publishedTest({ answerRevealPolicy: 'after_submission', maxAttempts: 2 })
      const closesAt = isoIn(hours(2))
      const windowAssignment = await createAssignmentService(adminId, windowQuiz.id, { groupId, closesAt })
      const plainAssignment = await createAssignmentService(adminId, plainQuiz.id, { groupId, closesAt })
      const windowKey = `test.answers_available:${windowAssignment.id}:${iso(closesAt)}`
      const windowJob = await job(windowKey)
      assert.equal(iso(windowJob.available_at), iso(closesAt))
      assert.equal(await job(`test.answers_available:${plainAssignment.id}:${iso(closesAt)}`), null)
      // Less than 24 h ahead: no reminder for either.
      assert.equal(await job(`test.closing_24h:${windowAssignment.id}:${iso(closesAt)}`), null)
      await finish(done, windowAssignment.id)
      await finish(done, plainAssignment.id)

      // Not closed yet: the job writes nothing even if it runs early.
      assert.deepEqual(await runNotificationFanoutService(windowJob.payload, { config }), { created: 0, telegram: 0 })

      // The window closes (time moved back so that opens_at < closes_at < now).
      for (const assignmentId of [windowAssignment.id, plainAssignment.id]) {
         await client.query(
            `UPDATE test_assignments SET opens_at = CURRENT_TIMESTAMP - INTERVAL '2 hours',
                closes_at = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE id = $1`,
            [assignmentId],
         )
      }
      const closed = iso((await client.query('SELECT closes_at FROM test_assignments WHERE id = $1', [windowAssignment.id])).rows[0].closes_at)
      // The job for the old close time does nothing.
      assert.equal((await runNotificationFanoutService(windowJob.payload, { config })).created, 0)
      await runNotificationFanoutService({ event: 'test.answers_available', assignmentId: String(windowAssignment.id), closesAt: closed }, { config })
      await runNotificationFanoutService({ event: 'test.answers_available', assignmentId: String(plainAssignment.id), closesAt: closed }, { config })
      assert.deepEqual((await inbox(done, 'test.answers_available')).map((row) => [row.title, row.body]), [
         ['Answers available', `Answers for “${windowQuiz.title}” are now available.`],
      ])
      assert.deepEqual(await inbox(idle, 'test.answers_available'), [])
   })

   await t.test('result updated: only when the regrade changes the score', async () => {
      const learner = await student()
      const quiz = await publishedTest()
      const assignment = await createAssignmentService(adminId, quiz.id, { userId: learner })
      const attemptId = await finish(learner, assignment.id, 'B')
      const itemId = (await client.query('SELECT id FROM attempt_questions WHERE attempt_id = $1', [attemptId])).rows[0].id
      const regrade = (points, key) => regradeAttemptService(adminId, quiz.id, attemptId, {
         reason: 'Review', idempotencyKey: `${suffix}-${key}`, overrides: [{ attemptQuestionId: String(itemId), points }],
      })
      await regrade('0', 'same')
      await drain()
      assert.deepEqual(await inbox(learner, 'test.result_updated'), [], 'score unchanged')
      await regrade('1', 'up')
      await drain()
      assert.deepEqual((await inbox(learner, 'test.result_updated')).map((row) => [row.body, row.target_path]), [
         [`Результат теста «${quiz.title}» обновлён.`, `/tests/attempts/${attemptId}/result`],
      ])
      await regrade('1', 'again')
      await drain()
      assert.equal((await inbox(learner, 'test.result_updated')).length, 1)
   })

   await t.test('attempt expired by the timer: in-app only', async () => {
      const learner = await student()
      const quiz = await publishedTest()
      const assignment = await createAssignmentService(adminId, quiz.id, { userId: learner })
      const view = await startAttemptService(learner, assignment.id)
      await client.query(
         `UPDATE test_attempts SET started_at = CURRENT_TIMESTAMP - INTERVAL '1 hour',
             expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = $1`,
         [view.attempt.id],
      )
      while (await finalizeNextExpiredAttemptService());
      await drain()
      assert.deepEqual((await inbox(learner, 'attempt.expired')).map((row) => [row.title, row.target_path]), [
         ['Время вышло', `/tests/attempts/${view.attempt.id}/result`],
      ])
      // A submitted attempt does not produce it.
      const other = await student()
      const otherAssignment = await createAssignmentService(adminId, quiz.id, { userId: other })
      await finish(other, otherAssignment.id)
      await drain()
      assert.deepEqual(await inbox(other, 'attempt.expired'), [])
   })

   await t.test('QUIET_EXPIRED: a reminder that would wait past the close is not sent; in-app stays', async () => {
      async function connected(quiet) {
         const userId = await student({ timezone: 'UTC' })
         await client.query(
            `INSERT INTO auth_identities (user_id, provider, issuer, provider_subject)
             VALUES ($1, 'telegram', 'https://oauth.telegram.org', $2)`,
            [userId, `sched-${suffix}-${userId}`],
         )
         await client.query(
            'INSERT INTO telegram_connections (user_id, bot_id, chat_id) VALUES ($1, $2, $3)',
            [userId, config.telegram.clientId, String(8_200_000_000 + Number(userId))],
         )
         await client.query(
            'INSERT INTO notification_settings (user_id, quiet_start, quiet_end) VALUES ($1, $2, $3)',
            [userId, quiet?.start ?? null, quiet?.end ?? null],
         )
         return userId
      }
      const hhmm = (ms) => new Date(Date.now() + ms).toISOString().slice(11, 16)
      const sleeper = await connected({ start: hhmm(-hours(1)), end: hhmm(hours(2)) })
      const awake = await connected(null)
      const groupId = await group([sleeper, awake])
      const quiz = await publishedTest()
      const assignment = await createAssignmentService(adminId, quiz.id, { groupId, closesAt: isoIn(hours(48)) })
      // The close moves into the sleeper's quiet hours (1 h ahead; they end in 2 h).
      await client.query("UPDATE test_assignments SET closes_at = CURRENT_TIMESTAMP + INTERVAL '1 hour' WHERE id = $1", [assignment.id])
      const closes = iso((await client.query('SELECT closes_at FROM test_assignments WHERE id = $1', [assignment.id])).rows[0].closes_at)
      await runNotificationFanoutService({ event: 'test.closing_24h', assignmentId: String(assignment.id), closesAt: closes }, { config })
      const rows = async (userId) => (await client.query(
         `SELECT delivery.id, delivery.status, delivery.last_error_code FROM notification_deliveries AS delivery
          JOIN notifications AS notification ON notification.id = delivery.notification_id
          WHERE notification.user_id = $1 AND notification.event_code = 'test.closing_24h'`,
         [userId],
      )).rows
      assert.equal((await inbox(sleeper, 'test.closing_24h')).length, 1, 'in-app stays')
      assert.deepEqual((await rows(sleeper)).map((row) => [row.status, row.last_error_code]), [['cancelled', 'QUIET_EXPIRED']])
      assert.deepEqual((await rows(awake)).map((row) => row.status), ['pending'])

      // Queued while awake, then quiet hours start before the send: cancelled at send time.
      await client.query('UPDATE notification_settings SET quiet_start = $2, quiet_end = $3 WHERE user_id = $1', [awake, hhmm(-hours(1)), hhmm(hours(2))])
      const calls = []
      const bot = { sendMessage: async (chatId, body) => { calls.push({ chatId, body }); return { messageId: '1' } } }
      const limiter = new TelegramRateLimiter({ now: () => 0, sleep: async () => {} })
      while (await sendTelegramBatchService({ limiter }, { config, botProvider: bot }));
      assert.equal(calls.length, 0)
      assert.deepEqual((await rows(awake)).map((row) => [row.status, row.last_error_code]), [['cancelled', 'QUIET_EXPIRED']])

      // A reminder whose close already passed (the worker was down) is not sent either.
      await client.query('UPDATE notification_settings SET quiet_start = NULL, quiet_end = NULL WHERE user_id = $1', [awake])
      const late = await client.query(
         `INSERT INTO notifications (user_id, event_code, title, body, dedupe_key)
          VALUES ($1, 'test.closing_24h', 'T', 'B', $2) RETURNING id`,
         [awake, `test.closing_24h:${assignment.id}:${isoIn(-hours(1))}`],
      )
      const connectionId = (await client.query('SELECT id FROM telegram_connections WHERE user_id = $1', [awake])).rows[0].id
      await client.query(
         `INSERT INTO notification_deliveries (notification_id, channel, telegram_connection_id, destination_key, next_attempt_at)
          VALUES ($1, 'telegram', $2, $3, CURRENT_TIMESTAMP - INTERVAL '1 second')`,
         [late.rows[0].id, connectionId, `telegram:${connectionId}`],
      )
      while (await sendTelegramBatchService({ limiter }, { config, botProvider: bot }));
      assert.equal(calls.length, 0)
      const lateRow = await client.query('SELECT status, last_error_code FROM notification_deliveries WHERE notification_id = $1', [late.rows[0].id])
      assert.deepEqual(lateRow.rows[0], { status: 'cancelled', last_error_code: 'NOTIFICATION_EXPIRED' })
   })

   await t.test('retention: older than 180 days deleted with deliveries, newer kept, once a day', async () => {
      const userId = await createUser('student')
      const insert = async (days, key) => (await client.query(
         `INSERT INTO notifications (user_id, event_code, title, body, dedupe_key, created_at, read_at)
          VALUES ($1, 'account.approved', 'T', 'B', $2, CURRENT_TIMESTAMP - make_interval(days => $3::integer),
             CASE WHEN $3::integer > 200 THEN CURRENT_TIMESTAMP END)
          RETURNING id`,
         [userId, `${suffix}-${key}`, days],
      )).rows[0].id
      const old = await insert(181, 'old')
      const veryOld = await insert(400, 'very-old')
      const young = await insert(179, 'young')
      const identity = await client.query(
         `INSERT INTO auth_identities (user_id, provider, issuer, provider_subject)
          VALUES ($1, 'telegram', 'https://oauth.telegram.org', $2) RETURNING id`,
         [userId, `retention-${suffix}`],
      )
      assert.ok(identity.rows[0].id)
      const connection = await client.query(
         'INSERT INTO telegram_connections (user_id, bot_id, chat_id) VALUES ($1, $2, $3) RETURNING id',
         [userId, `retention-bot-${suffix}`, '8299999999'],
      )
      await client.query(
         `INSERT INTO notification_deliveries (notification_id, channel, telegram_connection_id, destination_key, status, next_attempt_at)
          VALUES ($1, 'telegram', $2, $3, 'sent', CURRENT_TIMESTAMP)`,
         [old, connection.rows[0].id, `telegram:${connection.rows[0].id}`],
      )
      const result = await runNotificationRetentionService({ days: 180 })
      assert.ok(result.deleted >= 2)
      const remaining = await client.query('SELECT id FROM notifications WHERE id = ANY($1::bigint[]) ORDER BY id', [[old, veryOld, young]])
      assert.deepEqual(remaining.rows.map((row) => row.id), [young])
      const deliveries = await client.query('SELECT count(*)::integer AS count FROM notification_deliveries WHERE notification_id = $1', [old])
      assert.equal(deliveries.rows[0].count, 0)

      const fixed = { now: () => new Date('2031-05-05T10:00:00Z') }
      const first = await scheduleNotificationRetentionService(fixed)
      const second = await scheduleNotificationRetentionService({ now: () => new Date('2031-05-05T23:00:00Z') })
      const nextDay = await scheduleNotificationRetentionService({ now: () => new Date('2031-05-06T00:30:00Z') })
      assert.ok(first)
      assert.equal(second, null)
      assert.ok(nextDay)
      await client.query("DELETE FROM background_jobs WHERE dedupe_key IN ('notification.retention:2031-05-05', 'notification.retention:2031-05-06')")
   })
})
