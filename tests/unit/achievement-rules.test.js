import assert from 'node:assert/strict'
import test from 'node:test'

import { activeDays, attemptCounts, evaluateAchievement } from '../../src/utils/achievement-rules.js'
import { telegramDefaultEnabled, telegramEventCodes, renderNotification } from '../../src/utils/notification-texts.js'
import { previousPeriod, previousPeriodDay } from '../../src/services/achievement-service.js'

const at = (value) => new Date(value)
const now = at('2026-11-26T12:00:00Z')
let nextId = 1

// A counted attempt: every question answered, 10 s per question.
function attempt(fields = {}) {
   const questions = fields.questions ?? 10
   return {
      id: String(nextId++),
      origin: 'trainer',
      testId: String(nextId + 1000),
      assignmentId: null,
      attemptNumber: 1,
      score: questions,
      maxScore: questions,
      passPercent: null,
      finishedAt: at('2026-11-20T10:00:00Z'),
      seconds: questions * 10,
      questions,
      answered: questions,
      subjectId: '1',
      repeat: false,
      ...fields,
   }
}

const rule = (type, criteria = {}) => ({ code: type, criteria: { type, ...criteria } })
const evaluate = (type, criteria, facts, context = { now }) => evaluateAchievement(rule(type, criteria), facts, context)

test('M13 achievement rules', async (t) => {
   await t.test('anti-cheat: answered at least one and half, and 3 s per answered question', () => {
      assert.equal(attemptCounts(attempt()), true)
      assert.equal(attemptCounts(attempt({ answered: 0 })), false)
      assert.equal(attemptCounts(attempt({ answered: 4 })), false)
      assert.equal(attemptCounts(attempt({ answered: 5, seconds: 15 })), true)
      assert.equal(attemptCounts(attempt({ seconds: 29 })), false)
   })

   await t.test('first_step needs a counted attempt; rejected ones do not count', () => {
      const rejected = attempt({ answered: 1, questions: 10 })
      assert.equal(evaluate('attempt_finished', { target: 1 }, { attempts: [rejected] }).achieved, false)
      const counted = attempt({ finishedAt: at('2026-11-21T10:00:00Z') })
      const outcome = evaluate('attempt_finished', { target: 1 }, { attempts: [rejected, counted] })
      assert.equal(outcome.achieved, true)
      assert.equal(outcome.at.toISOString(), '2026-11-21T10:00:00.000Z')
      assert.deepEqual(outcome.metadata, { attemptId: counted.id, origin: 'trainer' })
      assert.deepEqual(outcome.progress, { current: 1, target: 1 })
   })

   await t.test('first_mock and mock_120 look at mock exams only', () => {
      const facts = { attempts: [attempt(), attempt({ origin: 'mock_exam', questions: 160, score: 119.5, maxScore: 160 })] }
      assert.equal(evaluate('mock_exam_finished', { target: 1 }, facts).achieved, true)
      assert.equal(evaluate('mock_exam_score', { minScore: 120 }, facts).achieved, false)
      facts.attempts.push(attempt({ origin: 'mock_exam', questions: 160, score: 120, maxScore: 160 }))
      assert.equal(evaluate('mock_exam_score', { minScore: 120 }, facts).achieved, true)
   })

   await t.test('solver counts different trainer questions solved first in counted attempts', () => {
      const a1 = attempt({ finishedAt: at('2026-11-01T10:00:00Z'), questions: 3, answered: 3, seconds: 30 })
      const a2 = attempt({ finishedAt: at('2026-11-02T10:00:00Z'), questions: 3, answered: 3, seconds: 30 })
      const fast = attempt({ finishedAt: at('2026-11-03T10:00:00Z'), questions: 3, answered: 3, seconds: 3 })
      const mock = attempt({ origin: 'mock_exam', questions: 3, answered: 3, seconds: 30 })
      const occurrences = [
         { attemptId: a1.id, questionId: '1', full: true },
         { attemptId: a1.id, questionId: '2', full: false },
         { attemptId: a2.id, questionId: '1', full: true },
         { attemptId: a2.id, questionId: '2', full: true },
         { attemptId: fast.id, questionId: '3', full: true },
         { attemptId: mock.id, questionId: '4', full: true },
      ]
      const facts = { attempts: [a1, a2, fast, mock], occurrences }
      const two = evaluate('trainer_solved', { target: 2 }, facts)
      assert.equal(two.achieved, true)
      assert.equal(two.at.toISOString(), '2026-11-02T10:00:00.000Z')
      assert.deepEqual(evaluate('trainer_solved', { target: 3 }, facts).progress, { current: 2, target: 3 })
   })

   await t.test('mistakes_fixed: a wrong answer later answered with full marks, once per question', () => {
      const a1 = attempt({ finishedAt: at('2026-11-01T10:00:00Z') })
      const a2 = attempt({ origin: 'mock_exam', finishedAt: at('2026-11-02T10:00:00Z') })
      const a3 = attempt({ finishedAt: at('2026-11-03T10:00:00Z') })
      const occurrences = [
         { attemptId: a1.id, questionId: '1', full: false },
         { attemptId: a1.id, questionId: '2', full: true },
         { attemptId: a2.id, questionId: '1', full: true },
         { attemptId: a2.id, questionId: '2', full: false },
         { attemptId: a3.id, questionId: '1', full: false },
         { attemptId: a3.id, questionId: '1', full: true },
         { attemptId: a3.id, questionId: '3', full: true },
      ]
      const outcome = evaluate('mistakes_fixed', { target: 2 }, { attempts: [a3, a2, a1], occurrences })
      assert.deepEqual(outcome.progress, { current: 1, target: 2 })
      occurrences.push({ attemptId: a3.id, questionId: '2', full: true })
      const done = evaluate('mistakes_fixed', { target: 2 }, { attempts: [a3, a2, a1], occurrences })
      assert.equal(done.achieved, true)
      assert.equal(done.at.toISOString(), '2026-11-03T10:00:00.000Z')
   })

   await t.test('subject_ready replays readiness D3 over the last trainings with enough questions', () => {
      const day = (n) => at(`2026-11-${String(n).padStart(2, '0')}T10:00:00Z`)
      const attempts = [
         attempt({ finishedAt: day(1), questions: 10, score: 5, maxScore: 10 }),
         attempt({ finishedAt: day(2), questions: 10, score: 10, maxScore: 10 }),
         attempt({ finishedAt: day(3), questions: 10, score: 10, maxScore: 10, repeat: true }),
         attempt({ finishedAt: day(4), questions: 10, score: 10, maxScore: 10 }),
      ]
      const criteria = { percent: 85, minQuestions: 30 }
      // Window of 2: 20 questions only, never enough.
      assert.equal(evaluate('subject_readiness', criteria, { attempts }, { now, readinessWindow: 2 }).achieved, false)
      // Window of 5: 25 / 30 = 83.33 after day 4.
      assert.equal(evaluate('subject_readiness', criteria, { attempts }, { now, readinessWindow: 5 }).achieved, false)
      attempts.push(attempt({ finishedAt: day(5), questions: 10, score: 10, maxScore: 10 }))
      const outcome = evaluate('subject_readiness', criteria, { attempts }, { now, readinessWindow: 5 })
      assert.equal(outcome.achieved, true)
      assert.equal(outcome.at.toISOString(), day(5).toISOString())
      assert.deepEqual(outcome.metadata, { subjectId: '1', readinessPercent: 87.5, questions: 40 })
   })

   await t.test('perfect_score and first_try_5 use teacher and course tests only', () => {
      const small = attempt({ origin: 'authored', questions: 9 })
      const trainer = attempt({ questions: 10 })
      assert.equal(evaluate('perfect_score', { minQuestions: 10 }, { attempts: [small, trainer] }).achieved, false)
      const full = attempt({ origin: 'standalone', questions: 10 })
      assert.equal(evaluate('perfect_score', { minQuestions: 10 }, { attempts: [small, full] }).achieved, true)

      const passedFirst = (testId, extra = {}) => attempt({ origin: 'authored', testId, passPercent: 60, score: 7, ...extra })
      const attempts = [
         passedFirst('1'), passedFirst('1'), passedFirst('2'),
         passedFirst('3', { attemptNumber: 2 }), passedFirst('4', { score: 5 }), passedFirst('5', { passPercent: null }),
      ]
      assert.deepEqual(evaluate('first_try_passed', { target: 3 }, { attempts }).progress, { current: 2, target: 3 })
      attempts.push(passedFirst('6'))
      assert.equal(evaluate('first_try_passed', { target: 3 }, { attempts }).achieved, true)
   })

   await t.test('on_time_5: a run in close order; closed and missed breaks it, open and not done waits', () => {
      const close = (n) => at(`2026-11-${String(n).padStart(2, '0')}T18:00:00Z`)
      const assignments = [1, 2, 3, 4, 5].map((n) => ({ assignmentId: String(n), groupId: '1', closesAt: close(n), eligible: true }))
      const done = (n, extra = {}) => attempt({ origin: 'authored', assignmentId: String(n), finishedAt: at(`2026-11-0${n}T10:00:00Z`), ...extra })
      // 2 missed (closed), so the run is 3, 4 and 5.
      let facts = { attempts: [done(1), done(3), done(4), done(5)], groupAssignments: assignments }
      assert.deepEqual(evaluate('assignments_on_time', { target: 3 }, facts).progress, { current: 3, target: 3 })
      assert.equal(evaluate('assignments_on_time', { target: 4 }, facts).achieved, false)
      // 2 not eligible (no enrollment): skipped, the run is 4.
      facts = { attempts: facts.attempts, groupAssignments: assignments.map((item) => (item.assignmentId === '2' ? { ...item, eligible: false } : item)) }
      const four = evaluate('assignments_on_time', { target: 4 }, facts)
      assert.equal(four.achieved, true)
      assert.equal(four.at.toISOString(), '2026-11-05T10:00:00.000Z')
      // A rejected attempt is not a hand-in.
      facts = { attempts: [done(1), done(2, { answered: 1 }), done(3)], groupAssignments: assignments.slice(0, 3) }
      assert.deepEqual(evaluate('assignments_on_time', { target: 5 }, facts, { now: at('2026-12-01T00:00:00Z') }).progress, { current: 1, target: 5 })
      // Still open: not decided, the run goes on.
      assert.deepEqual(evaluate('assignments_on_time', { target: 5 }, facts, { now: at('2026-11-02T00:00:00Z') }).progress, { current: 2, target: 5 })
   })

   await t.test('lessons_25 and course_completed', () => {
      const lessons = [3, 1, 2].map((n) => ({ lessonId: String(n), completedAt: at(`2026-11-0${n}T10:00:00Z`) }))
      const outcome = evaluate('lessons_completed', { target: 2 }, { lessons })
      assert.equal(outcome.at.toISOString(), '2026-11-02T10:00:00.000Z')
      assert.deepEqual(outcome.metadata, { lessonId: '2' })
      const courses = [
         { courseId: '7', totalLessons: 3, completedLessons: 2, lastCompletedAt: at('2026-11-02T00:00:00Z') },
         { courseId: '8', totalLessons: 0, completedLessons: 0, lastCompletedAt: null },
      ]
      assert.equal(evaluate('course_completed', {}, { courses }).achieved, false)
      courses.push({ courseId: '9', totalLessons: 2, completedLessons: 2, lastCompletedAt: at('2026-11-04T00:00:00Z') })
      assert.deepEqual(evaluate('course_completed', {}, { courses }).metadata, { courseId: '9' })
   })

   await t.test('streak: local days in the profile zone; watch time needs the minimum', () => {
      // 2026-11-01T20:00Z is 2 Nov 01:00 in Dushanbe (UTC+5).
      const facts = {
         timeZone: 'Asia/Dushanbe',
         attempts: [attempt({ finishedAt: at('2026-11-01T20:00:00Z') })],
         lessons: [{ lessonId: '1', completedAt: at('2026-11-03T05:00:00Z') }],
         watch: [
            { at: at('2026-11-04T05:00:00Z'), seconds: 200 },
            { at: at('2026-11-04T06:00:00Z'), seconds: 100 },
            { at: at('2026-11-05T06:00:00Z'), seconds: 299 },
         ],
      }
      assert.deepEqual([...activeDays(facts, 300).keys()].sort(), ['2026-11-02', '2026-11-03', '2026-11-04'])
      const outcome = evaluate('activity_streak', { days: 3, minWatchSeconds: 300 }, facts)
      assert.equal(outcome.achieved, true)
      assert.equal(outcome.at.toISOString(), '2026-11-04T06:00:00.000Z')
      // In UTC the attempt day is 1 Nov, so the run breaks.
      assert.equal(evaluate('activity_streak', { days: 3, minWatchSeconds: 300 }, { ...facts, timeZone: 'UTC' }).achieved, false)
      // Progress: a run counts only while its last day is today or yesterday.
      assert.deepEqual(evaluate('activity_streak', { days: 7, minWatchSeconds: 300 }, facts, { now: at('2026-11-05T12:00:00Z') }).progress, { current: 3, target: 7 })
      assert.deepEqual(evaluate('activity_streak', { days: 7, minWatchSeconds: 300 }, facts, { now: at('2026-11-07T12:00:00Z') }).progress, { current: 0, target: 7 })
   })

   await t.test('group_top3: shared places count; score 0 and small groups do not', () => {
      const place = (extra) => ({
         groupId: '1', board: 'activity', periodKind: 'week', periodStart: '2026-11-16', rank: 3, score: 5,
         participants: 5, computedAt: at('2026-11-23T00:05:00Z'), ...extra,
      })
      const criteria = { maxRank: 3, minParticipants: 5, periodKind: 'week' }
      assert.equal(evaluate('group_top3', criteria, { snapshots: [place({ rank: 4 })] }).achieved, false)
      assert.equal(evaluate('group_top3', criteria, { snapshots: [place({ score: 0 })] }).achieved, false)
      assert.equal(evaluate('group_top3', criteria, { snapshots: [place({ participants: 4 })] }).achieved, false)
      const outcome = evaluate('group_top3', criteria, { snapshots: [place({ periodStart: '2026-11-09' }), place()] })
      assert.deepEqual(outcome.metadata, { groupId: '1', board: 'activity', periodStart: '2026-11-09', rank: 3 })
   })

   await t.test('an unknown criteria type is never earned', () => {
      assert.equal(evaluateAchievement({ criteria: { type: 'later' } }, { attempts: [attempt()] }).achieved, false)
   })

   await t.test('achievement.unlocked: Telegram off by default, title in the recipient language', () => {
      assert.ok(telegramEventCodes.includes('achievement.unlocked'))
      assert.equal(telegramDefaultEnabled('achievement.unlocked'), false)
      assert.equal(telegramDefaultEnabled('test.assigned'), true)
      const params = { achievement: { ru: 'Решатель', tg: 'Ҳалкунанда', en: 'Solver' } }
      assert.equal(renderNotification('achievement.unlocked', params, { languageCode: 'tg' }).body, 'Шумо дастоварди «Ҳалкунанда»-ро гирифтед.')
      assert.equal(renderNotification('achievement.unlocked', { achievement: { ru: 'Решатель' } }, { languageCode: 'en' }).body,
         'You earned the achievement “Решатель”.')
   })

   await t.test('scheduled periods: the finished week, month and day in Asia/Dushanbe', () => {
      // Monday 30 Nov 2026 00:03 local = 29 Nov 19:03Z.
      const monday = at('2026-11-29T19:03:00Z')
      const week = previousPeriod('week', monday)
      assert.equal(week.startKey, '2026-11-23')
      assert.equal(week.start.toISOString(), '2026-11-22T19:00:00.000Z')
      assert.equal(week.end.toISOString(), '2026-11-29T19:00:00.000Z')
      const month = previousPeriod('month', at('2026-12-01T05:00:00Z'))
      assert.equal(month.startKey, '2026-11-01')
      assert.equal(month.end.toISOString(), '2026-11-30T19:00:00.000Z')
      const day = previousPeriodDay(monday)
      assert.equal(day.start.toISOString(), '2026-11-28T19:00:00.000Z')
      assert.equal(day.end.toISOString(), '2026-11-29T19:00:00.000Z')
   })
})
