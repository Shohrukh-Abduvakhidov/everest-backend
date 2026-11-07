import assert from 'node:assert/strict'
import test from 'node:test'

import { courseProgress } from '../../src/services/learner-course-service.js'
import { listLearnerLessonsService } from '../../src/services/learner-lesson-service.js'
import {
   attemptCompletesLesson,
   completeTestLessonsService,
} from '../../src/services/lesson-completion-service.js'
import {
   getAssignmentResultService,
   getAttemptResultService,
   listMyAssignmentsService,
} from '../../src/services/test-attempt-service.js'
import { listTestAttemptsService } from '../../src/services/test-results-service.js'

const client = { fake: true }
const now = new Date('2026-11-07T10:00:00.000Z')

test('the completion rule follows the owner decision', () => {
   const rule = (extra) => attemptCompletesLesson({
      status: 'graded', score: '5.00', maxScore: '10.00', passPercent: null, answered: true, ...extra,
   })
   assert.equal(rule({}), true, 'no passPercent: any finished attempt')
   assert.equal(rule({ score: '0.00' }), true, 'no passPercent: even a zero score')
   assert.equal(rule({ passPercent: 50 }), true, 'exactly at the threshold passes')
   assert.equal(rule({ passPercent: 50.01 }), false)
   assert.equal(rule({ passPercent: 0, score: '0.00' }), true)
   assert.equal(rule({ status: 'expired', answered: false }), false, 'timer, no answer')
   assert.equal(rule({ status: 'expired', answered: false, passPercent: 0 }), false)
   assert.equal(rule({ status: 'expired', answered: true }), true)
   assert.equal(rule({ status: 'in_progress' }), false)
   assert.equal(rule({ status: 'cancelled' }), false)
   assert.equal(rule({ passPercent: 10, maxScore: '0.00' }), false)
})

function completionDoubles({ answered = true } = {}) {
   const calls = { answered: 0, completed: [] }
   return {
      calls,
      overrides: {
         attempts: { hasSavedAnswer: async (_id, db) => { assert.equal(db, client); calls.answered += 1; return answered } },
         learner: {
            completeTestLessons: async (values, db) => {
               assert.equal(db, client)
               calls.completed.push(values)
               return ['7']
            },
         },
      },
   }
}

const attempt = (extra = {}) => ({
   id: '1', user_id: '2', test_id: '3', status: 'graded', score: '4.00', max_score: '4.00',
   policy_snapshot: { passPercent: null }, ...extra,
})

test('completion writes through the caller client and checks answers only on expiry', async () => {
   const graded = completionDoubles()
   assert.deepEqual(await completeTestLessonsService({ attempt: attempt(), completedAt: now }, client, graded.overrides), ['7'])
   assert.equal(graded.calls.answered, 0)
   assert.deepEqual(graded.calls.completed, [{ userId: '2', testId: '3', completedAt: now }])

   const empty = completionDoubles({ answered: false })
   assert.deepEqual(await completeTestLessonsService({
      attempt: attempt({ status: 'expired', policy_snapshot: { passPercent: null } }), completedAt: now,
   }, client, empty.overrides), [])
   assert.equal(empty.calls.answered, 1)
   assert.equal(empty.calls.completed.length, 0)

   const failed = completionDoubles()
   await completeTestLessonsService({
      attempt: attempt({ score: '1.00', policy_snapshot: { passPercent: 60 } }), completedAt: now,
   }, client, failed.overrides)
   assert.equal(failed.calls.completed.length, 0)

   await assert.rejects(completeTestLessonsService({ attempt: attempt(), completedAt: now }, null), TypeError)
})

const noExpiry = {
   transaction: async (work) => work(client),
   repository: {},
   clock: () => now,
}

function attemptRow(extra = {}) {
   return {
      id: '10', test_id: '3', assignment_id: '20', user_id: '2', attempt_number: 1, status: 'graded',
      started_at: now, expires_at: null, submitted_at: now, graded_at: now, score: '3.00', max_score: '4.00',
      policy_snapshot: { passPercent: 70, answerRevealPolicy: 'never', maxAttempts: 1 },
      title: 'Quiz', closes_at: null, ...extra,
   }
}

test('readResult reports passPercent from the snapshot', async () => {
   const row = attemptRow()
   const repository = {
      lockNextExpiredAttempt: async () => null,
      findAttempt: async () => row,
      listUserAttempts: async () => [row],
      sumExtraAttempts: async () => new Map(),
   }
   const result = await getAttemptResultService('2', '10', { ...noExpiry, repository })
   assert.equal(result.percent, 75)
   assert.equal(result.passPercent, 70)
   assert.equal(result.passed, true)
   const none = attemptRow({ policy_snapshot: { passPercent: null, answerRevealPolicy: 'never', maxAttempts: 1 } })
   const nullResult = await getAttemptResultService('2', '10', {
      ...noExpiry, repository: { ...repository, findAttempt: async () => none },
   })
   assert.equal(nullResult.passPercent, null)
   assert.equal(nullResult.passed, null)
})

test('staff attempts carry the snapshot passPercent', async () => {
   const repository = {
      findResultsTest: async () => ({ id: '3' }),
      listTestAttempts: async () => [{ ...attemptRow(), user_display_name: 'A B' }],
   }
   const { attempts } = await listTestAttemptsService('9', '3', {}, { repository })
   assert.equal(attempts[0].passPercent, 70)
   assert.ok(!JSON.stringify(attempts).includes('answerRevealPolicy'))
})

test('assignments kept for history are marked revoked', async () => {
   const assignment = (extra) => ({
      id: '20', test_id: '3', title: 'Quiz', mode: 'practice', question_count: 1, duration_seconds: null,
      max_attempts: 1, opens_at: now, closes_at: null, personal_window_minutes: null, result_policy: 'first', ...extra,
   })
   const repository = {
      lockNextExpiredAttempt: async () => null,
      listLearnerAssignments: async () => [assignment({ available: true }), assignment({ id: '21', available: false })],
      listUserAttempts: async () => [],
      sumExtraAttempts: async () => new Map(),
      findLearnerAssignmentHistory: async () => assignment({ available: false }),
   }
   const { assignments } = await listMyAssignmentsService('2', '5', {}, { ...noExpiry, repository })
   assert.deepEqual(assignments.map((item) => item.state), ['open', 'revoked'])
   const result = await getAssignmentResultService('2', '20', { ...noExpiry, repository })
   assert.equal(result.state, 'revoked')
})

test('course progress is rounded down and safe for empty courses', () => {
   assert.deepEqual(courseProgress({ total_lessons: 3, completed_lessons: 2 }), { completedLessons: 2, totalLessons: 3, percent: 66 })
   assert.deepEqual(courseProgress({ total_lessons: 0, completed_lessons: 0 }), { completedLessons: 0, totalLessons: 0, percent: 0 })
   assert.equal(courseProgress({ total_lessons: 4, completed_lessons: 4 }).percent, 100)
})

test('lesson lists expose testId only with module access', async () => {
   const lesson = (granted) => ({
      id: granted ? '1' : '2', module_id: '3', title: 'L', position: 1, lesson_type: 'test',
      translations: {}, test_id: '9', granted,
   })
   const learner = {
      hasLearnerCourse: async () => true,
      listLearnerModuleLessons: async () => [lesson(true), lesson(false)],
   }
   const { lessons } = await listLearnerLessonsService('2', '4', '3', { learner })
   assert.deepEqual(lessons.map((item) => item.testId), ['9', null])
})
