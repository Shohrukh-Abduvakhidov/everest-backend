import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import pg from 'pg'

import { createApp } from '../../src/app.js'
import env from '../../src/configs/env.js'
import { withTransaction } from '../../src/repositories/transaction-repository.js'
import { issueSessionService } from '../../src/services/auth/session-service.js'
import {
   grantCourseEnrollmentService,
   grantModuleAccessService,
} from '../../src/services/course-access-service.js'
import { getLearnerLessonService } from '../../src/services/learner-lesson-service.js'
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
   getAssignmentResultService,
   getAttemptResultService,
   listMyAssignmentsService,
   saveAnswerService,
   startAttemptService,
   submitAttemptService,
} from '../../src/services/test-attempt-service.js'
import {
   getExtraAttemptsService,
   grantExtraAttemptsService,
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
   jwtAccessSecret: 'extra-attempts-integration-secret-longer-than-32',
   authSessionTtlSeconds: 900,
   authRefreshTtlSeconds: 86400,
   authAdminRateLimit: 1000,
}
const suffix = randomUUID().slice(0, 8)
const text = (value) => ({ blocks: [{ type: 'text', text: value }] })
const later = (minutes) => new Date(Date.now() + minutes * 60000)
const at = (minutes) => ({ clock: () => later(minutes) })
const rejects = (promise, code) => assert.rejects(promise, { code })

test('extra attempts integration', async (t) => {
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
      code: `xa-${suffix}`, primaryLanguage: 'en', translations: { en: { title: 'Extra' } },
   })
   const bank = await createQuestionBankService(adminId, {
      code: `xa-bank-${suffix}`, title: 'Extra', subjectId: subject.id, visibility: 'staff',
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
   const courseRow = await client.query(
      `INSERT INTO courses (title, subject_id, status, created_by)
       VALUES ($1, $2, 'published', $3) RETURNING id`,
      [`Extra ${suffix}`, subject.id, adminId],
   )
   const courseId = courseRow.rows[0].id
   const moduleRow = await client.query(
      `INSERT INTO course_modules (course_id, title, position, status)
       VALUES ($1, 'Module', 1, 'published') RETURNING id`,
      [courseId],
   )
   const moduleId = moduleRow.rows[0].id

   let index = 0
   async function publishedTest(settings = {}) {
      index += 1
      const quiz = await createTestService(adminId, {
         courseId, title: `Extra ${index} ${suffix}`, mode: 'practice', maxAttempts: 1, ...settings,
      })
      await addTestQuestionsService(adminId, quiz.id, { questions: [{ questionId: created.id, points: '2' }] })
      await publishTestService(adminId, quiz.id)
      return quiz
   }

   async function student() {
      const id = await createUser('student')
      await grantCourseEnrollmentService(adminId, courseId, { userId: id, expiresAt: null })
      return id
   }

   let groupIndex = 0
   async function group(members) {
      groupIndex += 1
      const row = await client.query(
         `INSERT INTO groups (code, title, created_by) VALUES ($1, 'Group', $2) RETURNING id`,
         [`xa-${groupIndex}-${suffix}`, adminId],
      )
      for (const member of members) {
         await client.query(
            'INSERT INTO group_members (group_id, user_id, added_by) VALUES ($1, $2, $3)',
            [row.rows[0].id, member, adminId],
         )
      }
      return row.rows[0].id
   }

   let keyIndex = 0
   const key = () => `xa-${suffix}-${(keyIndex += 1)}`
   const grant = (actor, quiz, assignment, userId, extra = {}, overrides) => grantExtraAttemptsService(
      actor, quiz.id, assignment.id, userId, { count: 1, reason: 'Retake approved', idempotencyKey: key(), ...extra }, overrides,
   )

   async function finish(learner, assignmentId, optionKey = 'B') {
      const view = await startAttemptService(learner, assignmentId)
      await saveAnswerService(learner, view.attempt.id, view.questions[0].id, { answer: { optionKey }, revision: 1 })
      return submitAttemptService(learner, view.attempt.id)
   }

   async function grantRows(assignmentId) {
      const { rows } = await client.query(
         'SELECT user_id, extra_attempts FROM test_attempt_grants WHERE assignment_id = $1 ORDER BY id',
         [assignmentId],
      )
      return rows
   }

   await t.test('a grant after exhaustion allows one more start for that student only', async () => {
      const quiz = await publishedTest()
      const learner = await student()
      const classmate = await student()
      const groupId = await group([learner, classmate])
      const assignment = await createAssignmentService(adminId, quiz.id, { groupId })
      const first = await finish(learner, assignment.id)
      await finish(classmate, assignment.id)
      await rejects(startAttemptService(learner, assignment.id), 'ATTEMPTS_EXHAUSTED')

      const state = await grant(adminId, quiz, assignment, learner, { count: 2 })
      assert.deepEqual(
         [state.maxAttempts, state.extraAttempts, state.effectiveMaxAttempts, state.attemptsUsed, state.remainingAttempts],
         [1, 2, 3, 1, 2],
      )
      assert.equal(state.grants[0].reason, 'Retake approved')
      assert.equal(state.grants[0].grantedBy, adminId)

      const listed = (await listMyAssignmentsService(learner, courseId)).assignments.find((item) => item.id === assignment.id)
      assert.equal(listed.maxAttempts, 3)
      assert.equal(listed.attempts.remainingAttempts, 2)
      assert.equal((await getAssignmentResultService(learner, assignment.id)).remainingAttempts, 2)

      const second = await finish(learner, assignment.id, 'A')
      assert.equal(second.attempt.attemptNumber, 2)
      assert.equal(second.remainingAttempts, 1)
      await finish(learner, assignment.id)
      await rejects(startAttemptService(learner, assignment.id), 'ATTEMPTS_EXHAUSTED')

      // The classmate on the same group assignment and the earlier attempt are unchanged.
      await rejects(startAttemptService(classmate, assignment.id), 'ATTEMPTS_EXHAUSTED')
      const other = (await listMyAssignmentsService(classmate, courseId)).assignments.find((item) => item.id === assignment.id)
      assert.equal(other.maxAttempts, 1)
      assert.equal(other.attempts.remainingAttempts, 0)
      const earlier = await getAttemptResultService(learner, first.attempt.id)
      assert.equal(earlier.attempt.score, first.attempt.score)
      assert.equal(earlier.attempt.submittedAt, first.attempt.submittedAt)
      const { rows } = await client.query('SELECT max_attempts FROM tests WHERE id = $1', [quiz.id])
      assert.equal(rows[0].max_attempts, 1)
   })

   await t.test('the lesson summary counts grants', async () => {
      const quiz = await publishedTest()
      const learner = await student()
      await grantModuleAccessService(adminId, courseId, learner, { moduleId, expiresAt: null })
      const lesson = await createLessonService(adminId, courseId, moduleId, {
         title: `Quiz ${suffix}`, lessonType: 'test', testId: quiz.id,
      })
      await publishLessonService(adminId, courseId, lesson.id)
      const assignment = await createAssignmentService(adminId, quiz.id, { userId: learner })
      await finish(learner, assignment.id)
      await grant(adminId, quiz, assignment, learner)
      const summary = (await getLearnerLessonService(learner, courseId, lesson.id)).lesson.test
      assert.equal(summary.maxAttempts, 2)
      assert.equal(summary.attempts.remainingAttempts, 1)
   })

   await t.test('the same key returns the earlier state without a second grant', async () => {
      const quiz = await publishedTest()
      const learner = await student()
      const other = await student()
      const assignment = await createAssignmentService(adminId, quiz.id, { userId: learner })
      const otherAssignment = await createAssignmentService(adminId, quiz.id, { userId: other })
      const body = { count: 3, reason: 'Once', idempotencyKey: `same-${suffix}` }
      const first = await grantExtraAttemptsService(adminId, quiz.id, assignment.id, learner, body)
      const again = await grantExtraAttemptsService(adminId, quiz.id, assignment.id, learner, { ...body, count: 5 })
      assert.equal(first.extraAttempts, 3)
      assert.equal(again.extraAttempts, 3)
      assert.equal((await grantRows(assignment.id)).length, 1)
      await rejects(grantExtraAttemptsService(adminId, quiz.id, otherAssignment.id, other, body), 'IDEMPOTENCY_KEY_CONFLICT')
      assert.equal((await grantRows(otherAssignment.id)).length, 0)
      const audits = await client.query(
         `SELECT count(*)::integer AS total FROM audit_events
          WHERE event_code = 'test.attempts_granted' AND subject_user_id = $1`,
         [learner],
      )
      assert.equal(audits.rows[0].total, 1)
   })

   await t.test('invalid grants are refused', async () => {
      const unlimited = await publishedTest({ maxAttempts: null })
      const quiz = await publishedTest()
      const learner = await student()
      const outsider = await student()
      const free = await createAssignmentService(adminId, unlimited.id, { userId: learner })
      await rejects(grant(adminId, unlimited, free, learner), 'ATTEMPTS_UNLIMITED')

      const windowed = await createAssignmentService(adminId, quiz.id, { userId: learner, closesAt: later(60).toISOString() })
      await rejects(grant(adminId, quiz, windowed, learner, {}, at(61)), 'ASSIGNMENT_CLOSED')
      await rejects(grant(adminId, quiz, windowed, outsider), 'STUDENT_NOT_ASSIGNED')
      for (const count of [0, 11, 1.5, '2', null]) {
         await rejects(grant(adminId, quiz, windowed, learner, { count }), 'VALIDATION_ERROR')
      }
      await rejects(grant(adminId, quiz, windowed, learner, { reason: '  ' }), 'VALIDATION_ERROR')
      await rejects(grantExtraAttemptsService(adminId, unlimited.id, windowed.id, learner, {
         count: 1, reason: 'Wrong test', idempotencyKey: key(),
      }), 'ASSIGNMENT_NOT_FOUND')

      await revokeAssignmentService(adminId, quiz.id, windowed.id)
      await rejects(grant(adminId, quiz, windowed, learner), 'ASSIGNMENT_REVOKED')
      assert.deepEqual(await grantRows(windowed.id), [])
   })

   await t.test('group teachers grant only within their own group', async (subtest) => {
      // No role holds tests.attempts.grant except owner and admin; this subtest gives it to
      // teachers for its duration to check the scope rule behind the permission.
      await client.query(
         `INSERT INTO role_permissions (role_id, permission_id)
          SELECT role.id, permission.id FROM roles AS role, permissions AS permission
          WHERE role.code = 'teacher' AND permission.code = 'tests.attempts.grant'`,
      )
      subtest.after(() => client.query(
         `DELETE FROM role_permissions
          WHERE role_id = (SELECT id FROM roles WHERE code = 'teacher')
            AND permission_id = (SELECT id FROM permissions WHERE code = 'tests.attempts.grant')`,
      ))
      const quiz = await publishedTest()
      const learner = await student()
      const stranger = await student()
      const own = await group([learner])
      const foreign = await group([stranger])
      const ownAssignment = await createAssignmentService(adminId, quiz.id, { groupId: own })
      const foreignAssignment = await createAssignmentService(adminId, quiz.id, { groupId: foreign })
      const direct = await createAssignmentService(adminId, quiz.id, { userId: learner })
      const teacher = await createUser('teacher')
      const flagless = await createUser('teacher')
      const courseTeacher = await createUser('teacher')
      await client.query(
         `INSERT INTO group_teachers (group_id, user_id, can_view_results, assigned_by)
          VALUES ($1, $2, TRUE, $4), ($1, $3, FALSE, $4)`,
         [own, teacher, flagless, adminId],
      )
      await client.query(
         'INSERT INTO course_teachers (course_id, user_id, can_view_results, assigned_by) VALUES ($1, $2, TRUE, $3)',
         [courseId, courseTeacher, adminId],
      )
      assert.equal((await grant(teacher, quiz, ownAssignment, learner)).extraAttempts, 1)
      assert.equal((await getExtraAttemptsService(teacher, quiz.id, ownAssignment.id, learner)).grants.length, 1)
      await rejects(grant(teacher, quiz, foreignAssignment, stranger), 'ASSIGNMENT_NOT_FOUND')
      await rejects(grant(teacher, quiz, direct, learner), 'ASSIGNMENT_NOT_FOUND')
      await rejects(grant(flagless, quiz, ownAssignment, learner), 'ASSIGNMENT_NOT_FOUND')
      await rejects(grant(courseTeacher, quiz, ownAssignment, learner), 'ASSIGNMENT_NOT_FOUND')
      await rejects(getExtraAttemptsService(teacher, quiz.id, foreignAssignment.id, stranger), 'ASSIGNMENT_NOT_FOUND')
      assert.deepEqual(await grantRows(foreignAssignment.id), [])
   })

   await t.test('parallel grants and starts never exceed the effective limit', async () => {
      const quiz = await publishedTest()
      const learner = await student()
      const assignment = await createAssignmentService(adminId, quiz.id, { userId: learner })
      await finish(learner, assignment.id)
      const outcomes = await Promise.allSettled([
         grant(adminId, quiz, assignment, learner),
         ...[1, 2, 3, 4].map(() => startAttemptService(learner, assignment.id)),
      ])
      assert.equal(outcomes[0].status, 'fulfilled')
      for (const outcome of outcomes.slice(1)) {
         if (outcome.status === 'rejected') assert.equal(outcome.reason.code, 'ATTEMPTS_EXHAUSTED')
      }
      const count = async () => (await client.query(
         'SELECT count(*)::integer AS total FROM test_attempts WHERE assignment_id = $1 AND user_id = $2',
         [assignment.id, learner],
      )).rows[0].total
      // Starts that ran before the grant are refused; at most one extra attempt exists.
      assert.ok(await count() <= 2)
      await startAttemptService(learner, assignment.id)
      await startAttemptService(learner, assignment.id)
      assert.equal(await count(), 2)

      const many = await Promise.all([1, 2, 3].map(() => grant(adminId, quiz, assignment, learner)))
      assert.ok(many.every((state) => state.extraAttempts >= 2))
      assert.equal((await getExtraAttemptsService(adminId, quiz.id, assignment.id, learner)).extraAttempts, 4)
   })

   await t.test('keys stay hidden while granted attempts remain', async () => {
      const quiz = await publishedTest({ answerRevealPolicy: 'after_submission' })
      const learner = await student()
      const assignment = await createAssignmentService(adminId, quiz.id, { userId: learner })
      const first = await finish(learner, assignment.id)
      assert.equal(first.revealed, true)
      assert.deepEqual(first.questions[0].correctAnswer, { optionKey: 'A' })

      await grant(adminId, quiz, assignment, learner)
      const held = await getAttemptResultService(learner, first.attempt.id)
      assert.equal(held.revealed, false)
      assert.equal(held.remainingAttempts, 1)
      assert.ok(!/correctAnswer|explanation|Because/.test(JSON.stringify(held)))
      const { rows } = await client.query('SELECT policy_snapshot FROM test_attempts WHERE id = $1', [first.attempt.id])
      assert.equal(rows[0].policy_snapshot.maxAttempts, 1, 'the snapshot is not rewritten')

      const last = await finish(learner, assignment.id)
      assert.equal(last.revealed, true)
      assert.equal((await getAttemptResultService(learner, first.attempt.id)).revealed, true)
   })

   await t.test('the HTTP routes check the permission and CSRF-free Bearer sessions', async () => {
      const app = createApp({
         telegramAuth: { config }, passwordAuth: { config }, authProtection: { config }, authorization: {},
      })
      const server = await new Promise((resolve) => {
         const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
      })
      t.after(() => new Promise((resolve) => { server.close(resolve) }))
      const { port } = server.address()
      const session = (userId) => withTransaction((transactionClient) => issueSessionService({
         userId,
         requestContext: { userAgent: 'Extra attempts integration', ipAddress: '127.0.0.1' },
         client: transactionClient,
      }, { config }))
      async function api(method, path, actor, body) {
         const headers = { 'content-type': 'application/json' }
         if (actor) headers.authorization = `Bearer ${actor.accessToken}`
         const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
            method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
         })
         return { status: response.status, body: await response.json() }
      }

      const quiz = await publishedTest()
      const learner = await student()
      const groupId = await group([learner])
      const assignment = await createAssignmentService(adminId, quiz.id, { groupId })
      const teacher = await createUser('teacher')
      await client.query(
         'INSERT INTO group_teachers (group_id, user_id, can_view_results, assigned_by) VALUES ($1, $2, TRUE, $3)',
         [groupId, teacher, adminId],
      )
      const path = `/admin/tests/${quiz.id}/assignments/${assignment.id}/users/${learner}/extra-attempts`
      const body = { count: 1, reason: 'HTTP', idempotencyKey: `http-${suffix}` }

      assert.equal((await api('POST', path, null, body)).status, 401)
      assert.equal((await api('POST', path, await session(learner), body)).status, 403)
      assert.equal((await api('POST', path, await session(teacher), body)).status, 403)
      const admin = await session(adminId)
      const granted = await api('POST', path, admin, body)
      assert.equal(granted.status, 200, JSON.stringify(granted.body))
      assert.equal(granted.body.data.effectiveMaxAttempts, 2)
      assert.equal((await api('POST', path, admin, body)).body.data.extraAttempts, 1)
      const read = await api('GET', path, admin)
      assert.equal(read.status, 200)
      assert.equal(read.body.data.grants.length, 1)
      assert.equal((await api('GET', path, await session(learner))).status, 403)
      const invalid = await api('POST', path, admin, { ...body, count: 0, idempotencyKey: `zero-${suffix}` })
      assert.equal(invalid.status, 400)
      assert.equal(invalid.body.error.code, 'VALIDATION_ERROR')
   })
})
