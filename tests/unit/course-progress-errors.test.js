import assert from 'node:assert/strict'
import test from 'node:test'

import { errorHandler } from '../../src/configs/error-handler.js'
import { pickMissedCompletions } from '../../src/services/lesson-completion-service.js'
import { describeDatabaseError } from '../../src/utils/database-error.js'
import { lessonPercent, lessonProgress, sumLessonProgress } from '../../src/utils/lesson-progress.js'

test('one progress rule for a module and a course', () => {
   assert.deepEqual(lessonProgress({ completedLessons: 3, totalLessons: 4 }), { completedLessons: 3, totalLessons: 4, percent: 75 })
   assert.deepEqual(lessonProgress(), { completedLessons: 0, totalLessons: 0, percent: 0 })
   assert.equal(lessonPercent(2, 3), 66)
   assert.equal(lessonPercent(4, 4), 100)
   // A course is the sum of its open modules; a locked module (null) adds nothing.
   const course = sumLessonProgress([
      lessonProgress({ completedLessons: 4, totalLessons: 4 }),
      null,
      lessonProgress({ completedLessons: 0, totalLessons: 2 }),
   ])
   assert.deepEqual(course, { completedLessons: 4, totalLessons: 6, percent: 66 })
   assert.deepEqual(sumLessonProgress([]), { completedLessons: 0, totalLessons: 0, percent: 0 })
})

test('missed test-lesson completions pick the earliest attempt that meets the rule', () => {
   const snapshot = { passPercent: 50 }
   const row = (fields) => ({
      lesson_id: '7', user_id: '1', test_id: '3', status: 'graded', score: '1.33', max_score: '2.00',
      policy_snapshot: snapshot, answered: true, finished_at: new Date('2026-11-05T16:27:59Z'), ...fields,
   })
   const picked = pickMissedCompletions([
      row({ attempt_id: '10', score: '0.33', finished_at: new Date('2026-11-05T16:00:00Z') }),
      row({ attempt_id: '11' }),
      row({ attempt_id: '12', score: '2.00', finished_at: new Date('2026-11-06T10:00:00Z') }),
      // Another learner: closed by the timer without an answer never completes.
      row({ user_id: '2', attempt_id: '20', status: 'expired', answered: false, policy_snapshot: {} }),
      // Without passPercent any finished attempt completes.
      row({ user_id: '3', attempt_id: '30', score: '0.00', policy_snapshot: {} }),
   ])
   assert.deepEqual(picked.map((item) => [item.userId, item.attemptId]), [['1', '11'], ['3', '30']])
   assert.equal(picked[0].completedAt.toISOString(), '2026-11-05T16:27:59.000Z')
   assert.deepEqual(pickMissedCompletions([row({ attempt_id: '1', score: '0.99' })]), [])
})

function pgError(code, fields = {}) {
   return Object.assign(new Error(fields.message || 'violates'), { code, severity: 'ERROR', ...fields })
}

test('PostgreSQL integrity errors map to stable codes', () => {
   assert.deepEqual(describeDatabaseError(pgError('23514')), { status: 400, code: 'VALIDATION_ERROR', message: 'Request validation failed' })
   assert.equal(describeDatabaseError(pgError('23502')).code, 'VALIDATION_ERROR')
   assert.deepEqual(describeDatabaseError(pgError('23505')).status, 409)
   assert.equal(describeDatabaseError(pgError('23505')).code, 'CONFLICT')
   assert.equal(describeDatabaseError(pgError('23503', { message: 'insert or update on table "x" violates foreign key constraint "y"' })).code, 'REFERENCE_NOT_FOUND')
   assert.equal(describeDatabaseError(pgError('23503', { message: 'update or delete on table "x" violates foreign key constraint "y"' })).code, 'REFERENCE_IN_USE')
   assert.equal(describeDatabaseError(pgError('23503', { message: 'нарушает ограничение' }), 'DELETE').status, 409)
   // Not a database error, or another class: left to the 500 path.
   assert.equal(describeDatabaseError(Object.assign(new Error('x'), { code: '23505' })), null)
   assert.equal(describeDatabaseError(pgError('40001')), null)
   assert.equal(describeDatabaseError(null), null)
})

function fakeResponse() {
   return {
      statusCode: null,
      body: null,
      headers: {},
      status(code) { this.statusCode = code; return this },
      json(body) { this.body = body; return this },
      set(name, value) { this.headers[name] = value; return this },
   }
}

test('the error handler answers integrity errors without SQL and logs the constraint', (t) => {
   const logged = []
   t.mock.method(console, 'error', (...args) => { logged.push(args) })
   const request = { method: 'POST', originalUrl: '/api/v1/admin/tests?x=1' }
   const error = pgError('23514', {
      message: 'new row for relation "tests" violates check constraint "tests_origin_check"',
      constraint: 'tests_origin_check',
      table: 'tests',
      detail: 'Failing row contains (secret values)',
   })
   const response = fakeResponse()
   errorHandler(error, request, response, () => {})
   assert.equal(response.statusCode, 400)
   assert.deepEqual(response.body, { error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: [] } })
   assert.ok(!/tests_origin_check|relation|Failing/.test(JSON.stringify(response.body)))
   assert.deepEqual(logged[0], ['Database constraint violation', {
      code: '23514', constraint: 'tests_origin_check', table: 'tests', column: null, method: 'POST', path: '/api/v1/admin/tests',
   }])
   assert.ok(!JSON.stringify(logged).includes('secret values'))

   const conflict = fakeResponse()
   errorHandler(pgError('23505', { constraint: 'x_key' }), request, conflict, () => {})
   assert.equal(conflict.statusCode, 409)
   assert.equal(conflict.body.error.code, 'CONFLICT')

   const crash = fakeResponse()
   errorHandler(new Error('boom'), request, crash, () => {})
   assert.equal(crash.statusCode, 500)
   assert.equal(crash.body.error.code, 'INTERNAL_ERROR')
})
