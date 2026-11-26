import * as authRepository from '../repositories/auth-repository.js'
import * as rankingRepository from '../repositories/stats/group-ranking-repository.js'
import * as staffProgressRepository from '../repositories/stats/staff-progress-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import AppError from '../utils/app-error.js'
import { normalizeInternalId } from '../utils/internal-id.js'
import {
   activityScore,
   defaultVisibility,
   firstSolves,
   formulaVersion,
   participantWindow,
   performanceScore,
   periodBounds,
   rankingBoards,
   rankingPeriods,
   rankingVisibilities,
   rankParticipants,
   visibleRows,
} from '../utils/ranking-metrics.js'
import { parseGroupId } from './group-service.js'

// M13 group ranking (decisions.md 2026-11-25). Computed on every request, without a cache, from
// one aggregate query per group. Students see what the group's visibility allows; staff in
// scope (owner, admin, a teacher of the group with canViewResults) always see everyone.

function dependencies(overrides = {}) {
   return {
      repository: overrides.repository || rankingRepository,
      staff: overrides.staff || staffProgressRepository,
      auth: overrides.auth || authRepository,
      transaction: overrides.transaction || withTransaction,
      clock: overrides.clock || (() => new Date()),
   }
}

function validationError(field) {
   return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [
      { field, message: `${field} is invalid` },
   ])
}

function groupNotFound() {
   return new AppError(404, 'GROUP_NOT_FOUND', 'Group was not found')
}

function parseActorId(value) {
   try {
      return normalizeInternalId(value)
   } catch {
      throw new AppError(400, 'INVALID_USER_ID', 'User identifier is invalid')
   }
}

function parseRankingQuery(query = {}) {
   const board = query.board ?? 'performance'
   const period = query.period ?? 'week'
   if (!rankingBoards.includes(board)) throw validationError('board')
   if (!rankingPeriods.includes(period)) throw validationError('period')
   return { board, period }
}

function iso(value) {
   return value ? new Date(value).toISOString() : null
}

function toDate(value) {
   return value === null || value === undefined ? null : new Date(value)
}

// The rows of the repository, grouped per member.
function collectFacts(rows) {
   const members = new Map()
   const of = (userId) => members.get(String(userId))
   for (const row of rows) {
      if (row.kind !== 'member') continue
      members.set(String(row.user_id), {
         userId: String(row.user_id),
         firstName: row.data.firstName ?? null,
         lastName: row.data.lastName ?? null,
         joinedAt: toDate(row.data.joinedAt),
         assignments: [],
         trainer: [],
         mockExams: [],
         lessons: [],
      })
   }
   for (const row of rows) {
      const member = of(row.user_id)
      if (!member) continue
      if (row.kind === 'assignment') member.assignments.push(row.data)
      else if (row.kind === 'trainer') {
         member.trainer.push({
            attemptId: row.data.attemptId,
            at: toDate(row.data.at),
            seconds: Number(row.data.seconds),
            questions: Number(row.data.questions),
            answered: Number(row.data.answered),
            solved: row.data.solved,
         })
      } else if (row.kind === 'mock_exam') member.mockExams.push({ at: toDate(row.data.at), score: row.data.score })
      else if (row.kind === 'lesson') member.lessons.push({ at: toDate(row.data.at) })
   }
   return [...members.values()]
}

// bounds: the period's bounds; given for a finished period (snapshots), computed from now otherwise.
async function computeRanking(deps, groupId, { board, period }, fixedBounds = null) {
   const now = deps.clock()
   const bounds = fixedBounds ?? periodBounds(period, now)
   const rows = await deps.repository.listRankingFacts(groupId, { board, start: bounds.start, end: bounds.end })
   const participants = collectFacts(rows).map((member) => {
      const window = participantWindow(bounds, member.joinedAt)
      const performance = performanceScore(member.assignments, window, now)
      const result = board === 'performance'
         ? performance
         : activityScore({
            solves: firstSolves(member.trainer),
            mockExams: member.mockExams,
            lessons: member.lessons,
         }, window)
      return {
         userId: member.userId,
         firstName: member.firstName,
         lastName: member.lastName,
         score: result.score,
         onTime: performance.onTime,
         lastCountedAt: result.lastCountedAt,
         breakdown: board === 'performance'
            ? result.breakdown
            : { ...result.breakdown, assignmentsOnTime: performance.onTime },
      }
   })
   return { now, bounds, ranked: rankParticipants(participants) }
}

// Avatars are not delivered yet (there is no avatar upload); avatarUrl stays null until then.
function safeUser(row) {
   return { id: row.userId, firstName: row.firstName, lastName: row.lastName, avatarUrl: null }
}

function envelope(groupId, query, computed, visibility) {
   return {
      groupId,
      board: query.board,
      period: query.period,
      periodStart: iso(computed.bounds.start),
      periodEnd: iso(computed.bounds.end),
      visibility,
      participantsCount: computed.ranked.length,
      formulaVersion,
      computedAt: computed.now.toISOString(),
   }
}

async function readVisibility(deps, groupId) {
   return (await deps.repository.findRankingSettings(groupId))?.visibility ?? defaultVisibility
}

// GET /groups/:groupId/ranking, the ranking as the group page shows it.
//   An active member: shaped by the group visibility (viewerRole student).
//   Owner/admin (any group) or a teacher of the group (any flags): everyone, whatever the
//   visibility, me null, no breakdown (viewerRole staff; studentVisibility says what students see).
//   Anyone else: 404.
async function getGroupRankingService(userId, groupIdValue, query, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseActorId(userId)
   const groupId = parseGroupId(groupIdValue)
   const filters = parseRankingQuery(query)
   const viewer = await deps.repository.findRankingViewer(actorId, groupId)
   if (!viewer) throw groupNotFound()
   const studentVisibility = await readVisibility(deps, groupId)
   if (!viewer.is_member) {
      const computed = await computeRanking(deps, groupId, filters)
      return {
         ...envelope(groupId, filters, computed, 'full'),
         viewerRole: 'staff',
         studentVisibility,
         items: computed.ranked.map((row) => ({
            rank: row.rank,
            score: row.score,
            isMe: false,
            user: safeUser(row),
         })),
         me: null,
      }
   }
   const visibility = studentVisibility
   let computed
   if (visibility === 'staff_only') {
      const now = deps.clock()
      computed = { now, bounds: periodBounds(filters.period, now), ranked: [] }
   } else {
      computed = await computeRanking(deps, groupId, filters)
   }
   const own = computed.ranked.find((row) => row.userId === actorId)
   return {
      // staff_only hides the table and the count of participants alike (participantsCount 0).
      ...envelope(groupId, filters, computed, visibility),
      viewerRole: 'student',
      studentVisibility,
      items: visibleRows(computed.ranked, visibility).map((row) => ({
         rank: row.rank,
         score: row.score,
         isMe: row.userId === actorId,
         user: safeUser(row),
      })),
      me: visibility === 'staff_only' || !own ? null : { rank: own.rank, score: own.score },
   }
}

async function requireStaffGroup(deps, actorId, groupId) {
   const group = await deps.staff.findProgressGroup(actorId, groupId)
   if (!group) throw groupNotFound()
   return group
}

// GET /admin/groups/:groupId/ranking: everyone, with the parts of each score.
async function getStaffGroupRankingService(userId, groupIdValue, query, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseActorId(userId)
   const groupId = parseGroupId(groupIdValue)
   const filters = parseRankingQuery(query)
   await requireStaffGroup(deps, actorId, groupId)
   const visibility = await readVisibility(deps, groupId)
   const computed = await computeRanking(deps, groupId, filters)
   return {
      ...envelope(groupId, filters, computed, visibility),
      items: computed.ranked.map((row) => ({
         rank: row.rank,
         score: row.score,
         isMe: row.userId === actorId,
         user: safeUser(row),
         assignmentsOnTime: row.onTime,
         lastCountedAt: iso(row.lastCountedAt),
         breakdown: row.breakdown,
      })),
      me: null,
   }
}

function safeSettings(groupId, row) {
   return {
      groupId,
      visibility: row?.visibility ?? defaultVisibility,
      isDefault: !row,
      updatedBy: row?.updated_by ?? null,
      updatedAt: iso(row?.updated_at),
   }
}

async function getRankingSettingsService(userId, groupIdValue, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseActorId(userId)
   const groupId = parseGroupId(groupIdValue)
   await requireStaffGroup(deps, actorId, groupId)
   return safeSettings(groupId, await deps.repository.findRankingSettings(groupId))
}

async function updateRankingSettingsService(userId, groupIdValue, body, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseActorId(userId)
   const groupId = parseGroupId(groupIdValue)
   if (!body || typeof body !== 'object' || Array.isArray(body)) throw validationError('body')
   const unknown = Object.keys(body).find((field) => field !== 'visibility')
   if (unknown) throw validationError(unknown)
   if (!rankingVisibilities.includes(body.visibility)) throw validationError('visibility')
   await requireStaffGroup(deps, actorId, groupId)
   return deps.transaction(async (client) => {
      const previous = await deps.repository.findRankingSettings(groupId, client)
      const saved = await deps.repository.saveRankingSettings({ groupId, visibility: body.visibility, actorId }, client)
      await deps.auth.appendAuditEvent({
         actorUserId: actorId,
         subjectUserId: null,
         code: 'group.ranking_settings_updated',
         entityType: 'group',
         entityId: groupId,
         metadata: { visibility: body.visibility, previous: previous?.visibility ?? defaultVisibility },
      }, client)
      return safeSettings(groupId, saved)
   })
}

// The ranking of one finished period (week or month) with fixed bounds, for the snapshots of
// worker:jobs. Same facts, formula and places as the live ranking.
async function computeGroupRankingForPeriodService(groupIdValue, { board, period, bounds }, overrides) {
   const deps = dependencies(overrides)
   const groupId = parseGroupId(groupIdValue)
   if (!rankingBoards.includes(board)) throw validationError('board')
   const computed = await computeRanking(deps, groupId, { board, period }, bounds)
   return computed.ranked
}

export {
   computeGroupRankingForPeriodService,
   getGroupRankingService,
   getRankingSettingsService,
   getStaffGroupRankingService,
   parseRankingQuery,
   updateRankingSettingsService,
}
