import env from '../configs/env.js'
import * as jobRepository from '../repositories/job-repository.js'
import * as achievementRepository from '../repositories/stats/achievement-repository.js'
import * as staffProgressRepository from '../repositories/stats/staff-progress-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import { evaluateCatalog } from '../utils/achievement-rules.js'
import AppError from '../utils/app-error.js'
import { normalizeInternalId } from '../utils/internal-id.js'
import { formulaVersion, localDateKey, periodBounds, rankingBoards, rankingTimeZone } from '../utils/ranking-metrics.js'
import { parseUserId } from './course-service.js'
import { computeGroupRankingForPeriodService } from './group-ranking-service.js'
import { enqueueAchievementUnlocked } from './notification-service.js'
import { requireStudentScope } from './staff-progress-service.js'

// M13 achievements and ranking snapshots (decisions.md 2026-11-26).
// - Domain services call enqueueAchievementEvaluation inside their own transaction (outbox), so
//   a rolled-back attempt or lesson leaves no job. worker:jobs runs achievements.evaluate: it
//   reads the learner's whole history, the pure checks of utils/achievement-rules.js decide,
//   new awards are INSERT ... ON CONFLICT DO NOTHING and each really new one gets a notification.
// - Scheduled jobs (worker:jobs, keys by date so a restart or a second run never duplicates):
//   the daily streak run, the weekly snapshot (+ group_top3) and the monthly snapshot.
// - Awards are never taken back (a regrade or a revoked enrollment keeps them).

const evaluateJobType = 'achievements.evaluate'
const assignmentJobType = 'achievements.assignment'
const streakJobType = 'achievements.streaks'
const snapshotJobType = 'ranking.snapshot'
const recentLimit = 3
const languages = ['ru', 'tg', 'en']
const codePattern = /^[a-z0-9_]{1,64}$/
const maxSeenCodes = 100
// Minutes after local midnight (Asia/Dushanbe) when the scheduled jobs become due.
const scheduleOffsets = Object.freeze({ streaks: 1, week: 5, month: 10 })

function dependencies(overrides = {}) {
   return {
      repository: overrides.repository || achievementRepository,
      jobs: overrides.jobs || jobRepository,
      staff: overrides.staff || staffProgressRepository,
      transaction: overrides.transaction || withTransaction,
      clock: overrides.clock || (() => new Date()),
      readinessWindow: overrides.readinessWindow || env.trainer.readinessWindow,
      notify: overrides.notify || enqueueAchievementUnlocked,
      ranking: overrides.ranking || computeGroupRankingForPeriodService,
      rankingOverrides: overrides.rankingOverrides,
   }
}

function id(value) {
   return normalizeInternalId(String(value))
}

function iso(value) {
   return value === null || value === undefined ? null : new Date(value).toISOString()
}

function toDate(value) {
   return value === null || value === undefined ? null : new Date(value)
}

function permanentError(code) {
   const error = new Error(code)
   error.code = code
   error.permanent = true
   return error
}

function validationError(field, message = `${field} is invalid`) {
   return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ field, message }])
}

// ---------------------------------------------------------------- enqueue (inside the caller's transaction)

// source names what happened (attempt:<id>, regrade:<auditId>, lesson:<id>, ...); the job key
// achievements.evaluate:<user>:<source> makes the same event evaluate once.
function enqueueAchievementEvaluation(client, { userId, source, availableAt = null }, overrides) {
   const { jobs } = dependencies(overrides)
   return jobs.enqueueJob({
      jobType: evaluateJobType,
      payload: { userId: id(userId), source },
      dedupeKey: `${evaluateJobType}:${id(userId)}:${source}`,
      availableAt,
   }, client)
}

// A group assignment's close time decides on_time_5. When it is set or moved, the members with a
// finished attempt are evaluated now (phase changed) and again at the close time (phase closed).
// The close time is part of the key: a moved one gets new jobs, the old ones find another
// closes_at and do nothing.
async function enqueueAssignmentAchievementEvents(client, { assignmentId, groupId, closesAt, changed = false }, overrides) {
   if (!groupId || !closesAt) return
   const { jobs } = dependencies(overrides)
   const closesIso = new Date(closesAt).toISOString()
   const phases = changed ? [['changed', null], ['closed', new Date(closesAt)]] : [['closed', new Date(closesAt)]]
   for (const [phase, availableAt] of phases) {
      await jobs.enqueueJob({
         jobType: assignmentJobType,
         payload: { assignmentId: id(assignmentId), closesAt: closesIso, phase },
         dedupeKey: `${assignmentJobType}:${id(assignmentId)}:${closesIso}:${phase}`,
         availableAt,
      }, client)
   }
}

// ---------------------------------------------------------------- facts and evaluation

function numberOrNull(value) {
   return value === null || value === undefined ? null : Number(value)
}

async function loadFacts(deps, userId, timeZone, now, db) {
   const repository = deps.repository
   // One after another: on a transaction client pg runs them in order anyway.
   const attempts = await repository.listFinishedAttempts(userId, db)
   const occurrences = await repository.listAnsweredOccurrences(userId, db)
   const lessons = await repository.listCompletedLessons(userId, db)
   const courses = await repository.listEnrolledCourseProgress(userId, now, db)
   const groupAssignments = await repository.listGroupAssignments(userId, db)
   const watch = await repository.listWatchHours(userId, db)
   const snapshots = await repository.listSnapshotPlaces(userId, 'week', db)
   return {
      timeZone,
      attempts: attempts.map((row) => ({
         id: String(row.id),
         origin: row.origin,
         testId: String(row.test_id),
         assignmentId: row.assignment_id === null ? null : String(row.assignment_id),
         attemptNumber: Number(row.attempt_number),
         score: numberOrNull(row.score),
         maxScore: numberOrNull(row.max_score),
         passPercent: numberOrNull(row.pass_percent),
         finishedAt: toDate(row.finished_at),
         seconds: Number(row.seconds),
         questions: Number(row.questions),
         answered: Number(row.answered),
         subjectId: row.subject_id ?? null,
         repeat: row.repeat_training,
      })),
      occurrences: occurrences.map((row) => ({
         attemptId: String(row.attempt_id), questionId: String(row.question_id), full: row.full,
      })),
      lessons: lessons.map((row) => ({ lessonId: String(row.lesson_id), completedAt: toDate(row.completed_at) })),
      courses: courses.map((row) => ({
         courseId: String(row.course_id),
         totalLessons: Number(row.total_lessons),
         completedLessons: Number(row.completed_lessons),
         lastCompletedAt: toDate(row.last_completed_at),
      })),
      groupAssignments: groupAssignments.map((row) => ({
         assignmentId: String(row.assignment_id),
         groupId: String(row.group_id),
         closesAt: toDate(row.closes_at),
         eligible: row.eligible,
      })),
      watch: watch.map((row) => ({ at: toDate(row.occurred_at), seconds: Number(row.seconds) })),
      snapshots: snapshots.map((row) => ({
         groupId: String(row.group_id),
         board: row.board,
         periodKind: row.period_kind,
         periodStart: row.period_start,
         rank: row.rank,
         score: numberOrNull(row.score),
         participants: Number(row.participants),
         computedAt: toDate(row.computed_at),
      })),
   }
}

async function evaluateFor(deps, userId, now, db) {
   const learner = await deps.repository.findLearner(userId, db)
   if (!learner) return null
   const catalog = await deps.repository.listActiveAchievements(db)
   const facts = await loadFacts(deps, userId, learner.timezone, now, db)
   const outcomes = evaluateCatalog(catalog, facts, { now, readinessWindow: deps.readinessWindow })
   return { learner, outcomes }
}

// achievements.evaluate: awards what the history now earns. Inactive accounts get nothing.
// options.apply false returns the plan only (backfill dry run). options.notify false writes no
// notification and marks the award seen (seenAt), for the backfill of past activity.
async function evaluateUserAchievementsService(userIdValue, options = {}, overrides) {
   const deps = dependencies(overrides)
   const userId = id(userIdValue)
   const source = typeof options.source === 'string' && options.source ? options.source : 'manual'
   const apply = options.apply !== false
   const notify = options.notify !== false
   return deps.transaction(async (client) => {
      const now = deps.clock()
      const evaluated = await evaluateFor(deps, userId, now, client)
      if (!evaluated || evaluated.learner.status !== 'active') return { userId, awarded: [], planned: [] }
      const owned = new Set((await deps.repository.listUserAchievements(userId, client)).map((row) => String(row.achievement_id)))
      const planned = evaluated.outcomes
         .filter(({ achievement, outcome }) => outcome.achieved && !owned.has(String(achievement.id)))
         .map(({ achievement, outcome }) => ({
            achievementId: String(achievement.id),
            code: achievement.code,
            // Never in the future: the moment the history reached it, or now.
            awardedAt: outcome.at && outcome.at <= now ? outcome.at : now,
            metadata: { ...outcome.metadata, source },
         }))
      if (!apply || !planned.length) return { userId, awarded: [], planned }
      const inserted = new Set((await deps.repository.insertUserAchievements(planned.map((item) => ({
         userId,
         achievementId: item.achievementId,
         awardedAt: item.awardedAt,
         sourceEventKey: `${evaluateJobType}:${source}`,
         metadata: item.metadata,
         seenAt: notify ? null : (options.seenAt ?? now),
      })), client)).map(String))
      const awarded = planned.filter((item) => inserted.has(item.achievementId))
      if (notify) {
         for (const item of awarded) await deps.notify(client, { userId, achievementId: item.achievementId })
      }
      return { userId, awarded, planned }
   })
}

// ---------------------------------------------------------------- reads

function safeTranslations(value) {
   const source = value && typeof value === 'object' ? value : {}
   const fallback = source.ru ?? source.en ?? source.tg ?? {}
   return Object.fromEntries(languages.map((language) => {
      const text = source[language] ?? fallback
      return [language, { title: text.title ?? null, description: text.description ?? null }]
   }))
}

function safeItem(achievement, award, outcome) {
   let progress = outcome?.progress ?? null
   if (award && progress) progress = { current: progress.target, target: progress.target }
   return {
      code: achievement.code,
      family: achievement.family,
      category: achievement.category,
      tier: achievement.tier ?? null,
      icon: achievement.icon,
      translations: safeTranslations(achievement.translations),
      earnedAt: award ? iso(award.awarded_at) : null,
      seen: Boolean(award?.seen_at),
      progress,
   }
}

async function buildAchievementList(deps, userId) {
   const now = deps.clock()
   const [evaluated, awards] = await Promise.all([
      evaluateFor(deps, userId, now),
      deps.repository.listUserAchievements(userId),
   ])
   const byAchievement = new Map(awards.map((row) => [String(row.achievement_id), row]))
   const items = (evaluated?.outcomes ?? []).map(({ achievement, outcome }) => (
      safeItem(achievement, byAchievement.get(String(achievement.id)), outcome)
   ))
   return {
      summary: { earned: items.filter((item) => item.earnedAt).length, total: items.length },
      items,
   }
}

async function requireActiveAccount(deps, userId) {
   const learner = await deps.repository.findLearner(userId)
   if (!learner || learner.status !== 'active') throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'Account is not active')
}

// GET /me/achievements: the whole catalog in catalog order, earned or not, with progress.
async function getMyAchievementsService(userId, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   await requireActiveAccount(deps, actorId)
   return buildAchievementList(deps, actorId)
}

// GET /admin/users/:userId/achievements: the same list, for staff who may view the student's
// progress (the M12 scope, D1; anything else is 404).
async function getStaffStudentAchievementsService(userId, studentIdValue, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const studentId = parseUserId(studentIdValue)
   await requireStudentScope({ repository: deps.staff }, actorId, studentId)
   return buildAchievementList(deps, studentId)
}

// The last awards for /me/home (the same item shape, progress null).
async function listRecentAchievementsService(userId, overrides) {
   const deps = dependencies(overrides)
   const rows = await deps.repository.listRecentAchievements(parseUserId(userId), recentLimit)
   return rows.map((row) => safeItem(row, row, null))
}

function parseSeenBody(body) {
   if (!body || typeof body !== 'object' || Array.isArray(body)) throw validationError('body')
   const unknown = Object.keys(body).find((field) => field !== 'codes')
   if (unknown) throw validationError(unknown.slice(0, 40))
   if (!Array.isArray(body.codes) || body.codes.length === 0 || body.codes.length > maxSeenCodes) {
      throw validationError('codes', `codes must be an array of 1 to ${maxSeenCodes} codes`)
   }
   if (!body.codes.every((code) => typeof code === 'string' && codePattern.test(code))) {
      throw validationError('codes', 'codes must be achievement codes')
   }
   return [...new Set(body.codes)]
}

// POST /me/achievements/seen { codes }: marks the congratulations shown. Codes that are unknown
// or not earned are ignored; repeating it changes nothing.
async function markAchievementsSeenService(userId, body, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const codes = parseSeenBody(body)
   await requireActiveAccount(deps, actorId)
   const updated = await deps.transaction((client) => deps.repository.markAchievementsSeen(actorId, codes, deps.clock(), client))
   return { updated }
}

// ---------------------------------------------------------------- assignments, streaks

async function runAssignmentAchievementsService(payload, overrides) {
   const deps = dependencies(overrides)
   if (!payload?.assignmentId || !payload?.closesAt) throw permanentError('ACHIEVEMENT_PAYLOAD_INVALID')
   return deps.transaction(async (client) => {
      const userIds = await deps.repository.listAssignmentCloseCandidates(payload.assignmentId, new Date(payload.closesAt), client)
      for (const userId of userIds) {
         await enqueueAchievementEvaluation(client, {
            userId,
            source: `assignment:${id(payload.assignmentId)}:${payload.closesAt}:${payload.phase ?? 'closed'}`,
         }, overrides)
      }
      return { queued: userIds.length }
   })
}

// The daily streak run: everybody with activity since the start of the previous local day.
// Video watch time does not queue an evaluation by itself, so this run awards watch-only days.
async function runStreakAchievementsService(payload, overrides) {
   const deps = dependencies(overrides)
   if (!payload?.date || !payload?.since) throw permanentError('ACHIEVEMENT_PAYLOAD_INVALID')
   return deps.transaction(async (client) => {
      const userIds = await deps.repository.listUsersActiveSince(new Date(payload.since), client)
      for (const userId of userIds) {
         await enqueueAchievementEvaluation(client, { userId, source: `streaks:${payload.date}` }, overrides)
      }
      return { queued: userIds.length }
   })
}

// ---------------------------------------------------------------- snapshots

// The finished week or month before the one `now` falls in (local Asia/Dushanbe bounds).
function previousPeriod(kind, now) {
   const current = periodBounds(kind, now)
   const previous = periodBounds(kind, new Date(current.start.getTime() - 1))
   return { kind, start: previous.start, end: previous.end, startKey: localDateKey(previous.start, rankingTimeZone) }
}

// ranking.snapshot: the places of every group and both boards for one finished period. A table
// that already exists is not touched (a second run writes nothing). Weekly snapshots then queue
// the group_top3 candidates.
async function runRankingSnapshotService(payload, overrides) {
   const deps = dependencies(overrides)
   const kind = payload?.periodKind
   if (!['week', 'month'].includes(kind) || !payload?.periodStart || !payload?.startAt || !payload?.endAt) {
      throw permanentError('SNAPSHOT_PAYLOAD_INVALID')
   }
   const bounds = { start: new Date(payload.startAt), end: new Date(payload.endAt) }
   const now = deps.clock()
   // Only finished periods are kept; the current one is computed on read.
   if (bounds.end > now) throw permanentError('SNAPSHOT_PERIOD_NOT_FINISHED')
   const groupIds = await deps.repository.listSnapshotGroupIds()
   let written = 0
   for (const groupId of groupIds) {
      for (const board of rankingBoards) {
         if (await deps.repository.hasSnapshot(groupId, board, kind, payload.periodStart)) continue
         const ranked = await deps.ranking(groupId, { board, period: kind, bounds }, deps.rankingOverrides)
         const computedAt = deps.clock()
         written += await deps.transaction((client) => deps.repository.insertSnapshotRows(ranked.map((row) => ({
            groupId,
            board,
            periodKind: kind,
            periodStart: payload.periodStart,
            userId: row.userId,
            rank: row.rank,
            score: row.score,
            details: {
               formulaVersion,
               breakdown: row.breakdown,
               onTime: row.onTime,
               lastCountedAt: iso(row.lastCountedAt),
            },
            computedAt,
         })), client))
      }
   }
   let queued = 0
   if (kind === 'week') {
      const top = await deps.repository.listActiveAchievements()
      const criteria = top.find((achievement) => achievement.criteria?.type === 'group_top3')?.criteria
      if (criteria) {
         const userIds = await deps.repository.listTopPlacedUsers({
            periodKind: kind,
            periodStart: payload.periodStart,
            maxRank: criteria.maxRank,
            minParticipants: criteria.minParticipants,
         })
         await deps.transaction(async (client) => {
            for (const userId of userIds) {
               await enqueueAchievementEvaluation(client, { userId, source: `ranking:week:${payload.periodStart}` }, overrides)
            }
         })
         queued = userIds.length
      }
   }
   return { groups: groupIds.length, written, queued }
}

// Called by worker:jobs at start and every few minutes. Each job's key holds its date, so it is
// queued once however often this runs or restarts; it becomes due a few minutes after local
// midnight (Asia/Dushanbe).
async function scheduleAchievementJobsService(overrides) {
   const deps = dependencies(overrides)
   const now = deps.clock()
   const today = localDateKey(now, rankingTimeZone)
   const day = previousPeriodDay(now)
   const week = previousPeriod('week', now)
   const month = previousPeriod('month', now)
   const minutes = (value) => value * 60000
   return deps.transaction(async (client) => {
      const queued = []
      const add = async (job) => {
         if (await deps.jobs.enqueueJob(job, client)) queued.push(job.dedupeKey)
      }
      await add({
         jobType: streakJobType,
         payload: { date: today, since: day.start.toISOString() },
         dedupeKey: `${streakJobType}:${today}`,
         availableAt: new Date(day.end.getTime() + minutes(scheduleOffsets.streaks)),
      })
      for (const [period, offset] of [[week, scheduleOffsets.week], [month, scheduleOffsets.month]]) {
         await add({
            jobType: snapshotJobType,
            payload: {
               periodKind: period.kind,
               periodStart: period.startKey,
               startAt: period.start.toISOString(),
               endAt: period.end.toISOString(),
            },
            dedupeKey: `${snapshotJobType}:${period.kind}:${period.startKey}`,
            availableAt: new Date(period.end.getTime() + minutes(offset)),
         })
      }
      return queued
   })
}

// Yesterday in Asia/Dushanbe: [start, end) where end is today's local midnight.
function previousPeriodDay(now) {
   const todayStart = localDayStart(now)
   const yesterdayStart = localDayStart(new Date(todayStart.getTime() - 1))
   return { start: yesterdayStart, end: todayStart }
}

// Local midnight of the day `instant` falls in, found from the week bounds (whole days).
function localDayStart(instant) {
   const week = periodBounds('week', instant)
   const key = localDateKey(instant, rankingTimeZone)
   let start = week.start
   while (localDateKey(start, rankingTimeZone) !== key) {
      // Days are 24 h in Asia/Dushanbe (no DST); a 25 h step would also land in the right day.
      start = new Date(start.getTime() + 24 * 3600 * 1000)
   }
   return start
}

// ---------------------------------------------------------------- backfill

// npm run backfill:achievements. apply false: only the plan (who would get what). apply true:
// awards in one transaction per learner; notify false writes no notification and seen_at = now.
async function backfillAchievementsService({ apply = false, notify = false, userIds = null } = {}, overrides) {
   const deps = dependencies(overrides)
   const candidates = userIds ?? await deps.repository.listBackfillCandidates()
   const results = []
   for (const userId of candidates) {
      const result = await evaluateUserAchievementsService(userId, { source: 'backfill', apply, notify }, overrides)
      if (result.planned.length) results.push(result)
   }
   return { candidates: candidates.length, results }
}

// ---------------------------------------------------------------- job handlers

function createAchievementJobHandlers(overrides) {
   return Object.freeze({
      [evaluateJobType]: (payload) => {
         if (!payload?.userId) throw permanentError('ACHIEVEMENT_PAYLOAD_INVALID')
         return evaluateUserAchievementsService(payload.userId, { source: payload.source }, overrides)
      },
      [assignmentJobType]: (payload) => runAssignmentAchievementsService(payload, overrides),
      [streakJobType]: (payload) => runStreakAchievementsService(payload, overrides),
      [snapshotJobType]: (payload) => runRankingSnapshotService(payload, overrides),
   })
}

const achievementJobHandlers = createAchievementJobHandlers()

export {
   achievementJobHandlers,
   assignmentJobType,
   backfillAchievementsService,
   createAchievementJobHandlers,
   enqueueAchievementEvaluation,
   enqueueAssignmentAchievementEvents,
   evaluateJobType,
   evaluateUserAchievementsService,
   getMyAchievementsService,
   getStaffStudentAchievementsService,
   listRecentAchievementsService,
   markAchievementsSeenService,
   previousPeriod,
   previousPeriodDay,
   runRankingSnapshotService,
   runStreakAchievementsService,
   scheduleAchievementJobsService,
   snapshotJobType,
   streakJobType,
}
