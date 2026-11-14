import * as studentAnalyticsRepository from '../repositories/student-analytics-repository.js'
import * as studentHomeRepository from '../repositories/student-home-repository.js'
import * as attemptRepository from '../repositories/test-attempt-repository.js'
import AppError from '../utils/app-error.js'
import { scorePercent } from '../utils/attempt-grading.js'
import { attemptPassed } from '../utils/attempt-policy.js'
import { normalizeInternalId } from '../utils/internal-id.js'
import { classifyTopics, firstAttemptStats, topicRules } from '../utils/learning-metrics.js'
import { parseUserId, validationError } from './course-service.js'
import { listLearnerCoursesService } from './learner-course-service.js'
import {
   extraAttemptsFor,
   finalizeExpiredAttemptsForUserService,
   safeLearnerAssignment,
} from './test-attempt-service.js'
import { getReadinessSummaryService } from './trainer-service.js'

const origins = ['authored', 'trainer', 'mock_exam']
const homeListLimit = 10
const recentResultsLimit = 5
const weekDays = 7
// Decision D4: topics look back 90 days.
const analyticsWindowDays = 90

// Optional overrides for tests: the repositories, the clock and the overrides of the services
// this one composes (courses, trainer readiness, attempt finalization).
function dependencies(overrides = {}) {
   return {
      repository: overrides.repository || studentHomeRepository,
      analytics: overrides.analytics || studentAnalyticsRepository,
      attempts: overrides.attempts || attemptRepository,
      clock: overrides.clock || (() => new Date()),
      courses: overrides.courses,
      trainer: overrides.trainer,
      attemptServices: overrides.attemptServices,
   }
}

function iso(value) {
   return value === null || value === undefined ? null : new Date(value).toISOString()
}

async function requireActiveAccount(deps, actorId) {
   if (!await deps.attempts.isActiveAccount(actorId)) {
      throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'Account is not active')
   }
}

// One finished attempt of any kind. Trainer and mock exam attempts have no visible title or
// assignment: the client builds their titles from the origin and the subject.
function safeFinishedAttempt(row) {
   const authored = row.origin === 'authored'
   return {
      attemptId: row.id,
      origin: row.origin,
      title: authored ? row.title : null,
      testId: authored ? row.test_id : null,
      assignmentId: authored ? row.assignment_id : null,
      courseId: row.course_id ?? null,
      subjectId: row.subject_id ?? null,
      attemptNumber: row.attempt_number,
      status: row.status,
      score: row.score,
      maxScore: row.max_score,
      percent: scorePercent(row.score ?? 0, row.max_score),
      passPercent: row.policy_snapshot?.passPercent ?? null,
      passed: attemptPassed(row),
      startedAt: iso(row.started_at),
      submittedAt: iso(row.submitted_at),
   }
}

// The earliest limit the learner still has: window end, personal window end, running attempt.
function deadlineOf(assignment) {
   const limits = [assignment.closesAt, assignment.personalWindowEndsAt, assignment.attempts.deadlineAt]
      .filter((value) => value !== null)
      .map((value) => new Date(value).getTime())
   return limits.length ? new Date(Math.min(...limits)).toISOString() : null
}

function byDeadline(left, right) {
   const a = left.deadlineAt === null ? Infinity : new Date(left.deadlineAt).getTime()
   const b = right.deadlineAt === null ? Infinity : new Date(right.deadlineAt).getTime()
   return a - b || new Date(left.opensAt) - new Date(right.opensAt)
}

async function buildTests(deps, actorId, now) {
   await finalizeExpiredAttemptsForUserService(actorId, deps.attemptServices)
   const rows = await deps.attempts.listLearnerHomeAssignments(actorId, now)
   const ids = rows.map((row) => row.id)
   const [attempts, extra] = await Promise.all([
      deps.attempts.listUserAttempts(actorId, ids),
      extraAttemptsFor({ repository: deps.attempts }, actorId, ids),
   ])
   const open = []
   const upcoming = []
   for (const row of rows) {
      const mine = attempts.filter((attempt) => attempt.assignment_id === row.id)
      const assignment = {
         ...safeLearnerAssignment(row, mine, now, extra.get(row.id) ?? 0),
         courseId: row.course_id,
         courseTitle: row.course_title,
      }
      assignment.deadlineAt = deadlineOf(assignment)
      if (assignment.state === 'upcoming') {
         upcoming.push(assignment)
         continue
      }
      if (assignment.state !== 'open') continue
      const running = assignment.attempts.status === 'in_progress'
      const personalWindowOver = assignment.personalWindowEndsAt !== null
         && new Date(assignment.personalWindowEndsAt) <= now
      const hasAttempts = assignment.attempts.remainingAttempts === null
         || assignment.attempts.remainingAttempts > 0
      if (running || (hasAttempts && !personalWindowOver)) open.push(assignment)
   }
   upcoming.sort((left, right) => new Date(left.opensAt) - new Date(right.opensAt))
   return {
      open: open.sort(byDeadline).slice(0, homeListLimit),
      upcoming: upcoming.slice(0, homeListLimit),
   }
}

// Calendar arithmetic on a YYYY-MM-DD string, independent of any time zone.
function shiftDate(date, days) {
   const [year, month, day] = date.split('-').map(Number)
   return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

async function resolveTimeZone(deps, actorId) {
   const name = await deps.repository.findProfileTimezone(actorId)
   return name && await deps.repository.isValidTimeZone(name) ? name : 'UTC'
}

async function buildWeek(deps, actorId, now) {
   const timeZone = await resolveTimeZone(deps, actorId)
   const rows = await deps.repository.listWeekActivity(actorId, now, timeZone)
   const today = rows[0].today
   const days = Array.from({ length: weekDays }, (_, index) => ({
      date: shiftDate(today, index - (weekDays - 1)),
      watchSeconds: 0,
      lessonsCompleted: 0,
      attemptsFinished: 0,
   }))
   for (const row of rows) {
      const day = days.find((entry) => entry.date === row.day)
      if (!day) continue
      if (row.event_code === 'watch_hour') day.watchSeconds += row.seconds
      if (row.event_code === 'lesson_completed') day.lessonsCompleted += row.events
      if (row.event_code === 'attempt_finished') day.attemptsFinished += row.events
   }
   return {
      timeZone,
      days,
      totalWatchSeconds: days.reduce((sum, day) => sum + day.watchSeconds, 0),
   }
}

async function buildReadiness(deps, actorId) {
   const [summary, mock] = await Promise.all([
      getReadinessSummaryService(actorId, deps.trainer),
      deps.repository.findLatestFinishedMockExam(actorId),
   ])
   return {
      empty: summary.completedTrainings === 0,
      readinessPercent: summary.readinessPercent,
      completedTrainings: summary.completedTrainings,
      readinessWindow: summary.readinessWindow,
      subjects: summary.subjects,
      lastMockExam: mock === null ? null : {
         attemptId: mock.id,
         score: mock.score,
         maxScore: mock.max_score,
         percent: scorePercent(mock.score ?? 0, mock.max_score),
         submittedAt: iso(mock.submitted_at),
      },
   }
}

function buildContinueLesson(row) {
   if (!row) return null
   return {
      courseId: row.course_id,
      courseTitle: row.course_title,
      moduleId: row.module_id,
      lessonId: row.lesson_id,
      title: row.title,
      playbackSeconds: row.playback_seconds,
      durationSeconds: row.duration_seconds ?? null,
      updatedAt: iso(row.updated_at),
   }
}

// GET /me/home: everything the student home page shows, in one response. Own data only.
async function getStudentHomeService(userId, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   await requireActiveAccount(deps, actorId)
   const now = deps.clock()
   const [continueLesson, courseList, activity, tests, readiness, recent, week] = await Promise.all([
      deps.repository.findContinueLesson(actorId),
      listLearnerCoursesService(actorId, deps.courses),
      deps.repository.listCourseActivity(actorId),
      buildTests(deps, actorId, now),
      buildReadiness(deps, actorId),
      deps.repository.listFinishedAttempts(actorId, {
         origin: null,
         subjectId: null,
         limit: recentResultsLimit,
         offset: 0,
      }),
      buildWeek(deps, actorId, now),
   ])
   const lastActivity = new Map(activity.map((row) => [row.course_id, iso(row.last_activity_at)]))
   const courses = courseList.courses
      .map((course) => ({ ...course, lastActivityAt: lastActivity.get(course.id) ?? null }))
      .sort((left, right) => {
         const a = left.lastActivityAt === null ? 0 : new Date(left.lastActivityAt).getTime()
         const b = right.lastActivityAt === null ? 0 : new Date(right.lastActivityAt).getTime()
         return b - a
      })
   return {
      continueLesson: buildContinueLesson(continueLesson),
      courses,
      tests,
      readiness,
      recentResults: recent.map(safeFinishedAttempt),
      week,
      serverNow: now.toISOString(),
   }
}

function parseAttemptsQuery(query) {
   const integer = (value, field, fallback, max, min = 0) => {
      if (value === undefined) return fallback
      const parsed = Number(value)
      if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw validationError(field)
      return parsed
   }
   if (query.origin !== undefined && !origins.includes(query.origin)) throw validationError('origin')
   let subjectId = null
   if (query.subjectId !== undefined) {
      try {
         subjectId = normalizeInternalId(query.subjectId)
      } catch {
         throw validationError('subjectId')
      }
   }
   return {
      origin: query.origin ?? null,
      subjectId,
      limit: integer(query.limit, 'limit', 20, 100, 1),
      offset: integer(query.offset, 'offset', 0, 100000),
   }
}

// GET /me/attempts: finished attempts of every kind (course tests, trainer, mock exam), newest first.
async function listStudentAttemptsService(userId, query = {}, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const filters = parseAttemptsQuery(query)
   await requireActiveAccount(deps, actorId)
   const [rows, total] = await Promise.all([
      deps.repository.listFinishedAttempts(actorId, filters),
      deps.repository.countFinishedAttempts(actorId, filters),
   ])
   return {
      attempts: rows.map(safeFinishedAttempt),
      pagination: {
         limit: filters.limit,
         offset: filters.offset,
         total,
         hasMore: filters.offset + rows.length < total,
      },
   }
}

// GET /me/analytics: profile figures. Totals and first attempts are all-time; topics use the
// last analyticsWindowDays days, measured from the attempt's submit (or expiry) time.
async function getStudentAnalyticsService(userId, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   await requireActiveAccount(deps, actorId)
   const now = deps.clock()
   const since = new Date(now.getTime() - analyticsWindowDays * 86400000)
   const [totals, firstAttempts, topicRows] = await Promise.all([
      deps.analytics.findLearningTotals(actorId),
      deps.analytics.listFirstAttempts(actorId),
      deps.analytics.listTopicTotals(actorId, since),
   ])
   return {
      windowDays: analyticsWindowDays,
      since: since.toISOString(),
      totals: {
         watchSeconds: Number(totals.watch_seconds),
         lessonsCompleted: totals.lessons_completed,
         attemptsFinished: totals.attempts_finished,
      },
      firstAttempt: firstAttemptStats(firstAttempts),
      topics: {
         minQuestions: topicRules.minQuestions,
         weakBelowPercent: topicRules.weakBelowPercent,
         strongFromPercent: topicRules.strongFromPercent,
         ...classifyTopics(topicRows),
      },
   }
}

export { getStudentAnalyticsService, getStudentHomeService, listStudentAttemptsService, safeFinishedAttempt }
