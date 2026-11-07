import * as authRepository from '../repositories/auth-repository.js'
import * as attemptRepository from '../repositories/test-attempt-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import AppError from '../utils/app-error.js'
import { sumPoints, toHundredths } from '../utils/attempt-grading.js'
import {
   attemptsUsed,
   effectiveMaxAttempts,
   isFinished,
   remainingAttempts,
} from '../utils/attempt-policy.js'
import { normalizeInternalId } from '../utils/internal-id.js'
import { parsePagination, parseText, validateBody, validationError } from './course-service.js'
import { completeTestLessonsService } from './lesson-completion-service.js'
import { safeAttempt, safeQuestionBase } from './test-attempt-service.js'

const attemptStatuses = ['in_progress', 'graded', 'expired', 'cancelled']
const pointsPattern = /^[0-9]{1,8}(\.[0-9]{1,2})?$/
const maximumReasonLength = 1000
const maximumKeyLength = 100
const maximumExtraAttempts = 10

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

// ---------------------------------------------------------------- extra attempts

function parseAssignmentId(value) {
   return parseId(value, 'INVALID_ASSIGNMENT_ID', 'Assignment identifier is invalid')
}

function parseStudentId(value) {
   return parseId(value, 'INVALID_USER_ID', 'User identifier is invalid')
}

function parseExtraCount(value) {
   if (!Number.isSafeInteger(value) || value < 1 || value > maximumExtraAttempts) {
      throw validationError('count', `count must be an integer from 1 to ${maximumExtraAttempts}`)
   }
   return value
}

function assignmentNotFound() {
   return new AppError(404, 'ASSIGNMENT_NOT_FOUND', 'Assignment was not found')
}

function safeGrant(row) {
   return {
      id: row.id,
      extraAttempts: row.extra_attempts,
      reason: row.reason,
      grantedBy: row.granted_by,
      grantedByName: row.granted_by_name,
      createdAt: new Date(row.created_at).toISOString(),
   }
}

async function readExtraAttempts(repository, assignment, studentId, db) {
   const [grants, attempts] = await Promise.all([
      repository.listAttemptGrants(assignment.id, studentId, db),
      repository.listUserAttempts(studentId, [assignment.id], db),
   ])
   const extraAttempts = grants.reduce((total, row) => total + row.extra_attempts, 0)
   const limit = effectiveMaxAttempts(assignment.max_attempts, extraAttempts)
   return {
      assignmentId: assignment.id,
      userId: studentId,
      maxAttempts: assignment.max_attempts,
      extraAttempts,
      effectiveMaxAttempts: limit,
      attemptsUsed: attemptsUsed(attempts),
      remainingAttempts: remainingAttempts(limit, attempts),
      grants: grants.map(safeGrant),
   }
}

async function requireAssignmentStudent(repository, assignment, studentId, db) {
   if (!await repository.isAssignmentStudent(assignment.id, studentId, db)) {
      throw new AppError(409, 'STUDENT_NOT_ASSIGNED', 'This student does not belong to the assignment')
   }
}

async function getExtraAttemptsService(userId, testIdValue, assignmentIdValue, studentIdValue, overrides) {
   const { repository } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const testId = parseTestId(testIdValue)
   const assignmentId = parseAssignmentId(assignmentIdValue)
   const studentId = parseStudentId(studentIdValue)
   const assignment = await repository.findGrantAssignment(actorId, testId, assignmentId)
   if (!assignment) throw assignmentNotFound()
   await requireAssignmentStudent(repository, assignment, studentId)
   return readExtraAttempts(repository, assignment, studentId)
}

// Extra attempts for one student on one assignment. Append-only: a grant is never changed or
// withdrawn, and no attempt or score is touched. The same idempotencyKey returns the earlier
// state without a second grant.
async function grantExtraAttemptsService(
   userId,
   testIdValue,
   assignmentIdValue,
   studentIdValue,
   body,
   overrides,
) {
   const { repository, auth, transaction, clock } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const testId = parseTestId(testIdValue)
   const assignmentId = parseAssignmentId(assignmentIdValue)
   const studentId = parseStudentId(studentIdValue)
   validateBody(body, ['count', 'reason', 'idempotencyKey'])
   const count = parseExtraCount(body.count)
   const reason = parseText(body.reason, 'reason', maximumReasonLength)
   const idempotencyKey = parseText(body.idempotencyKey, 'idempotencyKey', maximumKeyLength)
   return transaction(async (client) => {
      // The same lock as a start of this student and assignment, so the two serialize.
      await repository.lockAttemptSlot(studentId, assignmentId, client)
      const assignment = await repository.lockGrantAssignment(actorId, testId, assignmentId, client)
      if (!assignment) throw assignmentNotFound()
      const replay = async () => {
         const existing = await repository.findAttemptGrantByKey(idempotencyKey, client)
         if (!existing) return null
         if (existing.assignment_id !== assignmentId || existing.user_id !== studentId) {
            throw new AppError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'This key was used for another grant')
         }
         return readExtraAttempts(repository, assignment, studentId, client)
      }
      const repeated = await replay()
      if (repeated) return repeated
      await requireAssignmentStudent(repository, assignment, studentId, client)
      if (assignment.max_attempts === null) {
         throw new AppError(400, 'ATTEMPTS_UNLIMITED', 'This test has no attempt limit; extra attempts are not needed')
      }
      if (assignment.status !== 'active') {
         throw new AppError(409, 'ASSIGNMENT_REVOKED', 'This assignment is revoked')
      }
      if (assignment.test_status !== 'published') {
         throw new AppError(409, 'TEST_NOT_AVAILABLE', 'This test is not available')
      }
      if (assignment.closes_at && new Date(assignment.closes_at) <= clock()) {
         throw new AppError(409, 'ASSIGNMENT_CLOSED', 'This assignment is closed')
      }
      const inserted = await repository.insertAttemptGrant({
         assignmentId,
         userId: studentId,
         extraAttempts: count,
         reason,
         grantedBy: actorId,
         idempotencyKey,
      }, client)
      if (!inserted) {
         // Another request inserted the same key first.
         const raced = await replay()
         if (raced) return raced
         throw new AppError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'This key was used for another grant')
      }
      await auth.appendAuditEvent({
         actorUserId: actorId,
         subjectUserId: studentId,
         code: 'test.attempts_granted',
         entityType: 'test_assignment',
         entityId: assignmentId,
         metadata: { testId, grantId: inserted.id, extraAttempts: count },
      }, client)
      return readExtraAttempts(repository, assignment, studentId, client)
   })
}

export {
   getExtraAttemptsService,
   getTestAttemptService,
   grantExtraAttemptsService,
   listTestAttemptsService,
   regradeAttemptService,
}
