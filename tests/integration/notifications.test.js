import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import pg from 'pg'

import { createApp } from '../../src/app.js'
import env from '../../src/configs/env.js'
import { runNextJob } from '../../src/jobs/job-worker.js'
import * as jobRepository from '../../src/repositories/job-repository.js'
import { withTransaction } from '../../src/repositories/transaction-repository.js'
import {
   approveUserService,
   blockUserService,
   unblockUserService,
} from '../../src/services/account-admin-service.js'
import { issueSessionService } from '../../src/services/auth/session-service.js'
import {
   grantCourseEnrollmentService,
   grantModuleAccessService,
   revokeCourseEnrollmentService,
} from '../../src/services/course-access-service.js'
import {
   addGroupMemberService,
   createGroupAnnouncementService,
   updateGroupAnnouncementService,
} from '../../src/services/group-service.js'
import {
   enqueueCourseEnrolled,
   notificationJobHandlers,
   runNotificationFanoutService,
} from '../../src/services/notification-service.js'
import {
   createQuestionBankService,
   createQuestionService,
   publishQuestionService,
   replaceAnswerKeyService,
   verifyAnswerKeyService,
} from '../../src/services/question-bank-service.js'
import { createSubjectService } from '../../src/services/taxonomy-service.js'
import { grantExtraAttemptsService } from '../../src/services/test-results-service.js'
import {
   addTestQuestionsService,
   createAssignmentService,
   createTestService,
   publishTestService,
   revokeAssignmentService,
   updateAssignmentService,
} from '../../src/services/test-service.js'

const { Client } = pg
const config = {
   ...env,
   jwtAccessSecret: 'notifications-integration-secret-longer-than-32-chars',
   authSessionTtlSeconds: 900,
   authRefreshTtlSeconds: 86400,
   authAdminRateLimit: 1000,
}
const suffix = randomUUID().slice(0, 8)
const text = (value) => ({ blocks: [{ type: 'text', text: value }] })

test('M14 notifications: events, fan-out and inbox', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   t.after(() => client.end())

   async function createUser(role, { status = 'active', language = 'ru', timezone = 'Asia/Dushanbe' } = {}) {
      const { rows } = await client.query(
         `INSERT INTO users (status, onboarding_completed_at) VALUES ($1, CURRENT_TIMESTAMP) RETURNING id`,
         [status],
      )
      const userId = rows[0].id
      await client.query(
         'INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2',
         [userId, role],
      )
      await client.query(
         'INSERT INTO user_profiles (user_id, first_name, language_code, timezone) VALUES ($1, $2, $3, $4)',
         [userId, `N${suffix}`, language, timezone],
      )
      return userId
   }

   const workerId = `notifications-${suffix}`
   async function drain() {
      let processed = 0
      while (await runNextJob({
         handlers: notificationJobHandlers, workerId, leaseSeconds: 30, repository: jobRepository, log: () => {},
      })) processed += 1
      return processed
   }
   async function inbox(userId, eventCode = null) {
      const { rows } = await client.query(
         `SELECT event_code, title, body, target_path, dedupe_key, read_at
          FROM notifications WHERE user_id = $1 AND ($2::text IS NULL OR event_code = $2) ORDER BY id`,
         [userId, eventCode],
      )
      return rows
   }

   const adminId = await createUser('admin')
   const subject = await createSubjectService(adminId, {
      code: `nt-${suffix}`, primaryLanguage: 'en', translations: { en: { title: 'Notify' } },
   })
   const bank = await createQuestionBankService(adminId, {
      code: `nt-bank-${suffix}`, title: 'Notify', subjectId: subject.id, visibility: 'staff',
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
   const courseTitle = `Algebra ${suffix}`
   const courseId = (await client.query(
      `INSERT INTO courses (title, subject_id, status, created_by) VALUES ($1, $2, 'published', $3) RETURNING id`,
      [courseTitle, subject.id, adminId],
   )).rows[0].id
   const moduleId = (await client.query(
      `INSERT INTO course_modules (course_id, title, position, status)
       VALUES ($1, 'Fractions', 1, 'published') RETURNING id`,
      [courseId],
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
         `INSERT INTO groups (code, title, created_by) VALUES ($1, $2, $3) RETURNING id`,
         [`nt-${groupIndex}-${suffix}`, `Group ${groupIndex} ${suffix}`, adminId],
      )).rows[0].id
      for (const member of members) {
         await client.query(
            'INSERT INTO group_members (group_id, user_id, added_by) VALUES ($1, $2, $3)',
            [groupId, member, adminId],
         )
      }
      return groupId
   }

   await drain()

   await t.test('account approved and unblocked, rendered in the profile language (tg = tj)', async () => {
      const pending = await createUser('student', { status: 'pending', language: 'tg' })
      await approveUserService(adminId, pending)
      await drain()
      assert.deepEqual((await inbox(pending)).map((row) => [row.event_code, row.title, row.body, row.target_path]), [
         ['account.approved', 'Ҳисоб тасдиқ шуд', 'Ҳисоби EVEREST-и шумо тасдиқ шуд. Метавонед ворид шавед.', '/'],
      ])
      await blockUserService(adminId, pending)
      await unblockUserService(adminId, pending)
      await drain()
      const unblocked = await inbox(pending, 'account.unblocked')
      assert.equal(unblocked.length, 1)
      assert.equal(unblocked[0].body, 'Ҳисоби EVEREST-и шумо боз фаъол аст.')
   })

   await t.test('course enrolled: now, later (at beginsAt) and revoked before it runs', async () => {
      const english = await student({ language: 'en' })
      await drain()
      assert.deepEqual((await inbox(english, 'course.enrolled')).map((row) => [row.title, row.body, row.target_path]), [
         ['New course', `You now have access to “${courseTitle}”.`, `/courses/${courseId}`],
      ])

      const otherCourse = (await client.query(
         `INSERT INTO courses (title, subject_id, status, created_by) VALUES ($1, $2, 'published', $3) RETURNING id`,
         [`Later ${suffix}`, subject.id, adminId],
      )).rows[0].id
      const beginsAt = new Date(Date.now() + 3600000).toISOString()
      await grantCourseEnrollmentService(adminId, otherCourse, { userId: english, beginsAt, expiresAt: null })
      await drain()
      assert.equal((await inbox(english, 'course.enrolled')).length, 1, 'not before beginsAt')
      // Time passes: the grant begins and the job becomes due.
      await client.query(
         `UPDATE course_enrollments SET begins_at = CURRENT_TIMESTAMP - INTERVAL '1 minute'
          WHERE user_id = $1 AND course_id = $2`,
         [english, otherCourse],
      )
      await client.query(
         `UPDATE background_jobs SET available_at = CURRENT_TIMESTAMP - INTERVAL '1 minute'
          WHERE job_type = 'notification.fanout' AND status = 'pending' AND payload->>'event' = 'course.enrolled'
            AND available_at > CURRENT_TIMESTAMP`,
      )
      await drain()
      assert.equal((await inbox(english, 'course.enrolled')).length, 2)

      const revoked = await createUser('student')
      await grantCourseEnrollmentService(adminId, courseId, { userId: revoked, expiresAt: null })
      await revokeCourseEnrollmentService(adminId, courseId, revoked)
      await drain()
      assert.deepEqual(await inbox(revoked), [])
   })

   await t.test('module opened', async () => {
      const learner = await student()
      await grantModuleAccessService(adminId, courseId, learner, { moduleId, expiresAt: null })
      await drain()
      assert.deepEqual((await inbox(learner, 'module.opened')).map((row) => [row.title, row.body, row.target_path]), [
         ['Модуль открыт', `Вам открыт модуль «Fractions» курса «${courseTitle}».`, `/courses/${courseId}`],
      ])
   })

   await t.test('test assigned to a group: active members only, close time in their zone', async () => {
      const first = await student()
      const second = await student({ timezone: 'UTC' })
      const left = await student()
      const blocked = await student()
      const groupId = await group([first, second, left, blocked])
      await client.query("UPDATE group_members SET status = 'left', left_at = CURRENT_TIMESTAMP WHERE group_id = $1 AND user_id = $2", [groupId, left])
      await client.query("UPDATE users SET status = 'blocked', blocked_at = CURRENT_TIMESTAMP WHERE id = $1", [blocked])
      const quiz = await publishedTest()
      const assignment = await createAssignmentService(adminId, quiz.id, {
         groupId, closesAt: '2030-01-15T10:00:00.000Z',
      })
      await drain()
      const [firstRow] = await inbox(first, 'test.assigned')
      assert.equal(firstRow.body, `Новый тест «${quiz.title}». Доступен до 15.01.2030 15:00.`)
      assert.equal(firstRow.target_path, `/courses/${courseId}`)
      assert.equal(firstRow.dedupe_key, `test.assigned:${assignment.id}`)
      assert.equal((await inbox(second, 'test.assigned'))[0].body.endsWith('15.01.2030 10:00.'), true)
      assert.deepEqual(await inbox(left, 'test.assigned'), [])
      assert.deepEqual(await inbox(blocked, 'test.assigned'), [])

      // Running the same event again writes nothing new.
      const again = await runNotificationFanoutService({ event: 'test.assigned', assignmentId: String(assignment.id) })
      assert.equal(again.created, 0)
      assert.equal((await inbox(first, 'test.assigned')).length, 1)
   })

   await t.test('assignment opening later notifies at opensAt; a moved opening time still notifies once', async () => {
      const learner = await student()
      const quiz = await publishedTest()
      const opensAt = new Date(Date.now() + 3600000).toISOString()
      const assignment = await createAssignmentService(adminId, quiz.id, { userId: learner, opensAt })
      await drain()
      assert.deepEqual(await inbox(learner, 'test.assigned'), [])
      const movedTo = new Date(Date.now() + 7200000).toISOString()
      await updateAssignmentService(adminId, quiz.id, assignment.id, { opensAt: movedTo })
      // The old time comes first: the assignment is not open yet, nothing is written.
      await client.query(
         `UPDATE background_jobs SET available_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
          WHERE dedupe_key = $1`,
         [`notify:test.assigned:${assignment.id}:${new Date(opensAt).toISOString()}`],
      )
      await drain()
      assert.deepEqual(await inbox(learner, 'test.assigned'), [])
      // Then the new time arrives.
      await client.query("UPDATE test_assignments SET opens_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = $1", [assignment.id])
      await client.query(
         `UPDATE background_jobs SET available_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
          WHERE dedupe_key = $1`,
         [`notify:test.assigned:${assignment.id}:${new Date(movedTo).toISOString()}`],
      )
      await drain()
      assert.equal((await inbox(learner, 'test.assigned')).length, 1)
   })

   await t.test('a student added to a group gets test.assigned for each open assignment, without duplicates', async () => {
      const existing = await student()
      const groupId = await group([existing])
      const open = [await publishedTest(), await publishedTest()]
      const openAssignments = []
      for (const quiz of open) openAssignments.push(await createAssignmentService(adminId, quiz.id, { groupId }))
      const futureQuiz = await publishedTest()
      await createAssignmentService(adminId, futureQuiz.id, {
         groupId, opensAt: new Date(Date.now() + 3600000).toISOString(),
      })
      const revokedQuiz = await publishedTest()
      const revokedAssignment = await createAssignmentService(adminId, revokedQuiz.id, { groupId })
      await revokeAssignmentService(adminId, revokedQuiz.id, revokedAssignment.id)
      await drain()
      assert.equal((await inbox(existing, 'test.assigned')).length, 2)

      const newcomer = await student()
      await addGroupMemberService(adminId, groupId, { userId: String(newcomer) })
      await drain()
      const received = await inbox(newcomer, 'test.assigned')
      assert.deepEqual(
         received.map((row) => row.dedupe_key).sort(),
         openAssignments.map((assignment) => `test.assigned:${assignment.id}`).sort(),
      )
      // The group-wide event running again (or late) does not duplicate the newcomer's copy.
      for (const assignment of openAssignments) {
         await runNotificationFanoutService({ event: 'test.assigned', assignmentId: String(assignment.id) })
      }
      assert.equal((await inbox(newcomer, 'test.assigned')).length, 2)
      assert.equal((await inbox(existing, 'test.assigned')).length, 2, 'existing members are not notified again')
   })

   await t.test('group announcement: on first publication only, not to the author', async () => {
      const member = await student({ language: 'en' })
      const groupId = await group([member, adminId])
      const published = await createGroupAnnouncementService(adminId, groupId, {
         title: 'Exam on Friday', content: 'Bring a pen', status: 'published',
      })
      const draft = await createGroupAnnouncementService(adminId, groupId, { title: 'Draft news', content: 'Soon' })
      await drain()
      assert.deepEqual((await inbox(member, 'group.announcement')).map((row) => row.body), [
         `Group ${groupIndex} ${suffix}: new announcement “Exam on Friday”`,
      ])
      assert.deepEqual(await inbox(adminId, 'group.announcement'), [])

      await updateGroupAnnouncementService(adminId, groupId, draft.id, { status: 'published' })
      await updateGroupAnnouncementService(adminId, groupId, draft.id, { title: 'Draft news, edited' })
      await updateGroupAnnouncementService(adminId, groupId, published.id, { title: 'Exam moved' })
      await drain()
      assert.equal((await inbox(member, 'group.announcement')).length, 2)
   })

   await t.test('extra attempts', async () => {
      const learner = await student()
      const quiz = await publishedTest()
      const assignment = await createAssignmentService(adminId, quiz.id, { userId: learner })
      await grantExtraAttemptsService(adminId, quiz.id, assignment.id, learner, {
         count: 2, reason: 'Retake', idempotencyKey: `nt-${suffix}`,
      })
      await drain()
      assert.deepEqual((await inbox(learner, 'test.extra_attempts')).map((row) => row.body), [
         `Вам выданы доп. попытки (2) в тесте «${quiz.title}».`,
      ])
   })

   await t.test('a failed domain transaction leaves no notification job', async () => {
      const learner = await createUser('student')
      const before = await client.query("SELECT count(*)::integer AS count FROM background_jobs WHERE job_type = 'notification.fanout'")
      await assert.rejects(grantCourseEnrollmentService(adminId, courseId, { userId: learner, expiresAt: null }, {
         auth: { appendAuditEvent: async () => ({ id: '1' }) },
         transaction: (work) => withTransaction(async (tx) => {
            await work(tx)
            throw new Error('commit failed')
         }),
      }), /commit failed/)
      const after = await client.query("SELECT count(*)::integer AS count FROM background_jobs WHERE job_type = 'notification.fanout'")
      assert.equal(after.rows[0].count, before.rows[0].count)
   })

   await t.test('an unknown event fails permanently', async () => {
      const jobId = await withTransaction((tx) => jobRepository.enqueueJob({
         jobType: 'notification.fanout', payload: { event: 'nope' }, dedupeKey: `notify:nope:${suffix}`,
      }, tx))
      await drain()
      const { rows } = await client.query('SELECT status, last_error_code, attempts FROM background_jobs WHERE id = $1', [jobId])
      assert.deepEqual(rows[0], { status: 'failed', last_error_code: 'NOTIFICATION_EVENT_UNKNOWN', attempts: 1 })
   })

   await t.test('a group of 200: one job writes 200 notifications', async () => {
      const { rows } = await client.query(
         `INSERT INTO users (status, onboarding_completed_at)
          SELECT 'active', CURRENT_TIMESTAMP FROM generate_series(1, 200) RETURNING id`,
      )
      const ids = rows.map((row) => row.id)
      await client.query(
         `INSERT INTO user_profiles (user_id, language_code)
          SELECT id, (ARRAY['ru','tg','en'])[1 + (id % 3)] FROM unnest($1::bigint[]) AS id`,
         [ids],
      )
      const groupId = await group([])
      await client.query(
         'INSERT INTO group_members (group_id, user_id, added_by) SELECT $1, id, $2 FROM unnest($3::bigint[]) AS id',
         [groupId, adminId, ids],
      )
      await createGroupAnnouncementService(adminId, groupId, { title: 'Big', content: 'All', status: 'published' })
      const started = Date.now()
      assert.equal(await drain(), 1)
      const elapsed = Date.now() - started
      const count = await client.query(
         `SELECT count(*)::integer AS count, count(DISTINCT title)::integer AS titles
          FROM notifications WHERE user_id = ANY($1::bigint[]) AND event_code = 'group.announcement'`,
         [ids],
      )
      assert.deepEqual(count.rows[0], { count: 200, titles: 3 })
      assert.ok(elapsed < 10000, `fan-out took ${elapsed} ms`)
   })

   await t.test('enqueue outside a domain service is idempotent per key', async () => {
      const learner = await student()
      const enrollment = (await client.query(
         'SELECT id FROM course_enrollments WHERE user_id = $1 AND course_id = $2', [learner, courseId],
      )).rows[0]
      const first = await withTransaction((tx) => enqueueCourseEnrolled(tx, { enrollmentId: enrollment.id, auditId: '999999999', beginsAt: null }))
      const second = await withTransaction((tx) => enqueueCourseEnrolled(tx, { enrollmentId: enrollment.id, auditId: '999999999', beginsAt: null }))
      assert.ok(first)
      assert.equal(second, null)
   })

   await t.test('inbox API: list, cursor, unread, count, read, read-all', async () => {
      const app = createApp({
         telegramAuth: { config }, passwordAuth: { config }, authProtection: { config }, authorization: {},
      })
      const server = await new Promise((resolve) => {
         const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
      })
      t.after(() => new Promise((resolve) => { server.close(resolve) }))
      const { port } = server.address()
      const session = (userId) => withTransaction((tx) => issueSessionService({
         userId, requestContext: { userAgent: 'Notifications integration', ipAddress: '127.0.0.1' }, client: tx,
      }, { config }))
      async function api(method, path, actor, body) {
         const headers = { 'content-type': 'application/json' }
         if (actor) headers.authorization = `Bearer ${actor.accessToken}`
         const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
            method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
         })
         return { status: response.status, body: await response.json() }
      }

      const owner = await createUser('student')
      const stranger = await createUser('student')
      for (let index = 1; index <= 5; index += 1) {
         await client.query(
            `INSERT INTO notifications (user_id, event_code, title, body, target_path, dedupe_key)
             VALUES ($1, 'account.approved', $2, 'Body', '/', $3)`,
            [owner, `T${index}`, `manual:${suffix}:${index}`],
         )
      }
      const ownerSession = await session(owner)
      const strangerSession = await session(stranger)

      assert.equal((await api('GET', '/me/notifications', null)).status, 401)

      const page1 = await api('GET', '/me/notifications?limit=2', ownerSession)
      assert.equal(page1.status, 200)
      assert.deepEqual(page1.body.data.notifications.map((item) => item.title), ['T5', 'T4'])
      assert.deepEqual(Object.keys(page1.body.data.notifications[0]).sort(), [
         'body', 'createdAt', 'eventCode', 'id', 'readAt', 'targetPath', 'title',
      ])
      assert.equal(page1.body.data.pagination.hasMore, true)
      const page2 = await api('GET', `/me/notifications?limit=2&before=${page1.body.data.pagination.nextBefore}`, ownerSession)
      assert.deepEqual(page2.body.data.notifications.map((item) => item.title), ['T3', 'T2'])
      const page3 = await api('GET', `/me/notifications?limit=2&before=${page2.body.data.pagination.nextBefore}`, ownerSession)
      assert.deepEqual(page3.body.data.notifications.map((item) => item.title), ['T1'])
      assert.deepEqual(page3.body.data.pagination, { limit: 2, hasMore: false, nextBefore: null })

      for (const bad of ['limit=0', 'limit=51', 'before=abc', 'unread=yes', 'userId=1']) {
         assert.equal((await api('GET', `/me/notifications?${bad}`, ownerSession)).status, 400, bad)
      }

      assert.deepEqual((await api('GET', '/me/notifications/unread-count', ownerSession)).body.data, { count: 5 })
      const newest = page1.body.data.notifications[0]
      const read = await api('POST', `/me/notifications/${newest.id}/read`, ownerSession)
      assert.equal(read.status, 200)
      assert.ok(read.body.data.readAt)
      const readAgain = await api('POST', `/me/notifications/${newest.id}/read`, ownerSession)
      assert.equal(readAgain.body.data.readAt, read.body.data.readAt, 'first readAt is kept')
      assert.equal((await api('POST', `/me/notifications/${newest.id}/read`, strangerSession)).status, 404)
      assert.equal((await api('POST', '/me/notifications/abc/read', ownerSession)).status, 400)
      assert.deepEqual((await api('GET', '/me/notifications/unread-count', ownerSession)).body.data, { count: 4 })
      const unread = await api('GET', '/me/notifications?unread=true', ownerSession)
      assert.deepEqual(unread.body.data.notifications.map((item) => item.title), ['T4', 'T3', 'T2', 'T1'])

      // T6 arrives after the client loaded the list: read-all up to T4 leaves it unread.
      await client.query(
         `INSERT INTO notifications (user_id, event_code, title, body, dedupe_key)
          VALUES ($1, 'account.approved', 'T6', 'Body', $2)`,
         [owner, `manual:${suffix}:6`],
      )
      const all = await api('POST', '/me/notifications/read-all', ownerSession, { upToId: page1.body.data.notifications[1].id })
      assert.deepEqual(all.body.data, { updated: 4 })
      const remaining = await api('GET', '/me/notifications?unread=true', ownerSession)
      assert.deepEqual(remaining.body.data.notifications.map((item) => item.title), ['T6'])
      assert.equal((await api('POST', '/me/notifications/read-all', ownerSession, {})).status, 400)
      assert.equal((await api('POST', '/me/notifications/read-all', ownerSession, { upToId: 'x' })).status, 400)

      // Another user's list is empty, not shared.
      assert.deepEqual((await api('GET', '/me/notifications', strangerSession)).body.data.notifications, [])
      assert.deepEqual((await api('GET', '/me/notifications/unread-count', strangerSession)).body.data, { count: 0 })
   })
})
