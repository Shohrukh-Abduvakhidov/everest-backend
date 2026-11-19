import env from '../configs/env.js'
import * as staffProgressRepository from '../repositories/stats/staff-progress-repository.js'
import AppError from '../utils/app-error.js'
import { scorePercent, toHundredths } from '../utils/attempt-grading.js'
import {
   attemptPassed,
   attemptsUsed,
   effectiveMaxAttempts,
   isFinished,
   selectResultAttempt,
} from '../utils/attempt-policy.js'
import {
   behindReasons,
   behindRules,
   belowPass,
   laggingCourses,
   overallReadiness,
} from '../utils/learning-metrics.js'
import { parseCourseId, parseId, parsePagination, parseUserId, validationError } from './course-service.js'
import { parseGroupId } from './group-service.js'
import {
   buildFinishedAttempts,
   buildStudentAnalytics,
   buildStudentHome,
   parseAttemptsQuery,
   studentHomeDependencies,
} from './student-home-service.js'

// M12 PR 3: read-only progress views for staff. Scope (decision D1) is checked in the
// repository queries; anything outside it answers 404 so existence is not disclosed. Every
// figure is computed for the whole group, course or audience from a fixed number of aggregate
// queries, then sorted and paged here.

const recentResultsLimit = 3
const latestMissedLimit = 3
const studentAttemptsLimit = 20
const sortOrders = ['asc', 'desc']

function dependencies(overrides = {}) {
   return {
      repository: overrides.repository || staffProgressRepository,
      clock: overrides.clock || (() => new Date()),
      readinessWindow: overrides.readinessWindow || env.trainer.readinessWindow,
      home: overrides.home,
   }
}

function iso(value) {
   return value === null || value === undefined ? null : new Date(value).toISOString()
}

function displayName(row) {
   return [row.first_name, row.last_name].filter(Boolean).join(' ') || null
}

function round2(value) {
   return Math.round(value * 100) / 100
}

function mean(values) {
   return values.length ? round2(values.reduce((sum, value) => sum + value, 0) / values.length) : null
}

function groupBy(rows, key = 'user_id') {
   const map = new Map()
   for (const row of rows) map.set(row[key], [...(map.get(row[key]) ?? []), row])
   return map
}

function lessonPercent(completed, total) {
   return total === 0 ? 0 : Math.floor((completed * 100) / total)
}

function notFound(code, message) {
   return new AppError(404, code, message)
}

// ---------------------------------------------------------------- query parsing

function parseListQuery(query, sorts, defaultSort) {
   const { limit, offset } = parsePagination(query)
   const sort = query.sort ?? defaultSort
   if (!sorts.includes(sort)) throw validationError('sort')
   const order = query.order ?? (sort === 'name' ? 'asc' : 'desc')
   if (!sortOrders.includes(order)) throw validationError('order')
   let behind = null
   if (query.behind !== undefined) {
      if (query.behind !== 'true' && query.behind !== 'false') throw validationError('behind')
      behind = query.behind === 'true'
   }
   return { limit, offset, sort, order, behind }
}

// Nulls always sort last; the name, then the user id break ties so pages are stable.
function sortRows(rows, { sort, order }, valueOf) {
   const direction = order === 'asc' ? 1 : -1
   const byName = (left, right) => (left.name ?? '').localeCompare(right.name ?? '')
      || (BigInt(left.userId) < BigInt(right.userId) ? -1 : 1)
   return [...rows].sort((left, right) => {
      if (sort === 'name') return direction * byName(left, right)
      const a = valueOf(left, sort)
      const b = valueOf(right, sort)
      if (a === null && b === null) return byName(left, right)
      if (a === null) return 1
      if (b === null) return -1
      return direction * (a - b) || byName(left, right)
   })
}

function page(rows, filters) {
   const filtered = filters.behind === null
      ? rows
      : rows.filter((row) => row.behind.isBehind === filters.behind)
   return {
      items: filtered.slice(filters.offset, filters.offset + filters.limit),
      pagination: {
         limit: filters.limit,
         offset: filters.offset,
         total: filtered.length,
         hasMore: filters.offset + filters.limit < filtered.length,
      },
   }
}

// ---------------------------------------------------------------- student rows

function safeRecentResult(row) {
   return {
      attemptId: row.id,
      testId: row.test_id,
      assignmentId: row.assignment_id,
      courseId: row.course_id,
      title: row.title,
      attemptNumber: row.attempt_number,
      status: row.status,
      score: row.score,
      maxScore: row.max_score,
      percent: scorePercent(row.score ?? 0, row.max_score),
      passPercent: row.policy_snapshot?.passPercent ?? null,
      passed: attemptPassed(row),
      submittedAt: iso(row.submitted_at),
   }
}

function safeCourseProgress(row) {
   const total = row.total_lessons
   const completed = row.completed_lessons
   const started = row.started_lessons
   return {
      courseId: row.course_id,
      title: row.course_title,
      enrollmentActive: row.enrollment_active,
      totalPublishedLessons: row.total_published_lessons,
      totalLessons: total,
      completedLessons: completed,
      startedLessons: started,
      notStartedLessons: Math.max(0, total - completed - started),
      percent: lessonPercent(completed, total),
   }
}

// One row per student with every figure of the summary and the D5 reasons. courseId limits
// lessons, results and assignments to one course; readiness is left out then (the trainer is
// not part of a course, decision D1).
async function buildStudentRows(deps, students, now, { courseId = null, readiness = true } = {}) {
   if (!students.length) return []
   const userIds = students.map((student) => student.user_id)
   const { repository } = deps
   const [activity, progress, windows, recent, thresholds, missed] = await Promise.all([
      repository.listLastActivity(userIds),
      repository.listCourseProgress(userIds, courseId, now),
      readiness ? repository.listReadinessWindows(userIds, deps.readinessWindow) : [],
      repository.listRecentTestResults(userIds, courseId, recentResultsLimit),
      repository.listPassThresholdResults(userIds, courseId, behindRules.belowPassTests),
      repository.listMissedAssignments(userIds, now, courseId),
   ])
   const lastActivity = new Map(activity.map((row) => [row.user_id, row.last_activity_at]))
   const progressBy = groupBy(progress)
   const windowsBy = groupBy(windows)
   const recentBy = groupBy(recent)
   const thresholdsBy = groupBy(thresholds)
   const missedBy = groupBy(missed)
   const rows = students.map((student) => {
      const courses = (progressBy.get(student.user_id) ?? []).map(safeCourseProgress)
      const active = courses.filter((course) => course.enrollmentActive)
      const total = active.reduce((sum, course) => sum + course.totalLessons, 0)
      const completed = active.reduce((sum, course) => sum + course.completedLessons, 0)
      const studentWindows = windowsBy.get(student.user_id) ?? []
      const studentMissed = missedBy.get(student.user_id) ?? []
      return {
         userId: student.user_id,
         name: displayName(student),
         accountStatus: student.account_status,
         lastLoginAt: iso(student.last_login_at),
         lastActivityAt: iso(lastActivity.get(student.user_id)),
         ...(readiness ? {
            readiness: {
               readinessPercent: overallReadiness(studentWindows),
               completedTrainings: studentWindows[0]?.trainings ?? 0,
            },
         } : {}),
         progressPercent: total === 0 ? null : lessonPercent(completed, total),
         courses,
         recentResults: (recentBy.get(student.user_id) ?? []).map(safeRecentResult),
         missedAssignments: {
            count: studentMissed.length,
            latest: studentMissed.slice(0, latestMissedLimit).map((row) => ({
               assignmentId: row.assignment_id,
               testId: row.test_id,
               courseId: row.course_id,
               title: row.title,
               closesAt: iso(row.closes_at),
            })),
         },
         belowPassThreshold: belowPass(thresholdsBy.get(student.user_id) ?? []),
      }
   })
   const lagging = laggingCourses(rows)
   for (const row of rows) {
      row.courses = row.courses.map((course) => ({ ...course, lagging: lagging(course) }))
      const reasons = behindReasons({
         lastActivityAt: row.lastActivityAt,
         now,
         missedAssignments: row.missedAssignments.count,
         belowPassThreshold: row.belowPassThreshold,
         lagging: row.courses.some((course) => course.lagging),
      })
      row.behind = { isBehind: reasons.length > 0, reasons }
   }
   return rows
}

function studentSortValue(row, sort) {
   if (sort === 'lastActivity') return row.lastActivityAt === null ? null : new Date(row.lastActivityAt).getTime()
   if (sort === 'readiness') return row.readiness?.readinessPercent ?? null
   if (sort === 'progress') return row.progressPercent
   if (sort === 'behind') return row.behind.reasons.length
   return null
}

function courseOverview(rows) {
   const byCourse = new Map()
   for (const row of rows) {
      for (const course of row.courses) {
         const entry = byCourse.get(course.courseId) ?? { courseId: course.courseId, title: course.title, students: 0, activeStudents: 0, percents: [] }
         entry.students += 1
         if (course.enrollmentActive) {
            entry.activeStudents += 1
            entry.percents.push(course.percent)
         }
         byCourse.set(course.courseId, entry)
      }
   }
   return [...byCourse.values()]
      .map(({ percents, ...course }) => ({ ...course, averagePercent: mean(percents) }))
      .sort((left, right) => left.title.localeCompare(right.title) || (BigInt(left.courseId) < BigInt(right.courseId) ? -1 : 1))
}

// ---------------------------------------------------------------- group summary

// GET /admin/groups/:groupId/progress
async function getGroupProgressService(userId, groupIdValue, query = {}, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const groupId = parseGroupId(groupIdValue)
   const filters = parseListQuery(query, ['name', 'lastActivity', 'readiness', 'progress', 'behind'], 'name')
   const group = await deps.repository.findProgressGroup(actorId, groupId)
   if (!group) throw notFound('GROUP_NOT_FOUND', 'Group was not found')
   const now = deps.clock()
   const students = await deps.repository.listGroupStudents(groupId)
   const rows = await buildStudentRows(deps, students, now)
   const { items, pagination } = page(sortRows(rows, filters, studentSortValue), filters)
   return {
      group: { id: group.id, code: group.code, title: group.title, status: group.status },
      totals: {
         students: rows.length,
         behind: rows.filter((row) => row.behind.isBehind).length,
         withoutActivity7d: rows.filter((row) => row.behind.reasons.includes('no_activity_7d')).length,
         averageReadinessPercent: mean(rows.map((row) => row.readiness.readinessPercent).filter((value) => value !== null)),
         averageProgressPercent: mean(rows.map((row) => row.progressPercent).filter((value) => value !== null)),
      },
      courses: courseOverview(rows),
      rules: behindRules,
      students: items,
      pagination,
      serverNow: now.toISOString(),
   }
}

// ---------------------------------------------------------------- course summary

function buildModules(lessons, moduleProgress, studentCount) {
   const byLesson = new Map()
   for (const row of moduleProgress) {
      const counts = byLesson.get(row.lesson_id) ?? { completed: 0, started: 0 }
      if (row.status === 'completed') counts.completed += 1
      else counts.started += 1
      byLesson.set(row.lesson_id, counts)
   }
   const modules = new Map()
   for (const lesson of lessons) {
      const module = modules.get(lesson.module_id) ?? {
         moduleId: lesson.module_id,
         title: lesson.module_title,
         position: lesson.module_position,
         lessonCount: 0,
         lessons: [],
      }
      const counts = byLesson.get(lesson.lesson_id) ?? { completed: 0, started: 0 }
      module.lessonCount += 1
      module.lessons.push({
         lessonId: lesson.lesson_id,
         title: lesson.title,
         position: lesson.position,
         lessonType: lesson.lesson_type,
         completed: counts.completed,
         started: counts.started,
         notStarted: Math.max(0, studentCount - counts.completed - counts.started),
         completedPercent: studentCount === 0 ? 0 : lessonPercent(counts.completed, studentCount),
      })
      modules.set(lesson.module_id, module)
   }
   return [...modules.values()]
}

function studentModules(modules, rows) {
   const counts = new Map()
   for (const row of rows) {
      const entry = counts.get(row.module_id) ?? { completed: 0, started: 0 }
      if (row.status === 'completed') entry.completed += 1
      else entry.started += 1
      counts.set(row.module_id, entry)
   }
   return modules.map((module) => {
      const entry = counts.get(module.moduleId) ?? { completed: 0, started: 0 }
      return {
         moduleId: module.moduleId,
         totalLessons: module.lessonCount,
         completedLessons: entry.completed,
         startedLessons: entry.started,
         notStartedLessons: Math.max(0, module.lessonCount - entry.completed - entry.started),
         percent: lessonPercent(entry.completed, module.lessonCount),
      }
   })
}

// GET /admin/courses/:courseId/progress
async function getCourseProgressService(userId, courseIdValue, query = {}, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const filters = parseListQuery(query, ['name', 'lastActivity', 'progress', 'behind'], 'name')
   const course = await deps.repository.findProgressCourse(actorId, courseId)
   if (!course) throw notFound('COURSE_NOT_FOUND', 'Course was not found')
   const now = deps.clock()
   const students = await deps.repository.listCourseStudents(courseId, now)
   const userIds = students.map((student) => student.user_id)
   const [lessons, moduleProgress, studentRows] = await Promise.all([
      deps.repository.listCourseLessons(courseId),
      userIds.length ? deps.repository.listModuleProgress(courseId, userIds) : [],
      buildStudentRows(deps, students, now, { courseId, readiness: false }),
   ])
   const modules = buildModules(lessons, moduleProgress, students.length)
   const progressBy = groupBy(moduleProgress)
   const rows = studentRows.map(({ courses, progressPercent: _overall, ...row }) => {
      const progress = courses[0] ?? null
      return {
         ...row,
         enrollmentActive: progress?.enrollmentActive ?? false,
         progress: progress === null ? null : {
            totalPublishedLessons: progress.totalPublishedLessons,
            totalLessons: progress.totalLessons,
            completedLessons: progress.completedLessons,
            startedLessons: progress.startedLessons,
            notStartedLessons: progress.notStartedLessons,
            percent: progress.percent,
            lagging: progress.lagging,
         },
         modules: studentModules(modules, progressBy.get(row.userId) ?? []),
      }
   })
   const active = rows.filter((row) => row.enrollmentActive && row.progress)
   const valueOf = (row, sort) => (sort === 'progress' ? row.progress?.percent ?? null : studentSortValue(row, sort))
   const { items, pagination } = page(sortRows(rows, filters, valueOf), filters)
   return {
      course: { id: course.id, title: course.title, status: course.status },
      totals: {
         students: rows.length,
         activeStudents: active.length,
         lessons: lessons.length,
         averagePercent: mean(active.map((row) => row.progress.percent)),
         averageCompletedLessons: mean(active.map((row) => row.progress.completedLessons)),
         completedCourse: active.filter((row) => row.progress.totalLessons > 0 && row.progress.percent === 100).length,
         notStarted: rows.filter((row) => !row.progress || (row.progress.completedLessons === 0 && row.progress.startedLessons === 0)).length,
         behind: rows.filter((row) => row.behind.isBehind).length,
      },
      modules: modules.map((module) => ({
         ...module,
         averagePercent: mean(active.map((row) => row.modules.find((entry) => entry.moduleId === module.moduleId).percent)),
      })),
      rules: behindRules,
      students: items,
      pagination,
      serverNow: now.toISOString(),
   }
}

// ---------------------------------------------------------------- one student

async function requireStudentScope(deps, actorId, studentId) {
   const scope = await deps.repository.findStudentScope(actorId, studentId)
   const full = Boolean(scope && (scope.administrator || scope.via_group))
   if (!scope || (!full && scope.course_ids.length === 0)) throw notFound('USER_NOT_FOUND', 'User was not found')
   return {
      student: {
         id: scope.id,
         name: displayName(scope),
         accountStatus: scope.status,
         lastLoginAt: iso(scope.last_login_at),
      },
      scope: { kind: full ? 'full' : 'courses', courseIds: full ? null : scope.course_ids },
   }
}

// GET /admin/users/:userId/analytics: what the student sees on /me/home and /me/analytics plus
// the first page of their finished attempts. A course-limited scope keeps only those courses
// and leaves readiness, the week and the profile analytics out (they span every course).
async function getStaffStudentAnalyticsService(userId, studentIdValue, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const studentId = parseUserId(studentIdValue)
   const { student, scope } = await requireStudentScope(deps, actorId, studentId)
   const homeDeps = studentHomeDependencies(deps.home)
   const now = deps.clock()
   const view = { courseIds: scope.courseIds, staff: true }
   const [home, analytics, attempts] = await Promise.all([
      buildStudentHome(homeDeps, studentId, now, view),
      scope.kind === 'full' ? buildStudentAnalytics(homeDeps, studentId, now) : null,
      buildFinishedAttempts(homeDeps, studentId, {
         origin: null,
         subjectId: null,
         limit: studentAttemptsLimit,
         offset: 0,
         courseIds: scope.courseIds,
      }),
   ])
   return { student, scope, home, analytics, attempts }
}

// GET /admin/users/:userId/attempts: the finished-attempt history with the /me/attempts filters.
async function listStaffStudentAttemptsService(userId, studentIdValue, query = {}, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const studentId = parseUserId(studentIdValue)
   const filters = parseAttemptsQuery(query)
   const { scope } = await requireStudentScope(deps, actorId, studentId)
   return buildFinishedAttempts(studentHomeDependencies(deps.home), studentId, {
      ...filters,
      courseIds: scope.courseIds,
   })
}

// ---------------------------------------------------------------- assignment results

const resultStatuses = ['passed', 'failed', 'finished', 'in_progress', 'not_started']

function audienceOf(assignment) {
   if (assignment.group_id !== null) return { type: 'group', id: assignment.group_id }
   if (assignment.user_id !== null) return { type: 'user', id: assignment.user_id }
   if (assignment.course_id !== null) return { type: 'course', id: assignment.course_id }
   return { type: 'lesson', id: assignment.lesson_id }
}

function resultRow(student, attempts, assignment, extra) {
   const used = attemptsUsed(attempts)
   const result = selectResultAttempt(assignment.result_policy, attempts)
   const finished = attempts.filter((attempt) => isFinished(attempt) && toHundredths(attempt.max_score ?? 0) > 0)
   const passed = result ? attemptPassed(result) : null
   let status = 'not_started'
   if (result) status = passed === true ? 'passed' : passed === false ? 'failed' : 'finished'
   else if (attempts.some((attempt) => attempt.status === 'in_progress' || attempt.status === 'paused')) status = 'in_progress'
   const percentOf = (attempt) => scorePercent(attempt.score ?? 0, attempt.max_score)
   return {
      userId: student.user_id,
      name: displayName(student),
      status,
      attemptsUsed: used,
      maxAttempts: effectiveMaxAttempts(assignment.max_attempts, extra),
      result: result && toHundredths(result.max_score ?? 0) > 0 ? {
         attemptId: result.id,
         attemptNumber: result.attempt_number,
         score: result.score,
         maxScore: result.max_score,
         percent: percentOf(result),
         passed,
         submittedAt: iso(result.submitted_at),
      } : null,
      bestPercent: finished.length ? Math.max(...finished.map(percentOf)) : null,
      lastSubmittedAt: iso(finished.map((attempt) => attempt.submitted_at).filter(Boolean)
         .sort((left, right) => new Date(right) - new Date(left))[0] ?? null),
   }
}

// GET /admin/tests/:testId/assignments/:assignmentId/results
async function getAssignmentResultsService(userId, testIdValue, assignmentIdValue, query = {}, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const testId = parseId(testIdValue, 'INVALID_TEST_ID', 'Test identifier is invalid')
   const assignmentId = parseId(assignmentIdValue, 'INVALID_ASSIGNMENT_ID', 'Assignment identifier is invalid')
   const { limit, offset } = parsePagination(query)
   const sort = query.sort ?? 'name'
   if (!['name', 'percent', 'attempts', 'status'].includes(sort)) throw validationError('sort')
   const order = query.order ?? (sort === 'name' ? 'asc' : 'desc')
   if (!sortOrders.includes(order)) throw validationError('order')
   if (query.status !== undefined && !resultStatuses.includes(query.status)) throw validationError('status')
   const assignment = await deps.repository.findResultsAssignment(actorId, testId, assignmentId)
   if (!assignment) throw notFound('ASSIGNMENT_NOT_FOUND', 'Assignment was not found')
   const [students, attempts, grants] = await Promise.all([
      deps.repository.listAssignmentStudents(assignment),
      deps.repository.listAssignmentAttempts(assignmentId),
      deps.repository.listAssignmentExtraAttempts(assignmentId),
   ])
   const attemptsBy = groupBy(attempts)
   const extraBy = new Map(grants.map((row) => [row.user_id, row.extra]))
   const rows = students.map((student) => resultRow(
      student,
      attemptsBy.get(student.user_id) ?? [],
      assignment,
      extraBy.get(student.user_id) ?? 0,
   ))
   const results = rows.filter((row) => row.result)
   const statusRank = (row) => resultStatuses.length - resultStatuses.indexOf(row.status)
   const valueOf = (row, key) => {
      if (key === 'percent') return row.result?.percent ?? null
      if (key === 'attempts') return row.attemptsUsed
      return statusRank(row)
   }
   const sorted = sortRows(rows, { sort, order }, valueOf)
   const filtered = query.status === undefined ? sorted : sorted.filter((row) => row.status === query.status)
   const count = (status) => rows.filter((row) => row.status === status).length
   return {
      test: {
         id: assignment.test_id,
         title: assignment.title,
         maxAttempts: assignment.max_attempts,
         resultPolicy: assignment.result_policy,
         passPercent: assignment.grading_policy?.passPercent ?? null,
      },
      assignment: {
         id: assignment.id,
         status: assignment.status,
         opensAt: iso(assignment.opens_at),
         closesAt: iso(assignment.closes_at),
         audience: audienceOf(assignment),
      },
      totals: {
         students: rows.length,
         notStarted: count('not_started'),
         inProgress: count('in_progress'),
         finished: results.length,
         passed: count('passed'),
         failed: count('failed'),
         attempts: rows.reduce((sum, row) => sum + row.attemptsUsed, 0),
         averagePercent: mean(results.map((row) => row.result.percent)),
         averageScore: mean(results.map((row) => Number(row.result.score ?? 0))),
      },
      students: filtered.slice(offset, offset + limit),
      pagination: { limit, offset, total: filtered.length, hasMore: offset + limit < filtered.length },
      serverNow: deps.clock().toISOString(),
   }
}

export {
   getAssignmentResultsService,
   getCourseProgressService,
   getGroupProgressService,
   getStaffStudentAnalyticsService,
   listStaffStudentAttemptsService,
}
