import * as authRepository from '../repositories/auth-repository.js'
import * as mockExamRepository from '../repositories/mock-exam-repository.js'
import * as attemptRepository from '../repositories/test-attempt-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import AppError from '../utils/app-error.js'
import { digitsSheet, digitsSnapshot, scorePercent, sumPoints, toHundredths } from '../utils/attempt-grading.js'
import { normalizeInternalId } from '../utils/internal-id.js'
import { authorizePermissionService } from './authorization-service.js'
import { parseUserId, validateBody, validationError } from './course-service.js'
import {
   finalizeExpiredAttemptsForUserService,
   listAttemptQuestionViewsService,
   saveAnswerService,
   startAttemptInTransactionService,
   submitAttemptService,
} from './test-attempt-service.js'

const codePattern = /^[a-z0-9][a-z0-9_-]{0,49}$/
const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{8,100}$/
const rowLabels = 'ABCDEFGHIJ'

// Optional overrides for tests: repositories, transaction, clock, authorization and the attempt
// service overrides (storage / clock for image URLs).
function dependencies(overrides = {}) {
   return {
      repository: overrides.mockExamRepository || mockExamRepository,
      attemptRepository: overrides.repository || attemptRepository,
      auth: overrides.auth || authRepository,
      transaction: overrides.transaction || withTransaction,
      clock: overrides.clock || (() => new Date()),
      authorization: overrides.authorization,
      attempts: overrides,
   }
}

function iso(value) {
   return value === null || value === undefined ? null : new Date(value).toISOString()
}

function formatHundredths(value) {
   return (value / 100).toFixed(2)
}

function parseId(value, code, message) {
   try {
      return normalizeInternalId(value)
   } catch {
      throw new AppError(400, code, message)
   }
}

function parseAttemptId(value) {
   return parseId(value, 'INVALID_ATTEMPT_ID', 'Attempt identifier is invalid')
}

function parseAttemptQuestionId(value) {
   return parseId(value, 'INVALID_ATTEMPT_QUESTION_ID', 'Attempt question identifier is invalid')
}

function mockExamNotFound() {
   return new AppError(404, 'MOCK_EXAM_NOT_FOUND', 'Mock exam was not found')
}

// The mock exam uses the trainer's access rule: an active account and trainer.use.
async function requireLearner(deps, actorId, db) {
   if (!await deps.attemptRepository.isActiveAccount(actorId, db)) {
      throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'Account is not active')
   }
   await authorizePermissionService(actorId, 'trainer.use', {
      errorCode: 'TRAINER_STUDENT_ROLE_REQUIRED',
      message: 'The NCT trainer and mock exam are available to students',
   }, deps.authorization)
}

// ------------------------------------------------------------------ blueprints

// Items must cover the sheet numbers 1..N of a section without gaps or overlaps.
function shapeBlueprint(row) {
   let offset = 0
   const sections = row.sections.map((section) => {
      let next = 1
      const items = section.items.map((item) => {
         if (item.firstPosition !== next) {
            throw new AppError(500, 'MOCK_EXAM_BLUEPRINT_INVALID', 'The exam blueprint is not consistent')
         }
         next = item.lastPosition + 1
         const questionCount = item.lastPosition - item.firstPosition + 1
         return { ...item, questionCount, maxScore: toHundredths(item.points) * questionCount }
      })
      const shaped = {
         position: section.position,
         subjectCode: section.subjectCode,
         firstExamPosition: offset + 1,
         questionCount: next - 1,
         maxScore: items.reduce((sum, item) => sum + item.maxScore, 0),
         items,
      }
      offset += shaped.questionCount
      return shaped
   })
   return {
      id: row.id,
      code: row.code,
      titles: row.titles,
      language: row.language_code,
      bankCodePrefix: row.bank_code_prefix,
      durationMinutes: row.duration_minutes,
      questionCount: offset,
      maxScore: sections.reduce((sum, section) => sum + section.maxScore, 0),
      sections,
   }
}

function candidateSpec(item, subjectId, language) {
   return {
      kind: item.kind,
      subjectId,
      language,
      optionCount: item.optionCount,
      leftCount: item.leftCount,
      rightCount: item.rightCount,
      maxDigits: item.maxDigits,
      difficultyMin: item.difficultyMin,
      difficultyMax: item.difficultyMax,
   }
}

function requirementsOf(item) {
   if (item.kind === 'single') return { optionCount: item.optionCount }
   if (item.kind === 'matching') return { leftCount: item.leftCount, rightCount: item.rightCount }
   return { maxDigits: item.maxDigits, wholeNumber: true }
}

async function subjectsByCode(deps, blueprints, db) {
   const codes = [...new Set(blueprints.flatMap((blueprint) => blueprint.sections.map((section) => section.subjectCode)))]
   const rows = codes.length ? await deps.repository.listSubjectsByCodes(codes, db) : []
   return new Map(rows.map((row) => [row.code, row]))
}

async function catalogEntry(deps, blueprint, subjects) {
   const shortages = []
   let variants = null
   const sections = []
   for (const section of blueprint.sections) {
      const subject = subjects.get(section.subjectCode) ?? null
      const items = []
      for (const item of section.items) {
         const available = subject
            ? await deps.repository.countCandidates(
               blueprint.bankCodePrefix,
               candidateSpec(item, subject.id, blueprint.language),
            )
            : 0
         if (available < item.questionCount) {
            shortages.push({ subjectCode: section.subjectCode, kind: item.kind, needed: item.questionCount, available })
         }
         const fit = Math.floor(available / item.questionCount)
         variants = variants === null ? fit : Math.min(variants, fit)
         items.push({
            kind: item.kind,
            firstPosition: item.firstPosition,
            lastPosition: item.lastPosition,
            questionCount: item.questionCount,
            points: item.points,
            scoring: item.scoring,
            maxScore: formatHundredths(item.maxScore),
            requirements: requirementsOf(item),
            difficulty: { min: item.difficultyMin, max: item.difficultyMax, order: item.difficultyOrder },
            available,
         })
      }
      sections.push({
         position: section.position,
         subjectCode: section.subjectCode,
         subjectId: subject?.id ?? null,
         titles: subject?.titles ?? {},
         color: subject?.color ?? null,
         questionCount: section.questionCount,
         maxScore: formatHundredths(section.maxScore),
         items,
      })
   }
   return {
      code: blueprint.code,
      titles: blueprint.titles,
      language: blueprint.language,
      durationMinutes: blueprint.durationMinutes,
      questionCount: blueprint.questionCount,
      maxScore: formatHundredths(blueprint.maxScore),
      canAssemble: shortages.length === 0,
      // How many exams could be built with no question repeated across them (per range, so a
      // section with two ranges of one kind would be counted optimistically).
      distinctVariants: variants ?? 0,
      shortages,
      sections,
   }
}

async function listMockExamBlueprintsService(userId, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   await requireLearner(deps, actorId)
   const blueprints = (await deps.repository.listActiveBlueprints()).map(shapeBlueprint)
   const subjects = await subjectsByCode(deps, blueprints)
   const entries = []
   for (const blueprint of blueprints) entries.push(await catalogEntry(deps, blueprint, subjects))
   return { blueprints: entries }
}

// ------------------------------------------------------------------ create

function parseCreateBody(body) {
   validateBody(body, ['blueprint', 'idempotencyKey'])
   if (typeof body.blueprint !== 'string' || !codePattern.test(body.blueprint)) {
      throw validationError('blueprint')
   }
   if (body.idempotencyKey !== undefined
      && (typeof body.idempotencyKey !== 'string' || !idempotencyKeyPattern.test(body.idempotencyKey))) {
      throw validationError('idempotencyKey', 'idempotencyKey must be 8-100 characters of A-Z a-z 0-9 . _ : -')
   }
   return { blueprint: body.blueprint, idempotencyKey: body.idempotencyKey ?? null }
}

// The accepted digits of a cells question, as the grader compares them.
function cellsExtension(row, item) {
   return digitsSnapshot(row.question_type, row.answer_data, item.maxDigits)
}

function byDifficulty(rows) {
   return rows
      .map((row, index) => ({ row, index }))
      .sort((left, right) => (left.row.difficulty ?? 6) - (right.row.difficulty ?? 6) || left.index - right.index)
      .map(({ row }) => row)
}

// Position by position, no question twice in one exam. Every shortage is collected, so the
// error names all missing subject/kind pairs at once.
async function assembleExam(deps, client, actorId, blueprint, subjects) {
   const picked = []
   const shortages = []
   for (const section of blueprint.sections) {
      const subject = subjects.get(section.subjectCode)
      for (const item of section.items) {
         if (!subject) {
            shortages.push({ subjectCode: section.subjectCode, kind: item.kind, needed: item.questionCount, available: 0 })
            continue
         }
         const spec = candidateSpec(item, subject.id, blueprint.language)
         const rows = await deps.repository.pickCandidates(blueprint.bankCodePrefix, spec, {
            userId: actorId,
            excludeIds: picked.map((entry) => entry.questionId),
            limit: item.questionCount,
         }, client)
         if (rows.length < item.questionCount) {
            shortages.push({
               subjectCode: section.subjectCode,
               kind: item.kind,
               needed: item.questionCount,
               available: await deps.repository.countCandidates(blueprint.bankCodePrefix, spec, client),
            })
            continue
         }
         const ordered = item.difficultyOrder === 'ascending' ? byDifficulty(rows) : rows
         ordered.forEach((row, index) => {
            picked.push({
               questionId: String(row.id),
               position: section.firstExamPosition + item.firstPosition - 1 + index,
               sectionPosition: section.position,
               subjectCode: section.subjectCode,
               sheetNumber: item.firstPosition + index,
               kind: item.kind,
               points: item.points,
               extension: item.kind === 'cells' ? cellsExtension(row, item) : null,
            })
         })
      }
   }
   if (shortages.length) {
      throw new AppError(409, 'MOCK_EXAM_NOT_ENOUGH_QUESTIONS', 'Not enough questions for this exam blueprint',
         shortages.map((entry) => ({
            field: `${entry.subjectCode}.${entry.kind}`,
            message: `needed ${entry.needed}, available ${entry.available}`,
         })))
   }
   return picked
}

// The blueprint as it was when the exam was created; results read this, never the live tables.
function blueprintSnapshot(blueprint, subjects, idempotencyKey) {
   return {
      blueprintId: String(blueprint.id),
      blueprintCode: blueprint.code,
      titles: blueprint.titles,
      language: blueprint.language,
      durationMinutes: blueprint.durationMinutes,
      questionCount: blueprint.questionCount,
      maxScore: formatHundredths(blueprint.maxScore),
      sections: blueprint.sections.map((section) => {
         const subject = subjects.get(section.subjectCode)
         return {
            position: section.position,
            subjectCode: section.subjectCode,
            subjectId: String(subject.id),
            titles: subject.titles,
            color: subject.color,
            questionCount: section.questionCount,
            maxScore: formatHundredths(section.maxScore),
            items: section.items.map((item) => ({
               kind: item.kind,
               firstPosition: item.firstPosition,
               lastPosition: item.lastPosition,
               points: item.points,
               scoring: item.scoring,
            })),
         }
      }),
      ...(idempotencyKey ? { idempotencyKey } : {}),
   }
}

async function createMockExamService(userId, body, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const request = parseCreateBody(body)
   const { attemptId, resumed } = await deps.transaction(async (client) => {
      const now = deps.clock()
      await deps.repository.lockMockExamSlot(actorId, client)
      await requireLearner(deps, actorId, client)
      if (request.idempotencyKey) {
         const existing = await deps.repository.findMockAttemptByKey(actorId, request.idempotencyKey, client)
         if (existing) {
            if (existing.generation_filters.blueprintCode !== request.blueprint) {
               throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotencyKey was used for another request')
            }
            return { attemptId: existing.id, resumed: true }
         }
      }
      const row = await deps.repository.findActiveBlueprint(request.blueprint, client)
      if (!row) throw new AppError(404, 'MOCK_EXAM_BLUEPRINT_NOT_FOUND', 'Exam blueprint was not found')
      const open = await deps.repository.findOpenMockAttempt(actorId, client)
      if (open) {
         throw new AppError(409, 'MOCK_EXAM_IN_PROGRESS', 'Finish the current mock exam first', [
            { field: 'attemptId', message: String(open.id) },
         ])
      }
      const blueprint = shapeBlueprint(row)
      const subjects = await subjectsByCode(deps, [blueprint], client)
      const picked = await assembleExam(deps, client, actorId, blueprint, subjects)
      const testId = await deps.repository.createMockExamTest({
         title: blueprint.titles?.[blueprint.language] ?? blueprint.titles?.ru ?? blueprint.code,
         durationSeconds: blueprint.durationMinutes * 60,
         generationFilters: blueprintSnapshot(blueprint, subjects, request.idempotencyKey),
         createdBy: actorId,
      }, client)
      await deps.repository.addMockExamQuestions(testId, picked.map((entry) => ({
         question_id: entry.questionId,
         position: entry.position,
         points: entry.points,
      })), client)
      await deps.repository.publishMockExamTest(testId, client)
      const assignmentId = await deps.repository.createMockExamAssignment(testId, actorId, now, client)
      const snapshotExtensions = new Map(picked
         .filter((entry) => entry.extension)
         .map((entry) => [entry.questionId, entry.extension]))
      const id = await startAttemptInTransactionService(actorId, assignmentId, client, deps.attempts, { snapshotExtensions })
      const added = await deps.repository.addMockExamItems(id, picked.map((entry) => ({
         position: entry.position,
         section_position: entry.sectionPosition,
         subject_code: entry.subjectCode,
         sheet_number: entry.sheetNumber,
         item_kind: entry.kind,
      })), client)
      if (added !== picked.length) throw new Error('Mock exam items do not match the attempt questions')
      await deps.auth.appendAuditEvent({
         actorUserId: actorId,
         subjectUserId: actorId,
         code: 'trainer.mock_exam_created',
         entityType: 'test_attempt',
         entityId: id,
         metadata: { testId, blueprintCode: blueprint.code, questionCount: picked.length },
      }, client)
      return { attemptId: id, resumed: false }
   })
   return { ...await getMockExamService(actorId, attemptId, overrides), resumed }
}

// ------------------------------------------------------------------ attempt view

function isFinished(attempt) {
   return attempt.status === 'graded' || attempt.status === 'expired'
}

function examSummary(attempt, now) {
   const filters = attempt.generation_filters
   const finished = isFinished(attempt)
   const running = attempt.status === 'in_progress'
   return {
      attemptId: attempt.id,
      status: attempt.status,
      finished,
      autoSubmitted: attempt.status === 'expired',
      blueprintCode: filters.blueprintCode,
      titles: filters.titles,
      language: filters.language,
      durationMinutes: filters.durationMinutes,
      questionCount: filters.questionCount,
      startedAt: iso(attempt.started_at),
      deadlineAt: iso(attempt.expires_at),
      submittedAt: iso(attempt.submitted_at),
      remainingSeconds: running
         ? Math.max(0, Math.ceil((new Date(attempt.expires_at).getTime() - now.getTime()) / 1000))
         : 0,
      score: finished ? attempt.score : null,
      maxScore: filters.maxScore,
      percent: finished ? scorePercent(attempt.score, attempt.max_score) : null,
   }
}

function sectionHeader(section) {
   return {
      position: section.position,
      subjectCode: section.subjectCode,
      subjectId: section.subjectId,
      titles: section.titles,
      color: section.color,
      questionCount: section.questionCount,
      maxScore: section.maxScore,
   }
}

async function loadMockAttempt(deps, actorId, attemptIdValue) {
   const attemptId = parseAttemptId(attemptIdValue)
   await requireLearner(deps, actorId)
   // Lazy expiry: any read first finishes this user's attempts whose deadline has passed.
   await finalizeExpiredAttemptsForUserService(actorId, deps.attempts)
   const attempt = await deps.repository.findMockAttempt(actorId, attemptId)
   if (!attempt) throw mockExamNotFound()
   return attempt
}

async function getMockExamService(userId, attemptIdValue, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const attempt = await loadMockAttempt(deps, actorId, attemptIdValue)
   const now = deps.clock()
   const running = attempt.status === 'in_progress'
   const items = await deps.repository.listMockExamItems(attempt.id)
   const { questions } = running
      ? await listAttemptQuestionViewsService(attempt.id, {}, deps.attempts)
      : { questions: [] }
   const views = new Map(questions.map((question) => [String(question.id), question]))
   return {
      exam: examSummary(attempt, now),
      // A finished exam shows no questions here; read GET .../result.
      sections: attempt.generation_filters.sections.map((section) => {
         const own = items.filter((item) => item.section_position === section.position)
         return {
            ...sectionHeader(section),
            answered: running
               ? own.filter((item) => views.get(String(item.attempt_question_id))?.answer != null).length
               : null,
            flagged: running ? own.filter((item) => item.flagged).length : null,
            questions: running
               ? own.map((item) => {
                  const view = views.get(String(item.attempt_question_id))
                  return {
                     attemptQuestionId: view.id,
                     number: item.sheet_number,
                     examPosition: view.position,
                     kind: item.item_kind,
                     questionType: view.questionType,
                     points: view.points,
                     flagged: item.flagged,
                     content: view.content,
                     interactionSettings: view.interactionSettings,
                     options: view.options,
                     matching: view.matching,
                     ...cellsFields(view),
                     answer: view.answer,
                     revision: view.revision,
                     savedAt: view.savedAt,
                  }
               })
               : [],
         }
      }),
      serverNow: now.toISOString(),
   }
}

// ------------------------------------------------------------------ answers and flags

async function saveMockExamAnswerService(userId, attemptIdValue, attemptQuestionIdValue, body, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const attemptId = parseAttemptId(attemptIdValue)
   const attemptQuestionId = parseAttemptQuestionId(attemptQuestionIdValue)
   await requireLearner(deps, actorId)
   if (!await deps.repository.findMockAttempt(actorId, attemptId)) throw mockExamNotFound()
   // The engine locks the attempt, rejects answers after the deadline (finishing the attempt)
   // and validates cells input against the snapshot (digits only).
   return saveAnswerService(actorId, attemptId, attemptQuestionId, body, deps.attempts)
}

async function setMockExamFlagService(userId, attemptIdValue, attemptQuestionIdValue, body, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const attemptId = parseAttemptId(attemptIdValue)
   const attemptQuestionId = parseAttemptQuestionId(attemptQuestionIdValue)
   validateBody(body, ['flagged'])
   if (typeof body.flagged !== 'boolean') throw validationError('flagged')
   await requireLearner(deps, actorId)
   const outcome = await deps.transaction(async (client) => {
      const now = deps.clock()
      const attempt = await deps.attemptRepository.lockAttempt(actorId, attemptId, client)
      if (!attempt || attempt.origin !== 'mock_exam') throw mockExamNotFound()
      if (attempt.status !== 'in_progress') {
         throw new AppError(409, 'ATTEMPT_NOT_IN_PROGRESS', 'This attempt is already finished')
      }
      if (attempt.expires_at !== null && new Date(attempt.expires_at) <= now) return { expired: true }
      const row = await deps.repository.setMockExamItemFlag(attemptId, attemptQuestionId, body.flagged, now, client)
      if (!row) throw new AppError(404, 'ATTEMPT_QUESTION_NOT_FOUND', 'Question is not part of this attempt')
      return {
         saved: {
            attemptQuestionId: row.attempt_question_id,
            flagged: row.flagged,
            flaggedAt: iso(row.flagged_at),
            serverNow: now.toISOString(),
         },
      }
   })
   if (outcome.expired) {
      await finalizeExpiredAttemptsForUserService(actorId, deps.attempts)
      throw new AppError(409, 'ATTEMPT_DEADLINE_PASSED', 'The deadline of this attempt has passed')
   }
   return outcome.saved
}

// ------------------------------------------------------------------ result

function singleSheet(view, key) {
   const keys = view.options.map((option) => option.key)
   const selected = view.answer?.optionKey ?? null
   const number = (value) => (value === null || !keys.includes(value) ? null : keys.indexOf(value) + 1)
   return {
      selectedOptionKey: selected,
      selectedOptionNumber: number(selected),
      correctOptionKey: key.optionKey,
      correctOptionNumber: number(key.optionKey),
   }
}

// Rows A.. are the left items, columns 1.. the right items, both in the order shown.
function matchingSheet(view, key) {
   const columns = view.matching.right.map((item) => item.key)
   const chosen = new Map((view.answer?.pairs ?? []).map((pair) => [pair.left, pair.right]))
   const expected = new Map(key.pairs.map((pair) => [pair.left, pair.right]))
   const column = (value) => (value === null || value === undefined ? null : columns.indexOf(value) + 1 || null)
   const rows = view.matching.left.map((item, index) => {
      const selected = chosen.get(item.key) ?? null
      const correct = expected.get(item.key) ?? null
      return {
         row: rowLabels[index],
         leftKey: item.key,
         selectedRightKey: selected,
         selectedColumn: column(selected),
         correctRightKey: correct,
         correctColumn: column(correct),
         correct: selected !== null && selected === correct,
      }
   })
   return { rows, correctPairs: rows.filter((row) => row.correct).length, totalPairs: rows.length }
}

// The input settings of a cells question, the same fields the trainer sends.
function cellsFields(view) {
   return view.answerFormat ? { answerFormat: view.answerFormat, maxDigits: view.maxDigits } : {}
}

function cellsSheet(view, snapshot) {
   return digitsSheet(view.answer, snapshot)
}

function sheetOf(kind, view, snapshot) {
   if (kind === 'single') return singleSheet(view, snapshot.answerData)
   if (kind === 'matching') return matchingSheet(view, snapshot.answerData)
   return cellsSheet(view, snapshot)
}

async function readMockResult(deps, attempt, now) {
   const items = await deps.repository.listMockExamItems(attempt.id)
   const { rows, questions } = await listAttemptQuestionViewsService(attempt.id, { review: true }, deps.attempts)
   const byId = new Map(questions.map((question, index) => [String(question.id), { view: question, row: rows[index] }]))
   const sections = attempt.generation_filters.sections.map((section) => {
      const own = items
         .filter((item) => item.section_position === section.position)
         .map((item) => {
            const { view, row } = byId.get(String(item.attempt_question_id))
            const awardedPoints = view.awardedPoints ?? '0.00'
            return {
               attemptQuestionId: view.id,
               number: item.sheet_number,
               examPosition: view.position,
               kind: item.item_kind,
               questionType: view.questionType,
               points: view.points,
               awardedPoints,
               answered: view.answer !== null,
               correct: view.correct,
               flagged: item.flagged,
               content: view.content,
               interactionSettings: view.interactionSettings,
               options: view.options,
               matching: view.matching,
               ...cellsFields(view),
               answer: view.answer,
               correctAnswer: view.correctAnswer,
               explanation: view.explanation,
               sheet: sheetOf(item.item_kind, view, row.grading_snapshot),
            }
         })
      const score = sumPoints(own.map((question) => question.awardedPoints))
      return {
         ...sectionHeader(section),
         score,
         percent: scorePercent(score, section.maxScore),
         answered: own.filter((question) => question.answered).length,
         correct: own.filter((question) => question.correct).length,
         questions: own,
      }
   })
   return { exam: examSummary(attempt, now), sections, serverNow: now.toISOString() }
}

async function submitMockExamService(userId, attemptIdValue, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const attempt = await loadMockAttempt(deps, actorId, attemptIdValue)
   // Repeating a submit grades nothing again and returns the same result.
   await submitAttemptService(actorId, attempt.id, deps.attempts)
   return readMockResult(deps, await deps.repository.findMockAttempt(actorId, attempt.id), deps.clock())
}

async function getMockExamResultService(userId, attemptIdValue, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const attempt = await loadMockAttempt(deps, actorId, attemptIdValue)
   if (!isFinished(attempt)) {
      throw new AppError(409, 'RESULT_NOT_READY', 'Submit the mock exam to see the result')
   }
   return readMockResult(deps, attempt, deps.clock())
}

// ------------------------------------------------------------------ history

function parsePaging(query) {
   const integer = (value, field, fallback, max) => {
      if (value === undefined) return fallback
      const parsed = Number(value)
      if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) throw validationError(field)
      return parsed
   }
   const limit = integer(query.limit, 'limit', 20, 100)
   if (limit === 0) throw validationError('limit')
   return { limit, offset: integer(query.offset, 'offset', 0, 100000) }
}

async function listMockExamHistoryService(userId, query = {}, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const paging = parsePaging(query)
   await requireLearner(deps, actorId)
   await finalizeExpiredAttemptsForUserService(actorId, deps.attempts)
   const [rows, open] = await Promise.all([
      deps.repository.listFinishedMockAttempts(actorId, paging),
      deps.repository.findOpenMockAttempt(actorId),
   ])
   return {
      exams: rows.slice(0, paging.limit).map((row) => {
         const filters = row.generation_filters
         const scores = new Map(row.section_scores.map((entry) => [entry.sectionPosition, entry.score]))
         return {
            attemptId: row.id,
            status: row.status,
            autoSubmitted: row.status === 'expired',
            blueprintCode: filters.blueprintCode,
            titles: filters.titles,
            startedAt: iso(row.started_at),
            submittedAt: iso(row.submitted_at),
            score: row.score,
            maxScore: filters.maxScore,
            percent: scorePercent(row.score, row.max_score),
            subjects: filters.sections.map((section) => {
               const score = scores.get(section.position) ?? '0.00'
               return {
                  subjectCode: section.subjectCode,
                  subjectId: section.subjectId,
                  titles: section.titles,
                  score,
                  maxScore: section.maxScore,
                  percent: scorePercent(score, section.maxScore),
               }
            }),
         }
      }),
      pagination: { limit: paging.limit, offset: paging.offset, hasMore: rows.length > paging.limit },
      openAttemptId: open?.id ?? null,
   }
}

export {
   createMockExamService,
   getMockExamResultService,
   getMockExamService,
   listMockExamBlueprintsService,
   listMockExamHistoryService,
   saveMockExamAnswerService,
   setMockExamFlagService,
   submitMockExamService,
}
