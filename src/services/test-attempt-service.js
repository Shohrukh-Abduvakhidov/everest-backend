import { randomInt } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import * as authRepository from '../repositories/auth-repository.js'
import * as attemptRepository from '../repositories/test-attempt-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import AppError from '../utils/app-error.js'
import { gradeAnswer, parseStudentAnswer, scorePercent, sumPoints } from '../utils/attempt-grading.js'
import {
   answersRevealed,
   assignmentState,
   attemptsUsed,
   computeDeadline,
   isFinished,
   personalWindowEnd,
   remainingAttempts,
   selectResultAttempt,
} from '../utils/attempt-policy.js'
import { normalizeInternalId } from '../utils/internal-id.js'
import { parseCourseId, parseUserId, validateBody, validationError } from './course-service.js'

function shuffled(values) {
   const result = [...values]
   for (let index = result.length - 1; index > 0; index -= 1) {
      const other = randomInt(index + 1)
      const value = result[index]
      result[index] = result[other]
      result[other] = value
   }
   return result
}

function dependencies(overrides = {}) {
   return {
      repository: overrides.repository || attemptRepository,
      auth: overrides.auth || authRepository,
      transaction: overrides.transaction || withTransaction,
      clock: overrides.clock || (() => new Date()),
      shuffle: overrides.shuffle || shuffled,
   }
}

function iso(value) {
   return value === null || value === undefined ? null : new Date(value).toISOString()
}

function parseId(value, code, message) {
   try {
      return normalizeInternalId(value)
   } catch {
      throw new AppError(400, code, message)
   }
}

function parseAssignmentId(value) {
   return parseId(value, 'INVALID_ASSIGNMENT_ID', 'Assignment identifier is invalid')
}

function parseAttemptId(value) {
   return parseId(value, 'INVALID_ATTEMPT_ID', 'Attempt identifier is invalid')
}

function parseAttemptQuestionId(value) {
   return parseId(value, 'INVALID_ATTEMPT_QUESTION_ID', 'Attempt question identifier is invalid')
}

function assignmentNotFound() {
   return new AppError(404, 'ASSIGNMENT_NOT_FOUND', 'Assignment was not found')
}

function attemptNotFound() {
   return new AppError(404, 'ATTEMPT_NOT_FOUND', 'Attempt was not found')
}

function safeAttempt(row) {
   const finished = isFinished(row)
   return {
      id: row.id,
      testId: row.test_id,
      assignmentId: row.assignment_id,
      attemptNumber: row.attempt_number,
      status: row.status,
      startedAt: iso(row.started_at),
      deadlineAt: iso(row.expires_at),
      submittedAt: iso(row.submitted_at),
      autoSubmitted: row.status === 'expired',
      score: finished ? row.score : null,
      maxScore: finished ? row.max_score : null,
   }
}

function ordered(items, keys) {
   const byKey = new Map(items.map((item) => [item.key, item]))
   return keys.map((key) => ({ key, content: byKey.get(key).content }))
}

// Display structure only; the grading snapshot is never read here.
function safeQuestionBase(row) {
   const items = (side) => row.matching_items.filter((item) => item.side === side)
   return {
      id: row.id,
      position: row.position,
      questionType: row.question_type,
      content: row.content,
      points: row.max_points,
      interactionSettings: row.interaction_settings,
      options: ordered(row.options, row.option_order),
      matching: row.question_type === 'matching'
         ? {
            left: ordered(items('left'), row.matching_order.left),
            right: ordered(items('right'), row.matching_order.right),
         }
         : null,
   }
}

function safeLearnerQuestion(row) {
   return {
      ...safeQuestionBase(row),
      answer: row.answer_data ?? null,
      revision: Number(row.revision ?? 0),
      savedAt: row.revision ? iso(row.saved_at) : null,
   }
}

function safeReviewQuestion(row) {
   return {
      ...safeQuestionBase(row),
      answer: row.answer_data ?? null,
      awardedPoints: row.awarded_points,
      gradingStatus: row.grading_status,
      correctAnswer: row.grading_snapshot.answerData,
      explanation: row.grading_snapshot.explanation,
   }
}

function attemptStateSummary(attempts, maxAttempts, policy) {
   const open = attempts.find((attempt) => attempt.status === 'in_progress')
   const selected = selectResultAttempt(policy, attempts)
   const state = {
      status: 'not_started',
      attemptId: null,
      deadlineAt: null,
      score: null,
      maxScore: null,
      submittedAt: null,
      remainingAttempts: remainingAttempts(maxAttempts, attempts),
   }
   if (open) return { ...state, status: 'in_progress', attemptId: open.id, deadlineAt: iso(open.expires_at) }
   if (!selected) return state
   return {
      ...state,
      status: 'submitted',
      attemptId: selected.id,
      score: selected.score,
      maxScore: selected.max_score,
      submittedAt: iso(selected.submitted_at),
   }
}

function safeLearnerAssignment(row, attempts, now) {
   return {
      id: row.id,
      testId: row.test_id,
      title: row.title,
      mode: row.mode,
      questionCount: row.question_count,
      timeLimitMinutes: row.duration_seconds === null ? null : row.duration_seconds / 60,
      maxAttempts: row.max_attempts,
      opensAt: iso(row.opens_at),
      closesAt: iso(row.closes_at),
      personalWindowMinutes: row.personal_window_minutes,
      personalWindowEndsAt: iso(personalWindowEnd(attempts[0]?.started_at, row.personal_window_minutes)),
      state: assignmentState(row, now),
      attempts: attemptStateSummary(attempts, row.max_attempts, row.result_policy),
   }
}

async function requireContentAccess(deps, actorId, { course_id: courseId, module_id: moduleId }, now, db) {
   if (!await deps.repository.hasActiveEnrollment(actorId, courseId, now, db)) {
      throw new AppError(403, 'COURSE_ENROLLMENT_REQUIRED', 'An active course enrollment is required')
   }
   if (moduleId && !await deps.repository.hasActiveModuleGrant(actorId, moduleId, now, db)) {
      throw new AppError(403, 'MODULE_ACCESS_DENIED', 'You do not have access to this module')
   }
}

// Grades and closes a locked in-progress attempt inside the caller's transaction.
async function finalizeAttempt(deps, client, attempt, { status, submittedAt, actorId, now }) {
   const rows = await deps.repository.listGradingRows(attempt.id, client)
   const grades = rows.map((row) => ({
      id: row.id,
      question_id: row.question_id,
      awarded_points: gradeAnswer(row.answer_data, row.grading_snapshot, row.max_points),
   }))
   await deps.repository.saveGrades(grades, now, client)
   await deps.repository.finishAttempt(attempt.id, {
      status,
      submittedAt,
      gradedAt: now,
      score: sumPoints(grades.map((grade) => grade.awarded_points)),
      maxScore: sumPoints(rows.map((row) => row.max_points)),
   }, client)
   await deps.auth.appendAuditEvent({
      actorUserId: actorId,
      subjectUserId: attempt.user_id,
      code: status === 'expired' ? 'test.attempt_expired' : 'test.attempt_submitted',
      entityType: 'test_attempt',
      entityId: attempt.id,
      metadata: { testId: attempt.test_id, assignmentId: attempt.assignment_id },
   }, client)
}

function expiredFinish(attempt, now) {
   return { status: 'expired', submittedAt: attempt.expires_at, actorId: null, now }
}

function hasExpired(attempt, now) {
   return attempt.expires_at !== null && new Date(attempt.expires_at) <= now
}

// Finishes one expired attempt: of one student, or of anyone for the sweep.
async function finalizeNextExpiredAttemptService({ userId = null } = {}, overrides) {
   const deps = dependencies(overrides)
   const now = deps.clock()
   return deps.transaction(async (client) => {
      const attempt = await deps.repository.lockNextExpiredAttempt(now, userId, client)
      if (!attempt) return false
      await finalizeAttempt(deps, client, attempt, expiredFinish(attempt, now))
      return true
   })
}

async function finalizeExpiredAttemptsForUserService(userId, overrides) {
   while (await finalizeNextExpiredAttemptService({ userId }, overrides));
}

async function listMyAssignmentsService(userId, courseIdValue, query = {}, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const courseId = parseCourseId(courseIdValue)
   const lessonId = query.lessonId === undefined
      ? null
      : parseId(query.lessonId, 'INVALID_LESSON_ID', 'Lesson identifier is invalid')
   await finalizeExpiredAttemptsForUserService(actorId, overrides)
   const now = deps.clock()
   const rows = await deps.repository.listLearnerAssignments(actorId, courseId, lessonId)
   const attempts = await deps.repository.listUserAttempts(actorId, rows.map((row) => row.id))
   return {
      assignments: rows.map((row) => safeLearnerAssignment(
         row,
         attempts.filter((attempt) => attempt.assignment_id === row.id),
         now,
      )),
      serverNow: now.toISOString(),
   }
}

function requireStartable(assignment, now) {
   const state = assignmentState(assignment, now)
   if (state === 'upcoming') {
      throw new AppError(409, 'ASSIGNMENT_NOT_OPEN', 'This assignment has not opened yet')
   }
   if (state === 'closed') {
      throw new AppError(409, 'ASSIGNMENT_CLOSED', 'This assignment is closed')
   }
}

function buildAttemptQuestions(deps, assignment, source) {
   const order = assignment.shuffle_questions ? deps.shuffle(source) : source
   const arrange = (keys) => (assignment.shuffle_options ? deps.shuffle(keys) : keys)
   return order.map((row, index) => ({
      test_question_id: row.test_question_id,
      question_id: row.question_id,
      position: index + 1,
      option_order: arrange(row.option_keys),
      matching_order: { left: arrange(row.left_keys), right: arrange(row.right_keys) },
      max_points: row.points,
      grading_snapshot: {
         questionType: row.question_type,
         answerData: row.answer_data,
         explanation: row.explanation,
         interactionSettings: row.interaction_settings,
         optionKeys: row.option_keys,
         leftKeys: row.left_keys,
         rightKeys: row.right_keys,
      },
   }))
}

function policySnapshot(assignment) {
   return {
      resultPolicy: assignment.result_policy,
      answerRevealPolicy: assignment.answer_reveal_policy,
      maxAttempts: assignment.max_attempts,
      durationSeconds: assignment.duration_seconds,
      passPercent: assignment.grading_policy?.passPercent ?? null,
      personalWindowMinutes: assignment.personal_window_minutes,
   }
}

async function createNewAttempt(deps, client, actorId, assignment, attempts, now) {
   requireStartable(assignment, now)
   if (assignment.max_attempts !== null && attemptsUsed(attempts) >= assignment.max_attempts) {
      throw new AppError(409, 'ATTEMPTS_EXHAUSTED', 'No attempts remain for this assignment')
   }
   const personalEnd = personalWindowEnd(
      attempts[0]?.started_at ?? now,
      assignment.personal_window_minutes,
   )
   if (personalEnd && personalEnd <= now) {
      throw new AppError(409, 'PERSONAL_WINDOW_ENDED', 'Your personal window for this assignment has ended')
   }
   const expiresAt = computeDeadline({
      startedAt: now,
      durationSeconds: assignment.duration_seconds,
      closesAt: assignment.closes_at,
      personalWindowEndsAt: personalEnd,
   })
   const attemptNumber = attempts.reduce((highest, attempt) => Math.max(highest, attempt.attempt_number), 0) + 1
   const attemptId = await deps.repository.createAttempt({
      testId: assignment.test_id,
      assignmentId: assignment.id,
      userId: actorId,
      attemptNumber,
      startedAt: now,
      expiresAt,
      policySnapshot: policySnapshot(assignment),
   }, client)
   const source = await deps.repository.listAttemptSource(assignment.test_id, client)
   await deps.repository.addAttemptQuestions(
      attemptId,
      assignment.test_id,
      buildAttemptQuestions(deps, assignment, source),
      client,
   )
   await deps.auth.appendAuditEvent({
      actorUserId: actorId,
      subjectUserId: actorId,
      code: 'test.attempt_started',
      entityType: 'test_attempt',
      entityId: attemptId,
      metadata: { testId: assignment.test_id, assignmentId: assignment.id, attemptNumber },
   }, client)
   return attemptId
}

async function readAttemptView(deps, actorId, attemptId) {
   const attempt = await deps.repository.findAttempt(actorId, attemptId)
   const questions = attempt.status === 'in_progress'
      ? await deps.repository.listAttemptQuestions(attemptId)
      : []
   return {
      attempt: { ...safeAttempt(attempt), title: attempt.title },
      questions: questions.map(safeLearnerQuestion),
      serverNow: deps.clock().toISOString(),
   }
}

async function startAttemptService(userId, assignmentIdValue, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const assignmentId = parseAssignmentId(assignmentIdValue)
   await finalizeExpiredAttemptsForUserService(actorId, overrides)
   const { attemptId, resumed } = await deps.transaction(async (client) => {
      const now = deps.clock()
      await deps.repository.lockAttemptSlot(actorId, assignmentId, client)
      const assignment = await deps.repository.findLearnerAssignment(actorId, assignmentId, client)
      if (!assignment) {
         // A revoked assignment or a left group stops new attempts, not a running one.
         const [open] = (await deps.repository.listUserAttempts(actorId, [assignmentId], client))
            .filter((attempt) => attempt.status === 'in_progress')
         if (!open) throw assignmentNotFound()
         const running = await deps.repository.findAttempt(actorId, open.id, client)
         await requireContentAccess(deps, actorId, running, now, client)
         return { attemptId: open.id, resumed: true }
      }
      if (assignment.test_status !== 'published') {
         throw new AppError(409, 'TEST_NOT_AVAILABLE', 'This test is not available')
      }
      await requireContentAccess(deps, actorId, assignment, now, client)
      const attempts = await deps.repository.listUserAttempts(actorId, [assignmentId], client)
      const open = attempts.find((attempt) => attempt.status === 'in_progress')
      if (open) return { attemptId: open.id, resumed: true }
      return {
         attemptId: await createNewAttempt(deps, client, actorId, assignment, attempts, now),
         resumed: false,
      }
   })
   return { ...await readAttemptView(deps, actorId, attemptId), resumed }
}

async function getAttemptService(userId, attemptIdValue, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const attemptId = parseAttemptId(attemptIdValue)
   await finalizeExpiredAttemptsForUserService(actorId, overrides)
   const attempt = await deps.repository.findAttempt(actorId, attemptId)
   if (!attempt) throw attemptNotFound()
   if (attempt.status === 'in_progress') {
      await requireContentAccess(deps, actorId, attempt, deps.clock())
   }
   return readAttemptView(deps, actorId, attemptId)
}

function parseRevision(value) {
   if (!Number.isSafeInteger(value) || value < 1) throw validationError('revision')
   return value
}

function safeSavedAnswer(attemptQuestionId, answer, row, now) {
   return {
      attemptQuestionId,
      answer,
      revision: Number(row.revision),
      savedAt: iso(row.saved_at),
      serverNow: now.toISOString(),
   }
}

// Revisions only move forward. Resending the current revision with the same answer repeats a
// lost response; anything older or different is a conflict that returns the stored revision.
async function saveAnswerService(userId, attemptIdValue, attemptQuestionIdValue, body, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const attemptId = parseAttemptId(attemptIdValue)
   const attemptQuestionId = parseAttemptQuestionId(attemptQuestionIdValue)
   validateBody(body, ['answer', 'revision'])
   if (body.answer === undefined) throw validationError('answer')
   const revision = parseRevision(body.revision)
   const outcome = await deps.transaction(async (client) => {
      const now = deps.clock()
      const attempt = await deps.repository.lockAttempt(actorId, attemptId, client)
      if (!attempt) throw attemptNotFound()
      if (attempt.status !== 'in_progress') {
         throw new AppError(409, 'ATTEMPT_NOT_IN_PROGRESS', 'This attempt is already finished')
      }
      if (hasExpired(attempt, now)) {
         await finalizeAttempt(deps, client, attempt, expiredFinish(attempt, now))
         return { expired: true }
      }
      await requireContentAccess(deps, actorId, attempt, now, client)
      const question = await deps.repository.findAttemptQuestion(attemptId, attemptQuestionId, client)
      if (!question) {
         throw new AppError(404, 'ATTEMPT_QUESTION_NOT_FOUND', 'Question is not part of this attempt')
      }
      const answer = parseStudentAnswer(body.answer, question.grading_snapshot)
      const current = Number(question.revision ?? 0)
      if (revision === current && isDeepStrictEqual(question.answer_data, answer)) {
         return { saved: safeSavedAnswer(attemptQuestionId, answer, question, now) }
      }
      if (revision <= current) {
         throw new AppError(409, 'ANSWER_REVISION_CONFLICT', 'A newer answer is already saved', [
            { field: 'revision', message: String(current) },
         ])
      }
      const row = await deps.repository.saveAnswer({
         attemptQuestionId,
         questionId: question.question_id,
         answerData: answer,
         revision,
         savedAt: now,
      }, client)
      return { saved: safeSavedAnswer(attemptQuestionId, answer, row, now) }
   })
   // Thrown after the commit, so the automatic submission above is kept.
   if (outcome.expired) {
      throw new AppError(409, 'ATTEMPT_DEADLINE_PASSED', 'The deadline of this attempt has passed')
   }
   return outcome.saved
}

async function readResult(deps, attempt, now) {
   const policy = attempt.policy_snapshot.answerRevealPolicy
   const attempts = await deps.repository.listUserAttempts(attempt.user_id, [attempt.assignment_id])
   const remaining = remainingAttempts(attempt.policy_snapshot.maxAttempts, attempts)
   const revealed = answersRevealed(policy, attempt.closes_at, now, remaining)
   const questions = revealed
      ? await deps.repository.listAttemptQuestions(attempt.id, { withSnapshot: true })
      : []
   const percent = scorePercent(attempt.score, attempt.max_score)
   const { passPercent } = attempt.policy_snapshot
   return {
      attempt: { ...safeAttempt(attempt), title: attempt.title },
      percent,
      passed: passPercent === null ? null : percent >= passPercent,
      answerRevealPolicy: policy,
      revealed,
      revealsAt: policy !== 'never' && !revealed ? iso(attempt.closes_at) : null,
      remainingAttempts: remaining,
      questions: questions.map(safeReviewQuestion),
      serverNow: now.toISOString(),
   }
}

async function submitAttemptService(userId, attemptIdValue, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const attemptId = parseAttemptId(attemptIdValue)
   await deps.transaction(async (client) => {
      const now = deps.clock()
      const attempt = await deps.repository.lockAttempt(actorId, attemptId, client)
      if (!attempt) throw attemptNotFound()
      if (attempt.status !== 'in_progress') return
      await finalizeAttempt(deps, client, attempt, hasExpired(attempt, now)
         ? expiredFinish(attempt, now)
         : { status: 'graded', submittedAt: now, actorId, now })
   })
   return readResult(deps, await deps.repository.findAttempt(actorId, attemptId), deps.clock())
}

async function getAttemptResultService(userId, attemptIdValue, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const attemptId = parseAttemptId(attemptIdValue)
   await finalizeExpiredAttemptsForUserService(actorId, overrides)
   const attempt = await deps.repository.findAttempt(actorId, attemptId)
   if (!attempt) throw attemptNotFound()
   if (!isFinished(attempt)) {
      throw new AppError(409, 'RESULT_NOT_READY', 'Submit the attempt to see the result')
   }
   return readResult(deps, attempt, deps.clock())
}

// The result chosen by the test's result policy, among every attempt of the assignment.
async function getAssignmentResultService(userId, assignmentIdValue, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const assignmentId = parseAssignmentId(assignmentIdValue)
   await finalizeExpiredAttemptsForUserService(actorId, overrides)
   const assignment = await deps.repository.findLearnerAssignment(actorId, assignmentId)
   if (!assignment) throw assignmentNotFound()
   const attempts = await deps.repository.listUserAttempts(actorId, [assignmentId])
   const selected = selectResultAttempt(assignment.result_policy, attempts)
   return {
      resultPolicy: assignment.result_policy,
      resultAttemptId: selected?.id ?? null,
      score: selected?.score ?? null,
      maxScore: selected?.max_score ?? null,
      remainingAttempts: remainingAttempts(assignment.max_attempts, attempts),
      attempts: attempts.map(safeAttempt),
      serverNow: deps.clock().toISOString(),
   }
}

export {
   attemptStateSummary,
   finalizeExpiredAttemptsForUserService,
   finalizeNextExpiredAttemptService,
   getAssignmentResultService,
   getAttemptResultService,
   getAttemptService,
   listMyAssignmentsService,
   safeAttempt,
   safeQuestionBase,
   saveAnswerService,
   startAttemptService,
   submitAttemptService,
}
