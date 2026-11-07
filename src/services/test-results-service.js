import * as authRepository from '../repositories/auth-repository.js'
import * as attemptRepository from '../repositories/test-attempt-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import AppError from '../utils/app-error.js'
import { sumPoints, toHundredths } from '../utils/attempt-grading.js'
import { isFinished } from '../utils/attempt-policy.js'
import { normalizeInternalId } from '../utils/internal-id.js'
import { parsePagination, parseText, validateBody, validationError } from './course-service.js'
import { completeTestLessonsService } from './lesson-completion-service.js'
import { safeAttempt, safeQuestionBase } from './test-attempt-service.js'

const attemptStatuses = ['in_progress', 'graded', 'expired', 'cancelled']
const pointsPattern = /^[0-9]{1,8}(\.[0-9]{1,2})?$/
const maximumReasonLength = 1000
const maximumKeyLength = 100

function dependencies(overrides = {}) {
   return {
      repository: overrides.repository || attemptRepository,
      auth: overrides.auth || authRepository,
      transaction: overrides.transaction || withTransaction,
      clock: overrides.clock || (() => new Date()),
      completeLessons: overrides.completeLessons || completeTestLessonsService,
   }
}

function parseId(value, code, message) {
   try {
      return normalizeInternalId(value)
   } catch {
      throw new AppError(400, code, message)
   }
}

function parseTestId(value) {
   return parseId(value, 'INVALID_TEST_ID', 'Test identifier is invalid')
}

function parseAttemptId(value) {
   return parseId(value, 'INVALID_ATTEMPT_ID', 'Attempt identifier is invalid')
}

function parseFilterId(value, field) {
   if (value === undefined) return null
   try {
      return normalizeInternalId(value)
   } catch {
      throw validationError(field)
   }
}

async function requireResultsTest(repository, actorId, testId) {
   const test = await repository.findResultsTest(actorId, testId)
   if (!test) throw new AppError(404, 'TEST_NOT_FOUND', 'Test was not found')
   return test
}

function attemptNotFound() {
   return new AppError(404, 'ATTEMPT_NOT_FOUND', 'Attempt was not found')
}

function safeStaffAttempt(row) {
   return {
      ...safeAttempt(row),
      userId: row.user_id,
      userDisplayName: row.user_display_name,
      // The threshold stored when the attempt started, never the test's current setting.
      passPercent: row.policy_snapshot?.passPercent ?? null,
   }
}

// The answer key stays out: access to keys follows the question bank rules.
function safeStaffQuestion(row) {
   return {
      ...safeQuestionBase(row),
      answer: row.answer_data ?? null,
      awardedPoints: row.awarded_points,
      gradingStatus: row.grading_status ?? 'pending',
   }
}

function safeRevision(row) {
   return {
      id: row.id,
      revisedBy: row.revised_by,
      reason: row.reason,
      previousScore: row.previous_score,
      newScore: row.new_score,
      createdAt: new Date(row.created_at).toISOString(),
   }
}

async function listTestAttemptsService(userId, testIdValue, query = {}, overrides) {
   const { repository } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const testId = parseTestId(testIdValue)
   const filters = {
      ...parsePagination(query),
      assignmentId: parseFilterId(query.assignmentId, 'assignmentId'),
      userId: parseFilterId(query.userId, 'userId'),
      status: query.status === undefined ? null : query.status,
   }
   if (filters.status !== null && !attemptStatuses.includes(filters.status)) throw validationError('status')
   await requireResultsTest(repository, actorId, testId)
   const rows = await repository.listTestAttempts(actorId, testId, filters)
   return {
      attempts: rows.slice(0, filters.limit).map(safeStaffAttempt),
      pagination: { limit: filters.limit, offset: filters.offset, hasMore: rows.length > filters.limit },
   }
}

async function readDetail(repository, actorId, testId, attemptId) {
   const attempt = await repository.findTestAttempt(actorId, testId, attemptId)
   if (!attempt) throw attemptNotFound()
   const [questions, revisions] = await Promise.all([
      repository.listAttemptQuestions(attemptId),
      repository.listScoreRevisions(attemptId),
   ])
   return {
      attempt: safeStaffAttempt(attempt),
      questions: questions.map(safeStaffQuestion),
      revisions: revisions.map(safeRevision),
   }
}

async function getTestAttemptService(userId, testIdValue, attemptIdValue, overrides) {
   const { repository } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const testId = parseTestId(testIdValue)
   const attemptId = parseAttemptId(attemptIdValue)
   await requireResultsTest(repository, actorId, testId)
   return readDetail(repository, actorId, testId, attemptId)
}

function parseOverrides(value) {
   if (!Array.isArray(value) || value.length === 0) throw validationError('overrides')
   const seen = new Set()
   return value.map((entry) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw validationError('overrides')
      validateBody(entry, ['attemptQuestionId', 'points'])
      const attemptQuestionId = parseFilterId(entry.attemptQuestionId, 'attemptQuestionId')
      const points = String(entry.points)
      if (attemptQuestionId === null || seen.has(attemptQuestionId) || !pointsPattern.test(points)) {
         throw validationError('overrides')
      }
      seen.add(attemptQuestionId)
      return { attemptQuestionId, points }
   })
}

// Manual override of points. The revision row keeps the earlier score; the key makes a retry
// of the same request change nothing.
async function regradeAttemptService(userId, testIdValue, attemptIdValue, body, overrides) {
   const { repository, auth, transaction, clock, completeLessons } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const testId = parseTestId(testIdValue)
   const attemptId = parseAttemptId(attemptIdValue)
   validateBody(body, ['reason', 'idempotencyKey', 'overrides'])
   const reason = parseText(body.reason, 'reason', maximumReasonLength)
   const idempotencyKey = parseText(body.idempotencyKey, 'idempotencyKey', maximumKeyLength)
   const changes = parseOverrides(body.overrides)
   await requireResultsTest(repository, actorId, testId)
   await transaction(async (client) => {
      const now = clock()
      const attempt = await repository.lockTestAttempt(actorId, testId, attemptId, client)
      if (!attempt) throw attemptNotFound()
      if (!isFinished(attempt)) {
         throw new AppError(409, 'ATTEMPT_NOT_FINISHED', 'Only finished attempts can be regraded')
      }
      const existing = await repository.findScoreRevisionByKey(idempotencyKey, client)
      if (existing) {
         if (existing.attempt_id !== attemptId) {
            throw new AppError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'This key was used for another attempt')
         }
         return
      }
      const rows = await repository.listGradingRows(attemptId, client)
      const points = new Map(rows.map((row) => [row.id, row.awarded_points]))
      const changed = []
      for (const change of changes) {
         const row = rows.find((item) => item.id === change.attemptQuestionId)
         if (!row) throw new AppError(404, 'ATTEMPT_QUESTION_NOT_FOUND', 'Question is not part of this attempt')
         if (toHundredths(change.points) > toHundredths(row.max_points)) {
            throw validationError('overrides', 'points cannot exceed the maximum of the question')
         }
         changed.push({ ...change, previousPoints: points.get(row.id) })
         points.set(row.id, change.points)
         await repository.saveManualGrade({ ...change, gradedBy: actorId, gradedAt: now }, client)
      }
      const newScore = sumPoints([...points.values()])
      await repository.setAttemptScore(attemptId, newScore, now, client)
      // A regrade that now passes completes the lessons; one that lowers the score undoes nothing.
      await completeLessons({ attempt: { ...attempt, score: newScore }, completedAt: now }, client)
      await repository.addScoreRevision({
         attemptId,
         revisedBy: actorId,
         reason,
         previousScore: attempt.score,
         newScore,
         gradingSnapshot: { overrides: changed },
         idempotencyKey,
      }, client)
      await auth.appendAuditEvent({
         actorUserId: actorId,
         subjectUserId: attempt.user_id,
         code: 'test.attempt_regraded',
         entityType: 'test_attempt',
         entityId: attemptId,
         metadata: { testId, previousScore: attempt.score, newScore },
      }, client)
   })
   return readDetail(repository, actorId, testId, attemptId)
}

export { getTestAttemptService, listTestAttemptsService, regradeAttemptService }
