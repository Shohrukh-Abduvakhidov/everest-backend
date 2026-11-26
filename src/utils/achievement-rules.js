import { scorePercent, toHundredths } from './attempt-grading.js'
import { firstSolves, localDateKey, trainerAttemptCounts } from './ranking-metrics.js'

// M13 achievements (decisions.md 2026-11-26). Pure checks only: the repository returns the raw
// facts of one learner, every check below turns them into "earned or not, since when, for what,
// how far". Each check reads the whole history, so the outcome never depends on when the
// evaluation ran (a live award, the daily run and the backfill all agree). Thresholds come from
// the catalog row (achievements.criteria), never from code.
//
// Facts of one learner:
//   timeZone          profile time zone (streak days)
//   attempts          finished attempts of every origin: { id, origin, testId, assignmentId,
//                     attemptNumber, score, maxScore, passPercent, finishedAt, seconds,
//                     questions, answered, subjectId, repeat }
//   occurrences       answered questions of finished trainer and mock exam attempts:
//                     { attemptId, questionId, full }
//   lessons           completed lessons: { lessonId, completedAt }
//   courses           courses with a current enrollment: { courseId, totalLessons,
//                     completedLessons, lastCompletedAt }
//   groupAssignments  group assignments with a close time the learner was a member for:
//                     { assignmentId, groupId, closesAt, eligible }
//   watch             video watch time per hour: { at, seconds }
//   snapshots         weekly ranking places of the learner: { groupId, board, periodStart, rank,
//                     score, participants, computedAt }

const defaultTimeZone = 'Asia/Dushanbe'
const dayMs = 24 * 3600 * 1000
const authoredOrigins = ['authored', 'standalone']

function toDate(value) {
   return value === null || value === undefined ? null : new Date(value)
}

function round2(value) {
   return Math.round(value * 100) / 100
}

function compareIds(left, right) {
   const a = BigInt(left)
   const b = BigInt(right)
   return a < b ? -1 : a > b ? 1 : 0
}

function byFinish(left, right) {
   return left.finishedAt - right.finishedAt || compareIds(left.id, right.id)
}

function resolveTimeZone(timeZone) {
   if (typeof timeZone !== 'string' || !timeZone) return defaultTimeZone
   try {
      new Intl.DateTimeFormat('en', { timeZone }).format()
      return timeZone
   } catch {
      return defaultTimeZone
   }
}

// The anti-cheat rule of the ranking (2026-11-25) for every origin: at least one and at least
// half of the questions answered, and on average at least 3 seconds per answered question.
function attemptCounts(attempt) {
   return trainerAttemptCounts(attempt)
}

function countedAttempts(facts, predicate = () => true) {
   return (facts.attempts ?? []).filter((attempt) => attempt.finishedAt && attemptCounts(attempt) && predicate(attempt))
      .sort(byFinish)
}

function progressOf(current, target) {
   return { current: Math.min(current, target), target }
}

function notYet(progress = null) {
   return { achieved: false, at: null, metadata: {}, progress }
}

function earned(at, metadata, progress = null) {
   return { achieved: true, at, metadata, progress }
}

// The moment the target-th item (already in order) was reached.
function countTarget(items, target, timeOf, metadataOf) {
   if (items.length >= target) {
      const item = items[target - 1]
      return earned(timeOf(item), metadataOf(item), progressOf(items.length, target))
   }
   return notYet(progressOf(items.length, target))
}

function passed(attempt) {
   if (attempt.passPercent === null || attempt.passPercent === undefined) return false
   if (attempt.score === null || attempt.score === undefined || toHundredths(attempt.maxScore ?? 0) === 0) return false
   return scorePercent(attempt.score, attempt.maxScore) >= Number(attempt.passPercent)
}

// ---------------------------------------------------------------- checks

const checks = {
   // first_step: a finished attempt of any test or training that counts.
   attempt_finished(facts, criteria) {
      return countTarget(countedAttempts(facts), criteria.target ?? 1, (attempt) => attempt.finishedAt,
         (attempt) => ({ attemptId: attempt.id, origin: attempt.origin }))
   },

   // first_mock: a finished mock exam that counts.
   mock_exam_finished(facts, criteria) {
      return countTarget(countedAttempts(facts, (attempt) => attempt.origin === 'mock_exam'), criteria.target ?? 1,
         (attempt) => attempt.finishedAt, (attempt) => ({ attemptId: attempt.id }))
   },

   // solver: different trainer questions solved with full marks (the first solve of each, in an
   // attempt that counts; the same rule as the activity board).
   trainer_solved(facts, criteria) {
      const solvedByAttempt = new Map()
      for (const item of facts.occurrences ?? []) {
         if (!item.full) continue
         const list = solvedByAttempt.get(String(item.attemptId)) ?? []
         list.push({ questionId: item.questionId })
         solvedByAttempt.set(String(item.attemptId), list)
      }
      const trainer = (facts.attempts ?? []).filter((attempt) => attempt.origin === 'trainer' && attempt.finishedAt)
         .map((attempt) => ({
            attemptId: attempt.id,
            at: attempt.finishedAt,
            seconds: attempt.seconds,
            questions: attempt.questions,
            answered: attempt.answered,
            solved: solvedByAttempt.get(String(attempt.id)) ?? [],
         }))
      const solves = firstSolves(trainer)
      return countTarget(solves, criteria.target, (solve) => solve.at, () => ({ solved: criteria.target }))
   },

   // mistakes_fixed: questions answered with less than full marks in a training or a mock exam
   // (the mistakes rule of 2026-11-22) and later answered with full marks there. A question
   // counts once.
   mistakes_fixed(facts, criteria) {
      const attempts = new Map(countedAttempts(facts, (attempt) => attempt.origin === 'trainer' || attempt.origin === 'mock_exam')
         .map((attempt) => [String(attempt.id), attempt]))
      const ordered = (facts.occurrences ?? [])
         .filter((item) => attempts.has(String(item.attemptId)))
         .map((item) => ({ ...item, attempt: attempts.get(String(item.attemptId)) }))
         .sort((left, right) => byFinish(left.attempt, right.attempt))
      const mistaken = new Set()
      const fixed = new Set()
      const fixes = []
      for (const item of ordered) {
         const key = String(item.questionId)
         if (fixed.has(key)) continue
         if (!item.full) {
            mistaken.add(key)
         } else if (mistaken.has(key)) {
            fixed.add(key)
            fixes.push({ at: item.attempt.finishedAt, questionId: key })
         }
      }
      return countTarget(fixes, criteria.target, (fix) => fix.at, () => ({ fixed: criteria.target }))
   },

   // subject_ready: readiness D3 of one subject (points over possible points of the last
   // `window` standard trainings) reaches the percent with at least minQuestions questions in
   // that window. Replayed over the history, training by training.
   subject_readiness(facts, criteria, context = {}) {
      const window = criteria.window ?? context.readinessWindow ?? 5
      const bySubject = new Map()
      for (const attempt of countedAttempts(facts, (item) => item.origin === 'trainer' && !item.repeat
         && item.subjectId && toHundredths(item.maxScore ?? 0) > 0)) {
         const list = bySubject.get(String(attempt.subjectId)) ?? []
         list.push(attempt)
         bySubject.set(String(attempt.subjectId), list)
      }
      let best = null
      for (const [subjectId, attempts] of bySubject) {
         for (let index = 0; index < attempts.length; index += 1) {
            const last = attempts.slice(Math.max(0, index - window + 1), index + 1)
            const score = last.reduce((sum, item) => sum + Number(item.score ?? 0), 0)
            const maxScore = last.reduce((sum, item) => sum + Number(item.maxScore), 0)
            const questions = last.reduce((sum, item) => sum + Number(item.questions ?? 0), 0)
            const readiness = round2((score * 100) / maxScore)
            if (readiness >= criteria.percent && questions >= (criteria.minQuestions ?? 0)) {
               const at = attempts[index].finishedAt
               if (!best || at < best.at) best = { at, metadata: { subjectId, readinessPercent: readiness, questions } }
               break
            }
         }
      }
      return best ? earned(best.at, best.metadata) : notYet()
   },

   // perfect_score: 100 % in a teacher or course test (authored or standalone) of at least
   // minQuestions questions.
   perfect_score(facts, criteria) {
      const attempt = countedAttempts(facts, (item) => authoredOrigins.includes(item.origin)
         && Number(item.questions) >= (criteria.minQuestions ?? 1)
         && toHundredths(item.maxScore ?? 0) > 0
         && toHundredths(item.score ?? 0) === toHundredths(item.maxScore))[0]
      return attempt ? earned(attempt.finishedAt, { attemptId: attempt.id, testId: attempt.testId }) : notYet()
   },

   // first_try_5: different authored or standalone tests passed (passPercent of the attempt's
   // policy) on attempt number 1.
   first_try_passed(facts, criteria) {
      const seen = new Set()
      const tests = []
      for (const attempt of countedAttempts(facts, (item) => authoredOrigins.includes(item.origin)
         && Number(item.attemptNumber) === 1 && passed(item))) {
         if (seen.has(String(attempt.testId))) continue
         seen.add(String(attempt.testId))
         tests.push(attempt)
      }
      return countTarget(tests, criteria.target, (attempt) => attempt.finishedAt,
         () => ({ tests: [...seen].slice(0, criteria.target) }))
   },

   // on_time_5: group assignments in order of their close time. One with a counted attempt
   // finished before closes_at continues the run; a closed one without it (that the learner
   // could take) breaks the run; an open one without it is not decided yet and is skipped.
   assignments_on_time(facts, criteria, context = {}) {
      const now = context.now ?? new Date()
      const onTime = new Map()
      for (const attempt of countedAttempts(facts, (item) => item.assignmentId)) {
         const key = String(attempt.assignmentId)
         if (!onTime.has(key)) onTime.set(key, attempt)
      }
      const ordered = [...(facts.groupAssignments ?? [])]
         .filter((assignment) => assignment.closesAt)
         .sort((left, right) => left.closesAt - right.closesAt || compareIds(left.assignmentId, right.assignmentId))
      let run = []
      let reached = null
      for (const assignment of ordered) {
         const attempt = onTime.get(String(assignment.assignmentId))
         if (attempt && attempt.finishedAt <= assignment.closesAt) {
            run.push({ assignmentId: String(assignment.assignmentId), at: attempt.finishedAt })
            if (!reached && run.length >= criteria.target) {
               const last = run.slice(-criteria.target)
               reached = {
                  at: last.reduce((max, item) => (item.at > max ? item.at : max), last[0].at),
                  metadata: { assignmentIds: last.map((item) => item.assignmentId) },
               }
            }
         } else if (assignment.closesAt <= now && assignment.eligible) {
            run = []
         }
      }
      if (reached) return earned(reached.at, reached.metadata, progressOf(criteria.target, criteria.target))
      return notYet(progressOf(run.length, criteria.target))
   },

   // mock_120: a mock exam with at least minScore points.
   mock_exam_score(facts, criteria) {
      const attempt = countedAttempts(facts, (item) => item.origin === 'mock_exam'
         && Number(item.score ?? 0) >= criteria.minScore)[0]
      return attempt ? earned(attempt.finishedAt, { attemptId: attempt.id, score: attempt.score }) : notYet()
   },

   // lessons_25: completed lessons (lesson_progress), in order of completion.
   lessons_completed(facts, criteria) {
      const lessons = [...(facts.lessons ?? [])].filter((lesson) => lesson.completedAt)
         .sort((left, right) => left.completedAt - right.completedAt || compareIds(left.lessonId, right.lessonId))
      return countTarget(lessons, criteria.target, (lesson) => lesson.completedAt,
         (lesson) => ({ lessonId: lesson.lessonId }))
   },

   // course_completed: every published lesson (of published modules) of a course with a
   // current enrollment is completed. The earliest such course is named.
   course_completed(facts, _criteria, context = {}) {
      const done = (facts.courses ?? [])
         .filter((course) => course.totalLessons > 0 && course.completedLessons >= course.totalLessons)
         .map((course) => ({ ...course, at: course.lastCompletedAt ?? context.now ?? new Date() }))
         .sort((left, right) => left.at - right.at || compareIds(left.courseId, right.courseId))
      return done[0] ? earned(done[0].at, { courseId: done[0].courseId }) : notYet()
   },

   // streak: consecutive local days (profile time zone) with learning activity: a counted
   // finished attempt, a completed lesson, or at least minWatchSeconds of new video watch time.
   activity_streak(facts, criteria, context = {}) {
      const days = activeDays(facts, criteria.minWatchSeconds ?? 0)
      const keys = [...days.keys()].sort()
      let run = 0
      let previous = null
      let reached = null
      for (const key of keys) {
         run = previous !== null && dayNumber(key) - dayNumber(previous) === 1 ? run + 1 : 1
         previous = key
         if (!reached && run >= criteria.days) reached = { at: days.get(key), metadata: { days: criteria.days, lastDay: key } }
      }
      if (reached) return earned(reached.at, reached.metadata, progressOf(criteria.days, criteria.days))
      // The current run counts only while it can still go on: its last day is today or yesterday.
      const today = localDateKey(context.now ?? new Date(), resolveTimeZone(facts.timeZone))
      const alive = previous !== null && dayNumber(today) - dayNumber(previous) <= 1
      return notYet(progressOf(alive ? run : 0, criteria.days))
   },

   // group_top3: a place within maxRank of a weekly snapshot of a group ranking (any board) with
   // at least minParticipants participants and a score above 0. Shared places all count.
   group_top3(facts, criteria) {
      const place = [...(facts.snapshots ?? [])]
         .filter((row) => (row.periodKind ?? 'week') === (criteria.periodKind ?? 'week')
            && row.rank !== null && row.rank <= criteria.maxRank
            && Number(row.score) > 0 && row.participants >= criteria.minParticipants)
         .sort((left, right) => String(left.periodStart).localeCompare(String(right.periodStart))
            || compareIds(left.groupId, right.groupId))[0]
      return place
         ? earned(place.computedAt, {
            groupId: String(place.groupId), board: place.board, periodStart: String(place.periodStart), rank: place.rank,
         })
         : notYet()
   },
}

function dayNumber(key) {
   return Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10))) / dayMs
}

// Local day key -> the first moment that made the day active.
function activeDays(facts, minWatchSeconds) {
   const timeZone = resolveTimeZone(facts.timeZone)
   const days = new Map()
   const mark = (key, at) => {
      const current = days.get(key)
      if (!current || at < current) days.set(key, at)
   }
   for (const attempt of countedAttempts(facts)) mark(localDateKey(attempt.finishedAt, timeZone), attempt.finishedAt)
   for (const lesson of facts.lessons ?? []) {
      if (lesson.completedAt) mark(localDateKey(lesson.completedAt, timeZone), lesson.completedAt)
   }
   const watched = new Map()
   for (const row of [...(facts.watch ?? [])].sort((left, right) => left.at - right.at)) {
      const key = localDateKey(row.at, timeZone)
      const total = (watched.get(key) ?? 0) + Number(row.seconds ?? 0)
      watched.set(key, total)
      if (total >= minWatchSeconds && total > 0) mark(key, row.at)
   }
   return days
}

// One catalog row against the facts. Unknown types are never earned (a newer catalog row the
// running code does not know yet).
function evaluateAchievement(achievement, facts, context = {}) {
   const check = checks[achievement.criteria?.type]
   if (!check) return notYet()
   return check(facts, achievement.criteria, context)
}

function evaluateCatalog(catalog, facts, context = {}) {
   return catalog.map((achievement) => ({ achievement, outcome: evaluateAchievement(achievement, facts, context) }))
}

const achievementCriteriaTypes = Object.freeze(Object.keys(checks))

export {
   achievementCriteriaTypes,
   activeDays,
   attemptCounts,
   evaluateAchievement,
   evaluateCatalog,
   toDate,
}
