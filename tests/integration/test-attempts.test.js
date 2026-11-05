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
   getAttemptService,
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
   updateAssignmentService,
} from '../../src/services/test-service.js'

const { Client } = pg
const config = {
   ...env,
   jwtAccessSecret: 'test-attempts-integration-secret-longer-than-32-chars',
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

test('test attempts integration', async (t) => {
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
      code: `att-${suffix}`,
      primaryLanguage: 'en',
      translations: { en: { title: 'Attempts' } },
   })
   const courseRow = await client.query(
      `INSERT INTO courses (title, subject_id, status, created_by)
       VALUES ($1, $2, 'published', $3) RETURNING id`,
      [`Attempts ${suffix}`, subject.id, adminId],
   )
   const courseId = courseRow.rows[0].id
   const moduleRow = await client.query(
      `INSERT INTO course_modules (course_id, title, position, status)
       VALUES ($1, 'Module', 1, 'published') RETURNING id`,
      [courseId],
   )
   const moduleId = moduleRow.rows[0].id
   const bank = await createQuestionBankService(adminId, {
      code: `att-bank-${suffix}`, title: 'Attempts', subjectId: subject.id, visibility: 'staff',
   })

   async function question(type, extra, answerData) {
      const created = await createQuestionService(adminId, bank.id, {
         questionType: type,
         languageCode: 'en',
         content: text(`Question ${type}`),
         ...extra,
      })
      await replaceAnswerKeyService(adminId, created.id, {
         answerData,
         source: 'expert_review',
         explanation: text(`Because ${type}`),
      })
      await verifyAnswerKeyService(adminId, created.id, { source: 'expert_review' })
      await publishQuestionService(adminId, created.id)
      return created.id
   }

   const choiceOptions = {
      options: [{ key: 'A', content: text('Right') }, { key: 'B', content: text('Wrong') }, { key: 'C', content: text('Other') }],
   }
   const singleId = await question('single_choice', choiceOptions, { optionKey: 'A' })
   const multipleId = await question('multiple_choice', choiceOptions, { optionKeys: ['A', 'C'] })
   const matchingId = await question('matching', {
      matching: {
         left: [{ key: 'L1', content: text('One') }, { key: 'L2', content: text('Two') }],
         right: [{ key: 'R1', content: text('1') }, { key: 'R2', content: text('2') }],
      },
      interactionSettings: { requireAllLeft: true, allowRightReuse: false },
   }, { pairs: [{ left: 'L1', right: 'R1' }, { left: 'L2', right: 'R2' }] })
   const numericId = await question('numeric', {}, { value: 42 })
   const textId = await question('short_text', {}, { acceptedAnswers: ['Mitosis'] })
   const allQuestions = [singleId, multipleId, matchingId, numericId, textId]

   let titleIndex = 0
   async function publishedTest(settings = {}, questionIds = [singleId]) {
      titleIndex += 1
      const created = await createTestService(adminId, {
         courseId,
         title: `Test ${titleIndex} ${suffix}`,
         mode: 'practice',
         maxAttempts: null,
         ...settings,
      })
      await addTestQuestionsService(adminId, created.id, {
         questions: questionIds.map((questionId) => ({ questionId, points: '2' })),
      })
      await publishTestService(adminId, created.id)
      return created
   }

   async function student() {
      const id = await createUser('student')
      await grantCourseEnrollmentService(adminId, courseId, { userId: id, expiresAt: null })
      return id
   }

   async function assign(testId, userId, extra = {}) {
      return createAssignmentService(adminId, testId, { userId, ...extra })
   }

   async function attemptStatus(attemptId) {
      const { rows } = await client.query('SELECT status FROM test_attempts WHERE id = $1', [attemptId])
      return rows[0].status
   }

   async function solve(learner, view) {
      for (const item of view.questions) {
         await saveAnswerService(learner, view.attempt.id, item.id, { answer: { optionKey: 'A' }, revision: 1 })
      }
   }

   await t.test('access needs enrollment, module grant and an audience', async () => {
      const learner = await createUser('student')
      const moduleTest = await publishedTest({ moduleId })
      const enrolled = await student()
      const assignment = await assign(moduleTest.id, enrolled)

      await rejects(startAttemptService(learner, assignment.id), 'ASSIGNMENT_NOT_FOUND')
      await rejects(startAttemptService(enrolled, assignment.id), 'MODULE_ACCESS_DENIED')
      await grantModuleAccessService(adminId, courseId, enrolled, { moduleId, expiresAt: null })
      const view = await startAttemptService(enrolled, assignment.id)
      assert.equal(view.resumed, false)
      assert.equal(view.attempt.status, 'in_progress')

      await client.query(
         'UPDATE course_enrollments SET revoked_at = CURRENT_TIMESTAMP, revoked_by = $2 WHERE user_id = $1',
         [enrolled, adminId],
      )
      await rejects(startAttemptService(enrolled, assignment.id), 'COURSE_ENROLLMENT_REQUIRED')
      await rejects(getAttemptService(enrolled, view.attempt.id), 'COURSE_ENROLLMENT_REQUIRED')
      await rejects(saveAnswerService(enrolled, view.attempt.id, view.questions[0].id, {
         answer: null, revision: 1,
      }), 'COURSE_ENROLLMENT_REQUIRED')
   })

   await t.test('group assignments need an active membership', async () => {
      const learner = await student()
      const quiz = await publishedTest()
      const group = await client.query(
         `INSERT INTO groups (code, title, created_by) VALUES ($1, 'Group', $2) RETURNING id`,
         [`att-group-${suffix}`, adminId],
      )
      const groupId = group.rows[0].id
      const assignment = await createAssignmentService(adminId, quiz.id, { groupId })
      await rejects(startAttemptService(learner, assignment.id), 'ASSIGNMENT_NOT_FOUND')
      await client.query(
         'INSERT INTO group_members (group_id, user_id, added_by) VALUES ($1, $2, $3)',
         [groupId, learner, adminId],
      )
      const { assignments } = await listMyAssignmentsService(learner, courseId)
      assert.ok(assignments.some((item) => item.id === assignment.id))
      assert.equal((await startAttemptService(learner, assignment.id)).attempt.assignmentId, assignment.id)
      await client.query(`UPDATE group_members SET status = 'left', left_at = CURRENT_TIMESTAMP WHERE user_id = $1`, [learner])
      // The running attempt continues; only a new one is refused.
      const running = await startAttemptService(learner, assignment.id)
      assert.equal(running.resumed, true)
      await submitAttemptService(learner, running.attempt.id)
      await rejects(startAttemptService(learner, assignment.id), 'ASSIGNMENT_NOT_FOUND')
   })

   await t.test('the assignment window is enforced', async () => {
      const learner = await student()
      const quiz = await publishedTest()
      const assignment = await assign(quiz.id, learner, {
         opensAt: later(60).toISOString(),
         closesAt: later(120).toISOString(),
      })
      await rejects(startAttemptService(learner, assignment.id), 'ASSIGNMENT_NOT_OPEN')
      await rejects(startAttemptService(learner, assignment.id, at(121)), 'ASSIGNMENT_CLOSED')
      const open = await startAttemptService(learner, assignment.id, at(61))
      assert.equal(open.attempt.deadlineAt, new Date(assignment.closesAt).toISOString())
      await client.query(`UPDATE test_assignments SET status = 'revoked' WHERE id = $1`, [assignment.id])
      // Revoking does not stop the running attempt: it can be resumed, answered and submitted.
      const resumed = await startAttemptService(learner, assignment.id, at(62))
      assert.equal(resumed.resumed, true)
      await saveAnswerService(learner, open.attempt.id, open.questions[0].id, {
         answer: { optionKey: 'A' }, revision: 1,
      }, at(62))
      assert.equal((await submitAttemptService(learner, open.attempt.id, at(63))).attempt.score, '2.00')
      await rejects(startAttemptService(learner, assignment.id, at(64)), 'ASSIGNMENT_NOT_FOUND')
   })

   await t.test('the deadline takes the earliest of limit, window and personal window', async () => {
      const learner = await student()
      const quiz = await publishedTest({ timeLimitMinutes: 60 })
      const closesAt = later(600)
      const assignment = await assign(quiz.id, learner, {
         // The same instant written in Dushanbe time; storage is zone independent.
         closesAt: new Date(closesAt.getTime() + 5 * 3600000).toISOString().replace('Z', '+05:00'),
         personalWindowMinutes: 30,
      })
      assert.equal(assignment.personalWindowMinutes, 30)
      const before = Date.now()
      const first = await startAttemptService(learner, assignment.id)
      const deadline = new Date(first.attempt.deadlineAt).getTime()
      assert.ok(deadline >= before + 30 * minute - 1000 && deadline <= Date.now() + 30 * minute + 1000)
      assert.ok(first.serverNow)

      // A later attempt shares the personal window that began at the first start.
      await submitAttemptService(learner, first.attempt.id)
      const second = await startAttemptService(learner, assignment.id, at(10))
      assert.equal(second.attempt.attemptNumber, 2)
      assert.equal(second.attempt.deadlineAt, first.attempt.deadlineAt)
      await submitAttemptService(learner, second.attempt.id, at(11))
      await rejects(startAttemptService(learner, assignment.id, at(31)), 'PERSONAL_WINDOW_ENDED')

      const patched = await updateAssignmentService(adminId, quiz.id, assignment.id, { personalWindowMinutes: 45 })
      assert.equal(patched.personalWindowMinutes, 45)
      const cleared = await updateAssignmentService(adminId, quiz.id, assignment.id, { personalWindowMinutes: null })
      assert.equal(cleared.personalWindowMinutes, null)
      await rejects(updateAssignmentService(adminId, quiz.id, assignment.id, { personalWindowMinutes: 0 }), 'VALIDATION_ERROR')
   })

   await t.test('starting again resumes, with a stable order', async () => {
      const learner = await student()
      const quiz = await publishedTest({ shuffleQuestions: true, shuffleOptions: true }, allQuestions)
      const assignment = await assign(quiz.id, learner)
      const reverse = { shuffle: (values) => [...values].reverse() }
      const first = await startAttemptService(learner, assignment.id, reverse)
      assert.equal(first.questions[0].questionType, 'short_text')
      assert.deepEqual(first.questions[4].options.map((option) => option.key), ['C', 'B', 'A'])
      const second = await startAttemptService(learner, assignment.id)
      assert.equal(second.resumed, true)
      assert.equal(second.attempt.id, first.attempt.id)
      assert.deepEqual(second.questions, first.questions)
      const serialized = JSON.stringify(first)
      assert.ok(!serialized.includes('acceptedAnswers') && !serialized.includes('Because'))
   })

   await t.test('concurrent starts create one attempt', async () => {
      const learner = await student()
      const quiz = await publishedTest()
      const assignment = await assign(quiz.id, learner)
      const views = await Promise.all([1, 2, 3].map(() => startAttemptService(learner, assignment.id)))
      assert.equal(new Set(views.map((view) => view.attempt.id)).size, 1)
   })

   await t.test('max attempts are respected', async () => {
      const learner = await student()
      const quiz = await publishedTest({ maxAttempts: 2 })
      const assignment = await assign(quiz.id, learner)
      for (const number of [1, 2]) {
         const view = await startAttemptService(learner, assignment.id)
         assert.equal(view.attempt.attemptNumber, number)
         await submitAttemptService(learner, view.attempt.id)
      }
      await rejects(startAttemptService(learner, assignment.id), 'ATTEMPTS_EXHAUSTED')
      const { assignments } = await listMyAssignmentsService(learner, courseId)
      assert.equal(assignments.find((item) => item.id === assignment.id).attempts.remainingAttempts, 0)
   })

   await t.test('autosave is revisioned and idempotent', async () => {
      const learner = await student()
      const quiz = await publishedTest()
      const assignment = await assign(quiz.id, learner)
      const view = await startAttemptService(learner, assignment.id)
      const [item] = view.questions
      const save = (answer, revision) => saveAnswerService(learner, view.attempt.id, item.id, { answer, revision })

      await rejects(save({ optionKey: 'A' }, 0), 'VALIDATION_ERROR')
      await rejects(save({ optionKey: 'Z' }, 1), 'VALIDATION_ERROR')
      assert.equal((await save({ optionKey: 'A' }, 1)).revision, 1)
      assert.equal((await save({ optionKey: 'A' }, 1)).revision, 1)
      await rejects(save({ optionKey: 'B' }, 1), 'ANSWER_REVISION_CONFLICT')
      assert.equal((await save({ optionKey: 'B' }, 3)).revision, 3)
      await rejects(save({ optionKey: 'A' }, 2), 'ANSWER_REVISION_CONFLICT')
      const resumed = await getAttemptService(learner, view.attempt.id)
      assert.deepEqual(resumed.questions[0].answer, { optionKey: 'B' })
      assert.equal(resumed.questions[0].revision, 3)

      const other = await student()
      await rejects(getAttemptService(other, view.attempt.id), 'ATTEMPT_NOT_FOUND')
      await rejects(saveAnswerService(other, view.attempt.id, item.id, { answer: null, revision: 9 }), 'ATTEMPT_NOT_FOUND')

      await submitAttemptService(learner, view.attempt.id)
      await rejects(save({ optionKey: 'A' }, 4), 'ATTEMPT_NOT_IN_PROGRESS')
   })

   await t.test('an answer after the deadline is rejected and the attempt is auto-submitted', async () => {
      const learner = await student()
      const quiz = await publishedTest({ timeLimitMinutes: 10 })
      const assignment = await assign(quiz.id, learner)
      const view = await startAttemptService(learner, assignment.id)
      await saveAnswerService(learner, view.attempt.id, view.questions[0].id, { answer: { optionKey: 'A' }, revision: 1 })
      await rejects(saveAnswerService(learner, view.attempt.id, view.questions[0].id, {
         answer: { optionKey: 'B' }, revision: 2,
      }, at(11)), 'ATTEMPT_DEADLINE_PASSED')
      assert.equal(await attemptStatus(view.attempt.id), 'expired')
      const result = await getAttemptResultService(learner, view.attempt.id)
      assert.equal(result.attempt.autoSubmitted, true)
      assert.equal(result.attempt.score, '2.00')
      assert.equal(result.attempt.submittedAt, view.attempt.deadlineAt)
   })

   await t.test('an expired attempt is submitted on next access and by the sweep', async () => {
      const learner = await student()
      const quiz = await publishedTest({ timeLimitMinutes: 10 })
      const first = await assign(quiz.id, learner)
      const view = await startAttemptService(learner, first.id)
      const seen = await getAttemptService(learner, view.attempt.id, at(11))
      assert.equal(seen.attempt.status, 'expired')
      assert.deepEqual(seen.questions, [])

      const swept = await student()
      const second = await assign(quiz.id, swept)
      const other = await startAttemptService(swept, second.id)
      const worker = startAttemptSweepWorker({ intervalMs: 5, overrides: at(11) })
      for (let tries = 0; tries < 200 && await attemptStatus(other.attempt.id) !== 'expired'; tries += 1) {
         await new Promise((resolve) => { setTimeout(resolve, 10) })
      }
      await worker.stop()
      assert.equal(await attemptStatus(other.attempt.id), 'expired')
      const audit = await client.query(
         `SELECT count(*)::integer AS total FROM audit_events
          WHERE event_code = 'test.attempt_expired' AND subject_user_id = $1`,
         [swept],
      )
      assert.equal(audit.rows[0].total, 1)
   })

   await t.test('every question type is graded from the verified keys', async () => {
      const learner = await student()
      const quiz = await publishedTest({}, allQuestions)
      const assignment = await assign(quiz.id, learner)
      const view = await startAttemptService(learner, assignment.id)
      const byType = new Map(view.questions.map((item) => [item.questionType, item]))
      const answers = {
         single_choice: { optionKey: 'A' },
         multiple_choice: { optionKeys: ['C', 'A'] },
         matching: { pairs: [{ left: 'L1', right: 'R1' }, { left: 'L2', right: 'R1' }].slice(0, 1) },
         numeric: { value: 42 },
         short_text: { text: ' mitosis ' },
      }
      for (const [type, answer] of Object.entries(answers)) {
         await saveAnswerService(learner, view.attempt.id, byType.get(type).id, { answer, revision: 1 })
      }
      const result = await submitAttemptService(learner, view.attempt.id)
      assert.equal(result.attempt.status, 'graded')
      assert.equal(result.attempt.maxScore, '10.00')
      // Eight points for four full answers, one of two pairs for the matching question.
      assert.equal(result.attempt.score, '9.00')
      assert.equal(result.percent, 90)
      const again = await submitAttemptService(learner, view.attempt.id)
      assert.equal(again.attempt.submittedAt, result.attempt.submittedAt)
   })

   await t.test('result policies choose the attempt shown', async () => {
      for (const [resultPolicy, expected] of [['first', '0.00'], ['best', '2.00'], ['last', '0.00']]) {
         const learner = await student()
         const quiz = await publishedTest({ resultPolicy })
         const assignment = await assign(quiz.id, learner)
         for (const answer of ['B', 'A', 'B']) {
            const view = await startAttemptService(learner, assignment.id)
            await saveAnswerService(learner, view.attempt.id, view.questions[0].id, {
               answer: { optionKey: answer }, revision: 1,
            })
            await submitAttemptService(learner, view.attempt.id)
         }
         const result = await getAssignmentResultService(learner, assignment.id)
         assert.equal(result.score, expected, resultPolicy)
         assert.equal(result.attempts.length, 3)
      }
   })

   await t.test('reveal policies decide what the result returns', async () => {
      const learner = await student()
      const immediate = await publishedTest({ answerRevealPolicy: 'after_submission', maxAttempts: 1 })
      const openAssignment = await assign(immediate.id, learner)
      const openView = await startAttemptService(learner, openAssignment.id)
      await rejects(getAttemptResultService(learner, openView.attempt.id), 'RESULT_NOT_READY')
      const shown = await submitAttemptService(learner, openView.attempt.id)
      assert.equal(shown.revealed, true)
      assert.deepEqual(shown.questions[0].correctAnswer, { optionKey: 'A' })
      assert.deepEqual(shown.questions[0].explanation, text('Because single_choice'))

      const hidden = await publishedTest({ answerRevealPolicy: 'never' })
      const hiddenAssignment = await assign(hidden.id, learner)
      const hiddenView = await startAttemptService(learner, hiddenAssignment.id)
      const secret = await submitAttemptService(learner, hiddenView.attempt.id)
      assert.equal(secret.revealed, false)
      assert.deepEqual(secret.questions, [])
      assert.ok(!JSON.stringify(secret).includes('correctAnswer'))

      const windowed = await publishedTest({ answerRevealPolicy: 'after_window' })
      const closesAt = later(60)
      const windowAssignment = await assign(windowed.id, learner, { closesAt: closesAt.toISOString() })
      const windowView = await startAttemptService(learner, windowAssignment.id)
      const early = await submitAttemptService(learner, windowView.attempt.id)
      assert.equal(early.revealed, false)
      assert.equal(early.revealsAt, closesAt.toISOString())
      const late = await getAttemptResultService(learner, windowView.attempt.id, at(61))
      assert.equal(late.revealed, true)
      assert.equal(late.questions.length, 1)
   })

   await t.test('after_submission holds keys back while attempts remain', async () => {
      const learner = await student()
      const quiz = await publishedTest({ answerRevealPolicy: 'after_submission', maxAttempts: 2 })
      const assignment = await assign(quiz.id, learner)
      const first = await startAttemptService(learner, assignment.id)
      const early = await submitAttemptService(learner, first.attempt.id)
      assert.equal(early.revealed, false)
      assert.equal(early.remainingAttempts, 1)
      assert.deepEqual(early.questions, [])
      assert.ok(early.attempt.score !== null)

      const second = await startAttemptService(learner, assignment.id)
      const last = await submitAttemptService(learner, second.attempt.id)
      assert.equal(last.revealed, true)
      assert.equal(last.questions.length, 1)
      // The first attempt is revealed too once no attempt is left.
      assert.equal((await getAttemptResultService(learner, first.attempt.id)).revealed, true)

      const windowed = await publishedTest({ answerRevealPolicy: 'after_submission', maxAttempts: 3 })
      const closesAt = later(60)
      const windowAssignment = await assign(windowed.id, learner, { closesAt: closesAt.toISOString() })
      const view = await startAttemptService(learner, windowAssignment.id)
      const held = await submitAttemptService(learner, view.attempt.id)
      assert.equal(held.revealed, false)
      assert.equal(held.revealsAt, closesAt.toISOString())
      assert.equal((await getAttemptResultService(learner, view.attempt.id, at(61))).revealed, true)

      const unlimited = await publishedTest({ answerRevealPolicy: 'after_submission', maxAttempts: null })
      const open = await assign(unlimited.id, learner)
      const unlimitedView = await startAttemptService(learner, open.id)
      const result = await submitAttemptService(learner, unlimitedView.attempt.id)
      assert.equal(result.revealed, false)
      assert.equal(result.remainingAttempts, null)
   })

   await t.test('group teachers see only attempts of their group assignments', async () => {
      const quiz = await publishedTest()
      const group = await client.query(
         `INSERT INTO groups (code, title, created_by) VALUES ($1, 'Results group', $2) RETURNING id`,
         [`att-results-${suffix}`, adminId],
      )
      const groupId = group.rows[0].id
      const member = await student()
      const outsider = await student()
      await client.query('INSERT INTO group_members (group_id, user_id, added_by) VALUES ($1, $2, $3)', [groupId, member, adminId])
      const groupAssignment = await createAssignmentService(adminId, quiz.id, { groupId })
      const directAssignment = await assign(quiz.id, outsider)
      const inGroup = await startAttemptService(member, groupAssignment.id)
      const direct = await startAttemptService(outsider, directAssignment.id)

      const groupTeacher = await createUser('teacher')
      const flagless = await createUser('teacher')
      await client.query(
        `INSERT INTO group_teachers (group_id, user_id, can_view_results, assigned_by)
          VALUES ($1, $2, TRUE, $4), ($1, $3, FALSE, $4)`,
         [groupId, groupTeacher, flagless, adminId],
      )
      const seen = await listTestAttemptsService(groupTeacher, quiz.id)
      assert.deepEqual(seen.attempts.map((item) => item.id), [inGroup.attempt.id])
      assert.equal((await getTestAttemptService(groupTeacher, quiz.id, inGroup.attempt.id)).attempt.userId, member)
      await rejects(getTestAttemptService(groupTeacher, quiz.id, direct.attempt.id), 'ATTEMPT_NOT_FOUND')
      await rejects(listTestAttemptsService(flagless, quiz.id), 'TEST_NOT_FOUND')

      await submitAttemptService(member, inGroup.attempt.id)
      await submitAttemptService(outsider, direct.attempt.id)
      const request = (attemptQuestionId) => ({
         reason: 'Group review', idempotencyKey: `group-${attemptQuestionId}-${suffix}`,
         overrides: [{ attemptQuestionId, points: '1' }],
      })
      await rejects(regradeAttemptService(groupTeacher, quiz.id, direct.attempt.id, request(direct.questions[0].id)), 'ATTEMPT_NOT_FOUND')
      assert.equal((await regradeAttemptService(groupTeacher, quiz.id, inGroup.attempt.id, request(inGroup.questions[0].id))).attempt.score, '1.00')
   })

   await t.test('the lesson summary shows the attempt state', async () => {
      const learner = await student()
      await grantModuleAccessService(adminId, courseId, learner, { moduleId, expiresAt: null })
      const quiz = await publishedTest({ maxAttempts: 2 })
      const lesson = await createLessonService(adminId, courseId, moduleId, {
         title: `Quiz ${suffix}`, lessonType: 'test', testId: quiz.id,
      })
      await publishLessonService(adminId, courseId, lesson.id)
      const read = async () => (await getLearnerLessonService(learner, courseId, lesson.id)).lesson.test
      const assignment = await assign(quiz.id, learner, { closesAt: later(60).toISOString() })

      assert.equal((await read()).attempts.status, 'not_started')
      assert.equal((await read()).attempts.remainingAttempts, 2)
      const view = await startAttemptService(learner, assignment.id)
      const running = (await read()).attempts
      assert.equal(running.status, 'in_progress')
      assert.equal(running.deadlineAt, view.attempt.deadlineAt)
      assert.equal(running.remainingAttempts, 1)
      await solve(learner, view)
      await submitAttemptService(learner, view.attempt.id)
      const done = (await read()).attempts
      assert.equal(done.status, 'submitted')
      assert.equal(done.score, '2.00')
      const forLesson = await listMyAssignmentsService(learner, courseId, { lessonId: lesson.id })
      assert.deepEqual(forLesson.assignments.map((item) => item.id), [assignment.id])
   })

   await t.test('staff see results in scope and regrade with revisions', async () => {
      const learner = await student()
      const quiz = await publishedTest({}, [singleId, numericId])
      const assignment = await assign(quiz.id, learner)
      const view = await startAttemptService(learner, assignment.id)
      const attemptId = view.attempt.id

      const reader = await createUser('teacher')
      const stranger = await createUser('teacher')
      const contentOnly = await createUser('teacher')
      await client.query(
         `INSERT INTO course_teachers (course_id, user_id, can_view_results, assigned_by)
          VALUES ($1, $2, TRUE, $4), ($1, $3, FALSE, $4)`,
         [courseId, reader, contentOnly, adminId],
      )
      await rejects(listTestAttemptsService(stranger, quiz.id), 'TEST_NOT_FOUND')
      await rejects(listTestAttemptsService(contentOnly, quiz.id), 'TEST_NOT_FOUND')
      await rejects(getTestAttemptService(stranger, quiz.id, attemptId), 'TEST_NOT_FOUND')

      const listed = await listTestAttemptsService(reader, quiz.id, { assignmentId: assignment.id })
      assert.deepEqual(listed.attempts.map((item) => item.id), [attemptId])
      assert.equal((await listTestAttemptsService(reader, quiz.id, { status: 'graded' })).attempts.length, 0)
      await rejects(listTestAttemptsService(reader, quiz.id, { status: 'nope' }), 'VALIDATION_ERROR')

      const request = (idempotencyKey, points = '1.50') => ({
         reason: 'Accepted an equivalent answer',
         idempotencyKey,
         overrides: [{ attemptQuestionId: view.questions[0].id, points }],
      })
      await rejects(regradeAttemptService(reader, quiz.id, attemptId, request(`early-${suffix}`)), 'ATTEMPT_NOT_FINISHED')
      await submitAttemptService(learner, attemptId)
      await rejects(regradeAttemptService(stranger, quiz.id, attemptId, request(`deny-${suffix}`)), 'TEST_NOT_FOUND')
      await rejects(regradeAttemptService(reader, quiz.id, attemptId, request(`big-${suffix}`, '2.01')), 'VALIDATION_ERROR')

      const key = `regrade-${suffix}`
      const regraded = await regradeAttemptService(reader, quiz.id, attemptId, request(key))
      assert.equal(regraded.attempt.score, '1.50')
      assert.equal(regraded.revisions.length, 1)
      assert.equal(regraded.revisions[0].previousScore, '0.00')
      assert.equal(regraded.revisions[0].newScore, '1.50')
      assert.equal(regraded.questions[0].gradingStatus, 'manual')
      assert.ok(!JSON.stringify(regraded).includes('answerData'))

      const repeated = await regradeAttemptService(reader, quiz.id, attemptId, request(key, '2.00'))
      assert.equal(repeated.attempt.score, '1.50')
      assert.equal(repeated.revisions.length, 1)
      const result = await getAttemptResultService(learner, attemptId)
      assert.equal(result.attempt.score, '1.50')
   })

   await t.test('the HTTP routes enforce sessions and permissions and never send keys', async () => {
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
         requestContext: { userAgent: 'M11 integration', ipAddress: '127.0.0.1' },
         client: transactionClient,
      }, { config }))
      async function api(method, path, actor, body) {
         const headers = { 'content-type': 'application/json' }
         if (actor) headers.authorization = `Bearer ${actor.accessToken}`
         const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
            method,
            headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
         })
         return { status: response.status, body: await response.json() }
      }

      const learner = await student()
      const quiz = await publishedTest({}, allQuestions)
      const assignment = await assign(quiz.id, learner)
      const actor = await session(learner)
      const start = `/tests/assignments/${assignment.id}/start`

      assert.equal((await api('POST', start)).status, 401)
      const started = await api('POST', start, actor)
      assert.equal(started.status, 201)
      assert.ok(started.body.data.serverNow)
      const body = JSON.stringify(started.body)
      assert.ok(!/acceptedAnswers|answerData|grading_snapshot|Because|"pairs"/.test(body))
      assert.equal((await api('POST', start, actor)).status, 200)

      const { id: attemptId } = started.body.data.attempt
      const [item] = started.body.data.questions
      const saved = await api('PUT', `/tests/attempts/${attemptId}/answers/${item.id}`, actor, {
         answer: { optionKey: 'A' },
         revision: 1,
      })
      assert.equal(saved.status, 200)
      assert.equal(saved.body.data.revision, 1)
      assert.equal((await api('GET', `/tests/attempts/${attemptId}/result`, actor)).body.error.code, 'RESULT_NOT_READY')
      assert.equal((await api('POST', `/tests/attempts/${attemptId}/submit`, actor)).status, 200)
      assert.equal((await api('GET', `/tests/assignments/${assignment.id}/result`, actor)).status, 200)
      assert.equal((await api('GET', `/courses/${courseId}/test-assignments`, actor)).status, 200)

      const forbidden = await api('GET', `/admin/tests/${quiz.id}/attempts`, actor)
      assert.equal(forbidden.status, 403)
      // Regrade is a separate permission held by owner and admin only.
      const teacher = await createUser('teacher')
      await client.query(
         'INSERT INTO course_teachers (course_id, user_id, can_view_results, assigned_by) VALUES ($1, $2, TRUE, $3)',
         [courseId, teacher, adminId],
      )
      const teacherSession = await session(teacher)
      assert.equal((await api('GET', `/admin/tests/${quiz.id}/attempts`, teacherSession)).status, 200)
      const denied = await api('POST', `/admin/tests/${quiz.id}/attempts/${attemptId}/regrade`, teacherSession, {
         reason: 'No', idempotencyKey: `denied-${suffix}`, overrides: [{ attemptQuestionId: item.id, points: '1' }],
      })
      assert.equal(denied.status, 403)
      const admin = await session(adminId)
      const listed = await api('GET', `/admin/tests/${quiz.id}/attempts?assignmentId=${assignment.id}`, admin)
      assert.equal(listed.status, 200)
      assert.equal(listed.body.data.attempts.length, 1)
      assert.equal((await api('GET', `/admin/tests/${quiz.id}/attempts/${attemptId}`, admin)).status, 200)
      const regrade = await api('POST', `/admin/tests/${quiz.id}/attempts/${attemptId}/regrade`, admin, {
         reason: 'Review',
         idempotencyKey: `http-${suffix}`,
         overrides: [{ attemptQuestionId: item.id, points: '1' }],
      })
      assert.equal(regrade.status, 200, JSON.stringify(regrade.body))
   })
})
