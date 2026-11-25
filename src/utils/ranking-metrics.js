import { scorePercent, toHundredths } from './attempt-grading.js'
import { selectResultAttempt } from './attempt-policy.js'

// M13 group ranking (decisions.md 2026-11-25, owner's variant C). Pure functions only: the
// repository returns the raw facts of one group, everything below turns them into scores and
// places. formulaVersion changes whenever a rule here changes.

const formulaVersion = 1
const rankingTimeZone = 'Asia/Dushanbe'
const rankingBoards = ['performance', 'activity']
const rankingPeriods = ['week', 'month', 'all']
const rankingVisibilities = ['full', 'top10_self', 'staff_only']
const defaultVisibility = 'top10_self'
const topPlaces = 10

const activityRules = Object.freeze({
   trainerDailyCap: 60,
   minAnsweredShare: 0.5,
   minSecondsPerAnswer: 3,
   mockExamMaxScore: 160,
   mockExamPoints: 50,
   lessonPoints: 5,
   lessonsPerDay: 10,
})

function round2(value) {
   return Math.round(value * 100) / 100
}

function toDate(value) {
   return value === null || value === undefined ? null : new Date(value)
}

// ---------------------------------------------------------------- time zone

function zoneParts(instant, timeZone) {
   const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
   }).formatToParts(instant).map((part) => [part.type, part.value]))
   return {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
      hour: Number(parts.hour),
      minute: Number(parts.minute),
      second: Number(parts.second),
   }
}

function zoneOffsetMs(instant, timeZone) {
   const local = zoneParts(instant, timeZone)
   const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second)
   return asUtc - Math.floor(instant.getTime() / 1000) * 1000
}

// The instant of local midnight of a calendar date (month may overflow, Date.UTC normalizes it).
function localMidnight(year, month, day, timeZone) {
   const naive = Date.UTC(year, month - 1, day)
   let instant = new Date(naive - zoneOffsetMs(new Date(naive), timeZone))
   // A second pass settles a date whose offset differs from the first guess (DST zones).
   instant = new Date(naive - zoneOffsetMs(instant, timeZone))
   return instant
}

function localDateKey(instant, timeZone = rankingTimeZone) {
   const { year, month, day } = zoneParts(instant, timeZone)
   return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// Monday 0 ... Sunday 6 of the local date.
function localWeekday(year, month, day) {
   return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7
}

// The Monday (local date key) of the week an instant falls in.
function localWeekKey(instant, timeZone = rankingTimeZone) {
   const { year, month, day } = zoneParts(instant, timeZone)
   const monday = new Date(Date.UTC(year, month - 1, day - localWeekday(year, month, day)))
   return monday.toISOString().slice(0, 10)
}

// week: Monday 00:00 to the next Monday; month: the calendar month; all: no bounds (each
// participant then counts from their joined_at). Bounds are local midnights in the zone.
function periodBounds(period, now, timeZone = rankingTimeZone) {
   if (period === 'all') return { start: null, end: null }
   const { year, month, day } = zoneParts(now, timeZone)
   if (period === 'week') {
      const first = day - localWeekday(year, month, day)
      return {
         start: localMidnight(year, month, first, timeZone),
         end: localMidnight(year, month, first + 7, timeZone),
      }
   }
   if (period === 'month') {
      return {
         start: localMidnight(year, month, 1, timeZone),
         end: localMidnight(year, month + 1, 1, timeZone),
      }
   }
   throw new TypeError(`Unknown ranking period ${period}`)
}

// A participant's own window: the period, but never before they joined the group.
function participantWindow(bounds, joinedAt) {
   const joined = toDate(joinedAt)
   const start = bounds.start && joined ? new Date(Math.max(bounds.start.getTime(), joined.getTime())) : (bounds.start ?? joined)
   return { start, end: bounds.end }
}

function inWindow(at, window) {
   if (!at) return false
   const time = at.getTime()
   if (window.start && time < window.start.getTime()) return false
   if (window.end && time >= window.end.getTime()) return false
   return true
}

// ---------------------------------------------------------------- performance

// One group assignment that counts for the ranking, for one participant.
//   The counted attempt follows the test's result policy. Its percent is the score; the time
//   that places it in a period is closes_at, or the counted attempt's finish time without one.
//   Closed without a finished attempt: 0 at closes_at. Still open without one: not counted.
//   A course test the participant is not enrolled in (eligible false) counts only with an attempt.
// Returns null when the assignment does not count (yet).
function assignmentOutcome({ resultPolicy, closesAt, eligible = true, attempts = [] }, now) {
   const counted = selectResultAttempt(resultPolicy, attempts)
   const closes = toDate(closesAt)
   if (counted) {
      const finishedAt = toDate(counted.finished_at)
      return {
         percent: counted.max_score && toHundredths(counted.max_score) > 0
            ? scorePercent(counted.score ?? 0, counted.max_score)
            : 0,
         at: closes ?? finishedAt,
         submitted: true,
         finishedAt,
      }
   }
   if (!eligible || !closes || closes > now) return null
   return { percent: 0, at: closes, submitted: false, finishedAt: null }
}

// The average percent over the counted assignments of the window (0-100, 2 decimals); null with
// none. onTime counts the submitted ones (a start after closes_at is impossible, so every
// finished attempt is on time); lastCountedAt is the latest finish among them.
function performanceScore(assignments, window, now) {
   const outcomes = assignments
      .map((assignment) => assignmentOutcome(assignment, now))
      .filter((outcome) => outcome && inWindow(outcome.at, window))
   const submitted = outcomes.filter((outcome) => outcome.submitted)
   const lastCountedAt = submitted.reduce((latest, outcome) => (
      !latest || outcome.finishedAt > latest ? outcome.finishedAt : latest
   ), null)
   return {
      score: outcomes.length
         ? round2(outcomes.reduce((sum, outcome) => sum + outcome.percent, 0) / outcomes.length)
         : null,
      onTime: submitted.length,
      lastCountedAt,
      breakdown: {
         assignments: outcomes.length,
         submitted: submitted.length,
         missed: outcomes.length - submitted.length,
      },
   }
}

// ---------------------------------------------------------------- activity

function difficultyMultiplier(difficulty) {
   if (difficulty === 3) return 1.5
   if (difficulty === 4 || difficulty === 5) return 2
   return 1
}

// Whether a finished trainer attempt may earn points: at least half of its questions answered
// and, on average, at least 3 seconds per answered question.
function trainerAttemptCounts({ questions, answered, seconds }) {
   if (!questions || !answered) return false
   if (answered < questions * activityRules.minAnsweredShare) return false
   return seconds >= answered * activityRules.minSecondsPerAnswer
}

function byTime(left, right) {
   return left.at - right.at
}

// All finished trainer attempts of one learner, ever (solved = questions with full marks). Only
// attempts that count are considered; the first of them to solve a question earns it, so the
// same question never earns twice. Ties in time go to the lower attempt id.
function firstSolves(attempts) {
   const seen = new Set()
   const solves = []
   const ordered = [...attempts].sort((left, right) => left.at - right.at
      || (BigInt(left.attemptId) < BigInt(right.attemptId) ? -1 : 1))
   for (const attempt of ordered) {
      if (!trainerAttemptCounts(attempt)) continue
      for (const question of attempt.solved ?? []) {
         const key = String(question.questionId)
         if (seen.has(key)) continue
         seen.add(key)
         solves.push({ at: attempt.at, difficulty: question.difficulty ?? null })
      }
   }
   return solves
}

// solves: the first full-mark solve of each question ever (in an attempt that counts), with the
// attempt's finish time. +1 x difficulty multiplier, at most 60 points per local day.
function trainerPoints(solves, timeZone = rankingTimeZone) {
   const usedByDay = new Map()
   let points = 0
   let lastAt = null
   for (const solve of [...solves].sort(byTime)) {
      const day = localDateKey(solve.at, timeZone)
      const used = usedByDay.get(day) ?? 0
      const earned = Math.min(difficultyMultiplier(solve.difficulty), activityRules.trainerDailyCap - used)
      if (earned <= 0) continue
      usedByDay.set(day, used + earned)
      points += earned
      lastAt = solve.at
   }
   return { points: round2(points), lastAt }
}

// The best mock exam of each local week counts: score / 160 x 50.
function mockExamPoints(attempts, timeZone = rankingTimeZone) {
   const bestByWeek = new Map()
   for (const attempt of attempts) {
      const week = localWeekKey(attempt.at, timeZone)
      const best = bestByWeek.get(week)
      if (!best || Number(attempt.score) > Number(best.score)) bestByWeek.set(week, attempt)
   }
   let points = 0
   let lastAt = null
   for (const best of bestByWeek.values()) {
      points += (Number(best.score ?? 0) / activityRules.mockExamMaxScore) * activityRules.mockExamPoints
      if (!lastAt || best.at > lastAt) lastAt = best.at
   }
   return { points: round2(points), lastAt, counted: bestByWeek.size }
}

// +5 for the first completion of a lesson, at most 10 lessons per local day.
function lessonPoints(completions, timeZone = rankingTimeZone) {
   const countByDay = new Map()
   let lessons = 0
   let lastAt = null
   for (const completion of [...completions].sort(byTime)) {
      const day = localDateKey(completion.at, timeZone)
      const count = countByDay.get(day) ?? 0
      if (count >= activityRules.lessonsPerDay) continue
      countByDay.set(day, count + 1)
      lessons += 1
      lastAt = completion.at
   }
   return { points: lessons * activityRules.lessonPoints, lastAt, counted: lessons }
}

function latest(...values) {
   return values.filter(Boolean).reduce((max, value) => (!max || value > max ? value : max), null)
}

// The sum of the three parts inside the window; daily caps apply per local day.
function activityScore({ solves = [], mockExams = [], lessons = [] }, window, timeZone = rankingTimeZone) {
   const inside = (items) => items.filter((item) => inWindow(item.at, window))
   const trainer = trainerPoints(inside(solves), timeZone)
   const mock = mockExamPoints(inside(mockExams), timeZone)
   const lesson = lessonPoints(inside(lessons), timeZone)
   return {
      score: round2(trainer.points + mock.points + lesson.points),
      lastCountedAt: latest(trainer.lastAt, mock.lastAt, lesson.lastAt),
      breakdown: {
         trainerPoints: trainer.points,
         mockExamPoints: mock.points,
         mockExamsCounted: mock.counted,
         lessonPoints: lesson.points,
         lessonsCounted: lesson.counted,
      },
   }
}

// ---------------------------------------------------------------- places

function compareNames(left, right) {
   return (left.lastName ?? '').localeCompare(right.lastName ?? '', 'ru')
      || (left.firstName ?? '').localeCompare(right.firstName ?? '', 'ru')
      || (BigInt(left.userId) < BigInt(right.userId) ? -1 : BigInt(left.userId) > BigInt(right.userId) ? 1 : 0)
}

// Order: score (hundredths) desc; then more assignments submitted on time; then the earlier last
// counted attempt; then the name. Places follow the 1-2-2-4 scheme on scores equal to the
// hundredth. A participant without a score (null) gets no place and goes last.
function rankParticipants(rows) {
   const sorted = [...rows].sort((left, right) => {
      const a = left.score === null ? null : toHundredths(left.score)
      const b = right.score === null ? null : toHundredths(right.score)
      if (a !== b) {
         if (a === null) return 1
         if (b === null) return -1
         return b - a
      }
      if (left.onTime !== right.onTime) return right.onTime - left.onTime
      const leftAt = left.lastCountedAt ? left.lastCountedAt.getTime() : null
      const rightAt = right.lastCountedAt ? right.lastCountedAt.getTime() : null
      if (leftAt !== rightAt) {
         if (leftAt === null) return 1
         if (rightAt === null) return -1
         return leftAt - rightAt
      }
      return compareNames(left, right)
   })
   let rank = 0
   let previous = null
   return sorted.map((row, index) => {
      if (row.score === null) return { ...row, rank: null }
      const hundredths = toHundredths(row.score)
      if (hundredths !== previous) {
         rank = index + 1
         previous = hundredths
      }
      return { ...row, rank }
   })
}

// What a student may see: full, places 1-10 (everyone sharing place 10 included), or nothing.
function visibleRows(ranked, visibility) {
   if (visibility === 'full') return ranked
   if (visibility === 'top10_self') return ranked.filter((row) => row.rank !== null && row.rank <= topPlaces)
   return []
}

export {
   activityRules,
   activityScore,
   assignmentOutcome,
   defaultVisibility,
   difficultyMultiplier,
   firstSolves,
   formulaVersion,
   lessonPoints,
   localDateKey,
   localWeekKey,
   mockExamPoints,
   participantWindow,
   performanceScore,
   periodBounds,
   rankingBoards,
   rankingPeriods,
   rankingTimeZone,
   rankingVisibilities,
   rankParticipants,
   trainerAttemptCounts,
   trainerPoints,
   visibleRows,
   zoneOffsetMs,
}
