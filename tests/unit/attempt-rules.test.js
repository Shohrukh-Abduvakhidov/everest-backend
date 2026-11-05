import assert from 'node:assert/strict'
import test from 'node:test'

import { gradeAnswer, parseStudentAnswer, scorePercent, sumPoints } from '../../src/utils/attempt-grading.js'
import {
   answersRevealed,
   assignmentState,
   computeDeadline,
   personalWindowEnd,
   remainingAttempts,
   selectResultAttempt,
} from '../../src/utils/attempt-policy.js'

const snapshot = (questionType, answerData, extra = {}) => ({
   questionType,
   answerData,
   optionKeys: ['A', 'B', 'C'],
   leftKeys: ['L1', 'L2', 'L3'],
   rightKeys: ['R1', 'R2', 'R3'],
   interactionSettings: {},
   ...extra,
})

test('single choice is right or wrong', () => {
   const key = snapshot('single_choice', { optionKey: 'B' })
   assert.equal(gradeAnswer({ optionKey: 'B' }, key, '2.50'), '2.50')
   assert.equal(gradeAnswer({ optionKey: 'A' }, key, '2.50'), '0.00')
   assert.equal(gradeAnswer(null, key, '2.50'), '0.00')
})

test('multiple choice is all or nothing, in any order', () => {
   const key = snapshot('multiple_choice', { optionKeys: ['A', 'B'] })
   assert.equal(gradeAnswer({ optionKeys: ['B', 'A'] }, key, '3'), '3.00')
   assert.equal(gradeAnswer({ optionKeys: ['A'] }, key, '3'), '0.00')
   assert.equal(gradeAnswer({ optionKeys: ['A', 'B', 'C'] }, key, '3'), '0.00')
})

test('matching earns a share per correct pair and rounds down', () => {
   const key = snapshot('matching', {
      pairs: [{ left: 'L1', right: 'R1' }, { left: 'L2', right: 'R2' }, { left: 'L3', right: 'R3' }],
   })
   const pairs = (...values) => ({ pairs: values.map(([left, right]) => ({ left, right })) })
   assert.equal(gradeAnswer(pairs(['L1', 'R1'], ['L2', 'R2'], ['L3', 'R3']), key, '3'), '3.00')
   assert.equal(gradeAnswer(pairs(['L1', 'R1'], ['L2', 'R3'], ['L3', 'R2']), key, '1'), '0.33')
   assert.equal(gradeAnswer(pairs(['L1', 'R1']), key, '3'), '1.00')
})

test('matching extra pairs lower the share', () => {
   const key = snapshot('matching', { pairs: [{ left: 'L1', right: 'R1' }] })
   const answer = { pairs: [{ left: 'L1', right: 'R1' }, { left: 'L2', right: 'R2' }] }
   assert.equal(gradeAnswer(answer, key, '2'), '1.00')
})

test('numeric is exact', () => {
   const key = snapshot('numeric', { value: 1.5 })
   assert.equal(gradeAnswer({ value: 1.5 }, key, '1'), '1.00')
   assert.equal(gradeAnswer({ value: 1.50001 }, key, '1'), '0.00')
})

test('short text ignores case and outer spaces', () => {
   const key = snapshot('short_text', { acceptedAnswers: ['Митоз', 'mitosis'] })
   assert.equal(gradeAnswer({ text: '  митоЗ ' }, key, '1'), '1.00')
   assert.equal(gradeAnswer({ text: 'MITOSIS' }, key, '1'), '1.00')
   assert.equal(gradeAnswer({ text: 'мейоз' }, key, '1'), '0.00')
})

test('answers are checked against the attempt structure', () => {
   const choice = snapshot('single_choice', { optionKey: 'A' })
   assert.deepEqual(parseStudentAnswer({ optionKey: 'A' }, choice), { optionKey: 'A' })
   assert.equal(parseStudentAnswer(null, choice), null)
   assert.throws(() => parseStudentAnswer({ optionKey: 'Z' }, choice), { code: 'VALIDATION_ERROR' })
   assert.throws(() => parseStudentAnswer({ optionKey: 'A', extra: 1 }, choice), { code: 'VALIDATION_ERROR' })
   const matching = snapshot('matching', { pairs: [] })
   const reused = { pairs: [{ left: 'L1', right: 'R1' }, { left: 'L2', right: 'R1' }] }
   assert.throws(() => parseStudentAnswer(reused, matching), { code: 'VALIDATION_ERROR' })
   const reusable = snapshot('matching', { pairs: [] }, { interactionSettings: { allowRightReuse: true } })
   assert.deepEqual(parseStudentAnswer(reused, reusable), reused)
   assert.throws(() => parseStudentAnswer({ value: 'x' }, snapshot('numeric', {})), { code: 'VALIDATION_ERROR' })
})

test('points add without binary rounding', () => {
   assert.equal(sumPoints(['0.10', '0.20']), '0.30')
   assert.equal(scorePercent('1.00', '3.00'), 33.33)
})

test('the deadline is the earliest limit', () => {
   const startedAt = new Date('2026-06-01T10:00:00.000Z')
   assert.equal(computeDeadline({ startedAt }), null)
   assert.deepEqual(
      computeDeadline({ startedAt, durationSeconds: 3600 }),
      new Date('2026-06-01T11:00:00.000Z'),
   )
   assert.deepEqual(
      computeDeadline({
         startedAt,
         durationSeconds: 3600,
         closesAt: '2026-06-01T10:30:00.000Z',
         personalWindowEndsAt: '2026-06-01T10:45:00.000Z',
      }),
      new Date('2026-06-01T10:30:00.000Z'),
   )
   assert.deepEqual(
      computeDeadline({
         startedAt,
         durationSeconds: 3600,
         closesAt: '2026-06-01T12:00:00.000Z',
         personalWindowEndsAt: '2026-06-01T10:45:00.000Z',
      }),
      new Date('2026-06-01T10:45:00.000Z'),
   )
})

test('limits sent in different zones compare as instants', () => {
   const startedAt = new Date('2026-06-01T10:00:00.000Z')
   const deadline = computeDeadline({
      startedAt,
      durationSeconds: 7200,
      // 15:30 in Dushanbe (+05:00) and 13:15 in Moscow (+03:00) are 10:30 and 10:15 UTC.
      closesAt: '2026-06-01T15:30:00+05:00',
      personalWindowEndsAt: '2026-06-01T13:15:00+03:00',
   })
   assert.equal(deadline.toISOString(), '2026-06-01T10:15:00.000Z')
})

test('the personal window starts at the first start', () => {
   assert.equal(personalWindowEnd(null, 30), null)
   assert.equal(personalWindowEnd(new Date(0), null), null)
   assert.equal(personalWindowEnd('2026-06-01T15:00:00+05:00', 30).toISOString(), '2026-06-01T10:30:00.000Z')
})

test('assignment state follows the window', () => {
   const row = { opens_at: '2026-06-01T10:00:00Z', closes_at: '2026-06-01T11:00:00Z' }
   assert.equal(assignmentState(row, new Date('2026-06-01T09:59:59Z')), 'upcoming')
   assert.equal(assignmentState(row, new Date('2026-06-01T10:30:00Z')), 'open')
   assert.equal(assignmentState(row, new Date('2026-06-01T11:00:00Z')), 'closed')
})

test('result policies pick first, best or last among finished attempts', () => {
   const attempts = [
      { attempt_number: 1, status: 'graded', score: '4.00' },
      { attempt_number: 2, status: 'expired', score: '9.00' },
      { attempt_number: 3, status: 'graded', score: '9.00' },
      { attempt_number: 4, status: 'graded', score: '5.00' },
      { attempt_number: 5, status: 'in_progress', score: null },
   ]
   assert.equal(selectResultAttempt('first', attempts).attempt_number, 1)
   assert.equal(selectResultAttempt('best', attempts).attempt_number, 2)
   assert.equal(selectResultAttempt('last', attempts).attempt_number, 4)
   assert.equal(selectResultAttempt('last', [attempts[4]]), null)
})

test('reveal policies', () => {
   const closesAt = '2026-06-01T11:00:00Z'
   assert.equal(answersRevealed('after_submission', null, new Date(0)), true)
   assert.equal(answersRevealed('never', closesAt, new Date('2030-01-01T00:00:00Z')), false)
   assert.equal(answersRevealed('after_window', closesAt, new Date('2026-06-01T10:59:00Z')), false)
   assert.equal(answersRevealed('after_window', closesAt, new Date('2026-06-01T11:00:00Z')), true)
})

test('remaining attempts ignore cancelled ones; null means unlimited', () => {
   const attempts = [{ status: 'graded' }, { status: 'cancelled' }]
   assert.equal(remainingAttempts(3, attempts), 2)
   assert.equal(remainingAttempts(null, attempts), null)
})
