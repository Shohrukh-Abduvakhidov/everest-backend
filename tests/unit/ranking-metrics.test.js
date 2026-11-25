import assert from 'node:assert/strict'
import test from 'node:test'

import {
   activityScore,
   assignmentOutcome,
   difficultyMultiplier,
   firstSolves,
   lessonPoints,
   mockExamPoints,
   participantWindow,
   performanceScore,
   periodBounds,
   rankParticipants,
   trainerAttemptCounts,
   trainerPoints,
   visibleRows,
} from '../../src/utils/ranking-metrics.js'

const at = (value) => new Date(value)

test('period bounds are local midnights in Asia/Dushanbe (UTC+5)', () => {
   // Wednesday 2026-11-25 15:00 local.
   const now = at('2026-11-25T10:00:00Z')
   assert.deepEqual(periodBounds('week', now), { start: at('2026-11-22T19:00:00Z'), end: at('2026-11-29T19:00:00Z') })
   assert.deepEqual(periodBounds('month', now), { start: at('2026-10-31T19:00:00Z'), end: at('2026-11-30T19:00:00Z') })
   assert.deepEqual(periodBounds('all', now), { start: null, end: null })
   // Sunday 23:59 local is still the old week; Monday 00:00 local starts the new one.
   assert.deepEqual(periodBounds('week', at('2026-11-29T18:59:00Z')).start, at('2026-11-22T19:00:00Z'))
   assert.deepEqual(periodBounds('week', at('2026-11-29T19:00:00Z')).start, at('2026-11-29T19:00:00Z'))
   // 00:30 on 1 January local is January although it is still 31 December in UTC.
   assert.deepEqual(periodBounds('month', at('2026-12-31T19:30:00Z')), { start: at('2026-12-31T19:00:00Z'), end: at('2027-01-31T19:00:00Z') })
   assert.throws(() => periodBounds('year', now), TypeError)
})

test('a participant counts from joining, never before', () => {
   const bounds = periodBounds('week', at('2026-11-25T10:00:00Z'))
   assert.deepEqual(participantWindow(bounds, at('2026-11-24T08:00:00Z')).start, at('2026-11-24T08:00:00Z'))
   assert.deepEqual(participantWindow(bounds, at('2026-10-01T00:00:00Z')).start, bounds.start)
   assert.deepEqual(participantWindow({ start: null, end: null }, at('2026-10-01T00:00:00Z')), { start: at('2026-10-01T00:00:00Z'), end: null })
})

function attempt(number, score, finishedAt, maxScore = '10.00') {
   return { attempt_number: number, status: 'graded', score, max_score: maxScore, finished_at: finishedAt }
}

test('assignment outcome: counted attempt by result policy, closed without attempt is 0, open without attempt does not count', () => {
   const now = at('2026-11-25T10:00:00Z')
   const attempts = [attempt(1, '4.00', '2026-11-20T10:00:00Z'), attempt(2, '9.00', '2026-11-21T10:00:00Z'), attempt(3, '6.00', '2026-11-22T10:00:00Z')]
   assert.equal(assignmentOutcome({ resultPolicy: 'first', closesAt: '2026-11-24T00:00:00Z', attempts }, now).percent, 40)
   assert.equal(assignmentOutcome({ resultPolicy: 'best', closesAt: '2026-11-24T00:00:00Z', attempts }, now).percent, 90)
   assert.equal(assignmentOutcome({ resultPolicy: 'last', closesAt: '2026-11-24T00:00:00Z', attempts }, now).percent, 60)
   // The period time is closes_at, or the counted attempt's finish without one.
   assert.deepEqual(assignmentOutcome({ resultPolicy: 'first', closesAt: '2026-11-24T00:00:00Z', attempts }, now).at, at('2026-11-24T00:00:00Z'))
   assert.deepEqual(assignmentOutcome({ resultPolicy: 'last', closesAt: null, attempts }, now).at, at('2026-11-22T10:00:00Z'))
   assert.deepEqual(assignmentOutcome({ resultPolicy: 'first', closesAt: '2026-11-24T00:00:00Z', attempts: [] }, now), {
      percent: 0, at: at('2026-11-24T00:00:00Z'), submitted: false, finishedAt: null,
   })
   assert.equal(assignmentOutcome({ resultPolicy: 'first', closesAt: '2026-11-26T00:00:00Z', attempts: [] }, now), null)
   assert.equal(assignmentOutcome({ resultPolicy: 'first', closesAt: null, attempts: [] }, now), null)
   // A course test the member was never enrolled in counts only with an attempt.
   assert.equal(assignmentOutcome({ resultPolicy: 'first', closesAt: '2026-11-24T00:00:00Z', eligible: false, attempts: [] }, now), null)
   // An unfinished attempt is no attempt.
   assert.equal(assignmentOutcome({
      resultPolicy: 'first', closesAt: '2026-11-26T00:00:00Z',
      attempts: [{ attempt_number: 1, status: 'in_progress', score: null, max_score: '10.00', finished_at: null }],
   }, now), null)
})

test('performance score is the average percent of the counted assignments in the window', () => {
   const now = at('2026-11-25T10:00:00Z')
   const window = { start: at('2026-11-22T19:00:00Z'), end: at('2026-11-29T19:00:00Z') }
   const result = performanceScore([
      { resultPolicy: 'first', closesAt: '2026-11-24T00:00:00Z', attempts: [attempt(1, '7.50', '2026-11-23T10:00:00Z')] },
      { resultPolicy: 'first', closesAt: '2026-11-24T12:00:00Z', attempts: [] },
      { resultPolicy: 'first', closesAt: '2026-11-27T00:00:00Z', attempts: [attempt(1, '10.00', '2026-11-25T09:00:00Z')] },
      // Still open without an attempt, and outside the week: not counted.
      { resultPolicy: 'first', closesAt: '2026-11-28T00:00:00Z', attempts: [] },
      { resultPolicy: 'first', closesAt: '2026-11-15T00:00:00Z', attempts: [attempt(1, '1.00', '2026-11-14T10:00:00Z')] },
   ], window, now)
   assert.equal(result.score, 58.33)
   assert.equal(result.onTime, 2)
   assert.deepEqual(result.lastCountedAt, at('2026-11-25T09:00:00Z'))
   assert.deepEqual(result.breakdown, { assignments: 3, submitted: 2, missed: 1 })
   assert.deepEqual(performanceScore([], window, now), { score: null, onTime: 0, lastCountedAt: null, breakdown: { assignments: 0, submitted: 0, missed: 0 } })
})

test('trainer attempts with too few answers or too fast earn nothing', () => {
   assert.equal(trainerAttemptCounts({ questions: 10, answered: 5, seconds: 15 }), true)
   assert.equal(trainerAttemptCounts({ questions: 10, answered: 4, seconds: 400 }), false)
   assert.equal(trainerAttemptCounts({ questions: 10, answered: 10, seconds: 29 }), false)
   assert.equal(trainerAttemptCounts({ questions: 10, answered: 10, seconds: 30 }), true)
   assert.equal(trainerAttemptCounts({ questions: 0, answered: 0, seconds: 30 }), false)
   assert.deepEqual([1, 2, 3, 4, 5, null].map(difficultyMultiplier), [1, 1, 1.5, 2, 2, 1])
})

test('a question earns once: the first full-mark solve in an attempt that counts', () => {
   const solves = firstSolves([
      { attemptId: '3', at: at('2026-11-24T10:00:00Z'), questions: 2, answered: 2, seconds: 60, solved: [{ questionId: '1', difficulty: 3 }, { questionId: '2', difficulty: 5 }] },
      // Too fast: its solve of question 9 does not burn the question.
      { attemptId: '1', at: at('2026-11-23T10:00:00Z'), questions: 2, answered: 2, seconds: 2, solved: [{ questionId: '9', difficulty: 1 }] },
      { attemptId: '2', at: at('2026-11-23T11:00:00Z'), questions: 2, answered: 2, seconds: 60, solved: [{ questionId: '1', difficulty: 3 }] },
      { attemptId: '4', at: at('2026-11-25T10:00:00Z'), questions: 2, answered: 2, seconds: 60, solved: [{ questionId: '9', difficulty: 1 }] },
   ])
   assert.deepEqual(solves, [
      { at: at('2026-11-23T11:00:00Z'), difficulty: 3 },
      { at: at('2026-11-24T10:00:00Z'), difficulty: 5 },
      { at: at('2026-11-25T10:00:00Z'), difficulty: 1 },
   ])
})

test('trainer points stop at 60 per local day', () => {
   // 50 hard questions on one local day: 100 points capped at 60; the next local day starts again.
   const day = Array.from({ length: 50 }, () => ({ at: at('2026-11-24T10:00:00Z'), difficulty: 4 }))
   const nextDay = [{ at: at('2026-11-24T19:00:00Z'), difficulty: 3 }]
   assert.deepEqual(trainerPoints([...day, ...nextDay]), { points: 61.5, lastAt: at('2026-11-24T19:00:00Z') })
   // A half point fits under the cap only partly.
   const almost = Array.from({ length: 39 }, () => ({ at: at('2026-11-24T10:00:00Z'), difficulty: 3 }))
   assert.equal(trainerPoints([...almost, { at: at('2026-11-24T11:00:00Z'), difficulty: 4 }]).points, 60)
})

test('mock exams: the best of each week, score / 160 x 50', () => {
   const result = mockExamPoints([
      { at: at('2026-11-17T10:00:00Z'), score: '80.00' },
      { at: at('2026-11-18T10:00:00Z'), score: '128.00' },
      { at: at('2026-11-24T10:00:00Z'), score: '160.00' },
   ])
   assert.deepEqual(result, { points: 90, lastAt: at('2026-11-24T10:00:00Z'), counted: 2 })
})

test('lessons: +5 each, at most 10 per local day', () => {
   const completions = Array.from({ length: 12 }, (_, index) => ({ at: at(`2026-11-24T1${index % 10}:00:00Z`) }))
   const result = lessonPoints(completions)
   // 10:00Z-18:59Z is 24 Nov local; 19:00Z is already 25 Nov local.
   assert.equal(result.counted, 11)
   assert.equal(result.points, 55)
})

test('activity score sums the parts inside the window', () => {
   const window = { start: at('2026-11-22T19:00:00Z'), end: at('2026-11-29T19:00:00Z') }
   const result = activityScore({
      solves: [{ at: at('2026-11-23T10:00:00Z'), difficulty: 3 }, { at: at('2026-11-20T10:00:00Z'), difficulty: 5 }],
      mockExams: [{ at: at('2026-11-24T10:00:00Z'), score: '96.00' }],
      lessons: [{ at: at('2026-11-25T10:00:00Z') }],
   }, window)
   assert.equal(result.score, 36.5)
   assert.deepEqual(result.lastCountedAt, at('2026-11-25T10:00:00Z'))
   assert.deepEqual(result.breakdown, { trainerPoints: 1.5, mockExamPoints: 30, mockExamsCounted: 1, lessonPoints: 5, lessonsCounted: 1 })
   assert.equal(activityScore({}, window).score, 0)
})

function participant(userId, score, extra = {}) {
   return { userId, score, onTime: 0, lastCountedAt: null, firstName: 'A', lastName: `L${userId}`, ...extra }
}

test('places follow 1-2-2-4 on hundredths; ties ordered by on-time count, earlier last attempt, name', () => {
   const ranked = rankParticipants([
      participant('1', 70),
      participant('2', 90.004),
      participant('3', 90, { onTime: 1 }),
      participant('4', 90, { onTime: 1, lastCountedAt: at('2026-11-20T00:00:00Z') }),
      participant('5', null),
      participant('6', 60, { lastName: 'Б' }),
      participant('7', 60, { lastName: 'А' }),
   ])
   assert.deepEqual(ranked.map((row) => [row.userId, row.rank]), [
      ['4', 1], ['3', 1], ['2', 1], ['1', 4], ['7', 5], ['6', 5], ['5', null],
   ])
})

test('students see places 1-10 with shared places, everything, or nothing', () => {
   const ranked = rankParticipants(Array.from({ length: 14 }, (_, index) => participant(String(index + 1), index < 9 ? 100 - index : 50)))
   assert.equal(visibleRows(ranked, 'full').length, 14)
   // Places 1-9, then five share place 10.
   assert.equal(visibleRows(ranked, 'top10_self').length, 14)
   const spread = rankParticipants(Array.from({ length: 14 }, (_, index) => participant(String(index + 1), 100 - index)))
   assert.deepEqual(visibleRows(spread, 'top10_self').map((row) => row.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
   assert.deepEqual(visibleRows(spread, 'staff_only'), [])
   assert.deepEqual(visibleRows(rankParticipants([participant('1', null)]), 'top10_self'), [])
})
