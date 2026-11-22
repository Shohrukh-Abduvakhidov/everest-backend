import { randomInt } from 'node:crypto'

import env from '../configs/env.js'
import * as authRepository from '../repositories/auth-repository.js'
import * as trainerRepository from '../repositories/trainer-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import AppError from '../utils/app-error.js'
import { digitsSnapshot, scorePercent } from '../utils/attempt-grading.js'
import { normalizeInternalId } from '../utils/internal-id.js'
import { subjectReadiness } from '../utils/learning-metrics.js'
import { authorizePermissionService } from './authorization-service.js'
import { parseUserId, validateBody, validationError } from './course-service.js'
import { getAttemptService, startAttemptInTransactionService } from './test-attempt-service.js'

const languages = ['tg', 'ru', 'en']
const codePattern = /^[a-z0-9][a-z0-9_-]{0,49}$/
const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{8,100}$/

// Optional overrides for tests: repository, transaction, clock, config and the attempt
// service overrides (storage / clock for image URLs).
function dependencies(overrides = {}) {
   return {
      repository: overrides.trainerRepository || trainerRepository,
      auth: overrides.auth || authRepository,
      transaction: overrides.transaction || withTransaction,
      clock: overrides.clock || (() => new Date()),
      config: overrides.trainerConfig || env.trainer,
      attempts: overrides,
      authorization: overrides.authorization,
   }
}

// The trainer is its own module: no course or enrollment. A student (permission trainer.use)
// with an account an administrator approved and did not block.
async function requireTrainerLearner(deps, actorId, db) {
   if (await deps.repository.findAccountStatus(actorId, db) !== 'active') {
      throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'Account is not active')
   }
   await authorizePermissionService(actorId, 'trainer.use', {
      errorCode: 'TRAINER_STUDENT_ROLE_REQUIRED',
      message: 'The trainer is available to students',
   }, deps.authorization)
}

function iso(value) {
   return value === null || value === undefined ? null : new Date(value).toISOString()
}

function levelOf(config, difficulty) {
   if (difficulty === null || difficulty === undefined) return null
   return config.levels.find((level) => difficulty >= level.min && difficulty <= level.max)?.name ?? null
}

function difficultiesOf(level) {
   const values = []
   for (let value = level.min; value <= level.max; value += 1) values.push(value)
   return values
}

const modes = ['standard', 'mistakes', 'unanswered']
// Fields mode "unanswered" takes from its source attempt instead of the request.
const sourceSetFields = ['subject', 'difficulty', 'language', 'sectionCode', 'topicCode', 'topicCodes']
const finishedStatuses = ['submitted', 'graded', 'expired']
const countAll = 'all'
const maximumTimeLimitMinutes = 1440
const maximumTopicCodes = 50

function trainerOptions(config) {
   return {
      modes,
      questionCounts: config.questionCounts,
      countAll,
      maxQuestions: config.maxQuestions,
      timeLimitMinutes: { min: 1, max: maximumTimeLimitMinutes },
      difficulties: [...config.levels.map((level) => level.name), 'mixed'],
      levels: config.levels.map((level) => ({ name: level.name, minDifficulty: level.min, maxDifficulty: level.max })),
      mixedShares: Object.fromEntries(config.levels.map((level, index) => [level.name, config.mixedShares[index]])),
   }
}

// ------------------------------------------------------------------ catalog

// Rows of (language_code, difficulty, total) added up per language: the total and the count of
// each level. Questions without a difficulty (or outside every level) count only for mixed.
function countsByLanguage(config, rows) {
   const byLanguage = new Map()
   for (const row of rows) {
      const entry = byLanguage.get(row.language_code) ?? {
         language: row.language_code,
         total: 0,
         difficulties: Object.fromEntries(config.levels.map((level) => [level.name, 0])),
      }
      const level = levelOf(config, row.difficulty)
      entry.total += row.total
      if (level) entry.difficulties[level] += row.total
      byLanguage.set(row.language_code, entry)
   }
   return [...byLanguage.values()]
}

// Rows of one entity per (language, difficulty) folded into one entry per entity, in row order.
function groupRows(rows, keyOf) {
   const groups = new Map()
   for (const row of rows) {
      const key = keyOf(row)
      groups.set(key, [...(groups.get(key) ?? []), row])
   }
   return [...groups.values()]
}

function sumTotals(rows) {
   return rows.reduce((sum, row) => sum + row.total, 0)
}

// Open mistakes per subject, section and topic (see listMistakeCounts); missing keys mean 0.
function mistakeIndex(rows) {
   const index = { subjects: new Map(), sections: new Map(), topics: new Map() }
   for (const row of rows) {
      const subjectId = String(row.subject_id)
      if (row.level === 3) index.subjects.set(subjectId, row.total)
      else if (row.level === 1 && row.section_code !== null) index.sections.set(`${subjectId}:${row.section_code}`, row.total)
      else if (row.level === 0 && row.topic_code !== null) {
         index.topics.set(`${subjectId}:${row.topic_code}`, { total: row.total, sectionCode: row.section_code })
      }
   }
   return index
}

// The catalog of trainable questions. mistakesOf: the student whose open mistakes are counted
// (the learner catalog), or null for the staff catalog, which has no mistakes fields at all.
async function buildCatalog(deps, mistakesOf) {
   const { config } = deps
   const counts = await deps.repository.listTrainableCounts(config.bankCodePrefix)
   const subjectIds = [...new Set(counts.map((row) => row.subject_id))]
   const [subjects, sections, topics, mistakeRows] = await Promise.all([
      deps.repository.listSubjects(subjectIds),
      deps.repository.listTrainableSections(config.bankCodePrefix),
      deps.repository.listTrainableTopics(config.bankCodePrefix),
      mistakesOf === null ? [] : deps.repository.listMistakeCounts(mistakesOf, config.bankCodePrefix),
   ])
   const mistakes = mistakeIndex(mistakeRows)
   const withMistakes = (entry, value) => (mistakesOf === null ? entry : { ...entry, mistakes: value ?? 0 })
   return {
      options: trainerOptions(config),
      subjects: subjects.map((subject) => {
         const subjectId = String(subject.id)
         return {
            ...withMistakes({
               id: subject.id,
               code: subject.code,
               color: subject.color,
               primaryLanguage: subject.primary_language,
               titles: subject.titles,
               languages: countsByLanguage(config, counts.filter((entry) => entry.subject_id === subject.id)),
            }, mistakes.subjects.get(subjectId)),
            sections: groupRows(sections.filter((row) => row.subject_id === subject.id), (row) => row.code)
               .map((rows) => withMistakes({
                  code: rows[0].code,
                  titles: rows[0].titles,
                  total: sumTotals(rows),
                  languages: countsByLanguage(config, rows),
               }, mistakes.sections.get(`${subjectId}:${rows[0].code}`))),
            topics: groupRows(topics.filter((row) => row.subject_id === subject.id), (row) => row.code)
               .map((rows) => withMistakes({
                  code: rows[0].code,
                  sectionCode: rows[0].section_code,
                  titles: rows[0].titles,
                  total: sumTotals(rows),
                  languages: countsByLanguage(config, rows),
               }, mistakes.topics.get(`${subjectId}:${rows[0].code}`)?.total)),
         }
      }),
   }
}

async function getTrainerCatalogService(userId, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   await requireTrainerLearner(deps, actorId)
   return buildCatalog(deps, actorId)
}

// GET /admin/trainer/catalog: the same catalog for authors of tests (tests.manage, checked by the
// route), without anybody's mistakes. Options for modes and time limits are the trainer's own.
async function getStaffTrainerCatalogService(userId, overrides) {
   const deps = dependencies(overrides)
   parseUserId(userId)
   return buildCatalog(deps, null)
}

// ------------------------------------------------------------------ create

function parseSubject(value) {
   if (typeof value === 'number' || (typeof value === 'string' && /^[0-9]+$/.test(value))) {
      try {
         return { id: normalizeInternalId(value), code: null }
      } catch {
         throw validationError('subject')
      }
   }
   if (typeof value === 'string' && codePattern.test(value)) return { id: null, code: value }
   throw validationError('subject')
}

function parseOptionalCode(value, field) {
   if (value === undefined || value === null) return null
   if (typeof value !== 'string' || !codePattern.test(value)) throw validationError(field)
   return value
}

// topicCode (one topic, kept for older clients) or topicCodes (several); sorted and unique, so the
// same choice in another order is the same request.
function parseTopicCodes(body) {
   const hasList = body.topicCodes !== undefined && body.topicCodes !== null
   if (hasList && body.topicCode !== undefined && body.topicCode !== null) {
      throw validationError('topicCodes', 'Send topicCode or topicCodes, not both')
   }
   if (!hasList) {
      const single = parseOptionalCode(body.topicCode, 'topicCode')
      return single ? [single] : []
   }
   if (!Array.isArray(body.topicCodes) || body.topicCodes.length === 0 || body.topicCodes.length > maximumTopicCodes) {
      throw validationError('topicCodes', `topicCodes must be a list of 1-${maximumTopicCodes} topic codes`)
   }
   for (const code of body.topicCodes) {
      if (typeof code !== 'string' || !codePattern.test(code)) throw validationError('topicCodes')
   }
   return [...new Set(body.topicCodes)].sort()
}

function parseSourceAttemptId(value) {
   if (value === undefined || value === null) {
      throw validationError('sourceAttemptId', 'sourceAttemptId is required in mode unanswered')
   }
   if (!(Number.isSafeInteger(value) || (typeof value === 'string' && /^[0-9]+$/.test(value)))) {
      throw validationError('sourceAttemptId')
   }
   try {
      return normalizeInternalId(String(value))
   } catch {
      throw validationError('sourceAttemptId')
   }
}

// What both the create body and the availability query select: mode, subject, level, language,
// section and topics. In mistakes mode the level is optional (mixed = any). Mode unanswered
// selects only sourceAttemptId: subject and language come from that attempt.
function parseSelection(body, config) {
   const mode = body.mode ?? 'standard'
   if (!modes.includes(mode)) throw validationError('mode', `mode must be one of ${modes.join(', ')}`)
   if (mode === 'unanswered') {
      for (const field of sourceSetFields) {
         if (body[field] !== undefined && body[field] !== null) {
            throw validationError(field, `${field} comes from the source attempt in mode unanswered`)
         }
      }
      return { mode, sourceAttemptId: parseSourceAttemptId(body.sourceAttemptId) }
   }
   if (body.sourceAttemptId !== undefined && body.sourceAttemptId !== null) {
      throw validationError('sourceAttemptId', 'sourceAttemptId is only for mode unanswered')
   }
   const difficulties = trainerOptions(config).difficulties
   const difficulty = body.difficulty ?? (mode === 'mistakes' ? 'mixed' : undefined)
   if (!difficulties.includes(difficulty)) {
      throw validationError('difficulty', `difficulty must be one of ${difficulties.join(', ')}`)
   }
   if (body.language !== undefined && body.language !== null && !languages.includes(body.language)) {
      throw validationError('language')
   }
   return {
      mode,
      subject: parseSubject(body.subject),
      difficulty,
      language: body.language ?? null,
      sectionCode: parseOptionalCode(body.sectionCode, 'sectionCode'),
      topicCodes: parseTopicCodes(body),
   }
}

function parseCount(value, config) {
   if (value === countAll || config.questionCounts.includes(value)) return value
   throw validationError('count', `count must be one of ${[...config.questionCounts, countAll].join(', ')}`)
}

function parseTimeLimit(value) {
   if (value === undefined || value === null) return null
   if (!Number.isSafeInteger(value) || value < 1 || value > maximumTimeLimitMinutes) {
      throw validationError('timeLimitMinutes', `timeLimitMinutes must be a whole number from 1 to ${maximumTimeLimitMinutes}`)
   }
   return value
}

function parseCreateBody(body, config) {
   validateBody(body, [
      'mode', 'subject', 'difficulty', 'count', 'language', 'sectionCode', 'topicCode', 'topicCodes',
      'timeLimitMinutes', 'idempotencyKey', 'sourceAttemptId',
   ])
   const selection = parseSelection(body, config)
   if (body.idempotencyKey !== undefined
      && (typeof body.idempotencyKey !== 'string' || !idempotencyKeyPattern.test(body.idempotencyKey))) {
      throw validationError('idempotencyKey', 'idempotencyKey must be 8-100 characters of A-Z a-z 0-9 . _ : -')
   }
   return {
      ...selection,
      // Mode unanswered takes every blank question by default (up to maxQuestions).
      count: selection.mode === 'unanswered' && body.count === undefined ? countAll : parseCount(body.count, config),
      timeLimitMinutes: parseTimeLimit(body.timeLimitMinutes),
      idempotencyKey: body.idempotencyKey ?? null,
   }
}

// Query strings: topicCodes may come as a comma-separated value or a repeated parameter.
function parseAvailabilityQuery(query, config) {
   validateBody(query, [
      'mode', 'subject', 'difficulty', 'language', 'sectionCode', 'topicCode', 'topicCodes', 'sourceAttemptId',
   ])
   const list = query.topicCodes
   const topicCodes = list === undefined ? undefined : (Array.isArray(list) ? list : String(list).split(','))
   return parseSelection({ ...query, topicCodes }, config)
}

// Candidate filters of a request (see candidateFilter in the repository). A standard training
// draws from one language, the subject's primary one by default; mistakes come from any language
// unless one is asked for.
function candidateFilters(deps, actorId, subject, request) {
   const level = deps.config.levels.find((entry) => entry.name === request.difficulty)
   return {
      subjectId: subject.id,
      language: request.mode === 'mistakes' ? request.language : (request.language ?? subject.primary_language),
      sectionCode: request.sectionCode,
      topicCodes: request.topicCodes,
      mistakesOf: request.mode === 'mistakes' ? actorId : null,
      difficulties: level ? difficultiesOf(level) : null,
   }
}

function notEnough(available) {
   return new AppError(409, 'TRAINER_NOT_ENOUGH_QUESTIONS', 'Not enough questions for this request', [
      { field: 'available', message: String(available) },
   ])
}

// How many questions the training gets, or the refusal. A standard numeric count is checked after
// picking (the 30/40/30 split can fall short). count "all" is for small choices only: every
// available question when there are fewer than the smallest count. A mistakes training takes
// what there is up to the count ("all" = up to maxQuestions); it needs at least one mistake.
async function plannedCount(deps, client, request, filters) {
   const { config } = deps
   if (request.mode === 'standard' && request.count !== countAll) return request.count
   const available = await deps.repository.countCandidates(config.bankCodePrefix, filters, client)
   if (request.mode === 'mistakes') {
      if (available === 0) {
         throw new AppError(409, 'TRAINER_NO_MISTAKES', 'There are no mistakes to repeat for this choice')
      }
      return Math.min(available, request.count === countAll ? config.maxQuestions : request.count)
   }
   if (available === 0) throw notEnough(0)
   if (available >= Math.min(...config.questionCounts)) {
      throw new AppError(409, 'TRAINER_COUNT_ALL_NOT_ALLOWED', 'count "all" is only for choices smaller than the smallest count', [
         { field: 'available', message: String(available) },
      ])
   }
   return available
}

// Largest-remainder split of count by percentage shares.
function splitByShares(count, shares) {
   const exact = shares.map((share) => (count * share) / 100)
   const parts = exact.map(Math.floor)
   let left = count - parts.reduce((sum, value) => sum + value, 0)
   const order = exact
      .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
      .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
   for (const { index } of order) {
      if (left === 0) break
      parts[index] += 1
      left -= 1
   }
   return parts
}

// Picks target questions. A standard mixed training takes each level's share first and fills any
// shortfall from every trainable question of the request, so a thin level does not block the
// whole test. Mistakes and count "all" take the whole target from the filtered set at once.
// filters.excludeIds (questions a test already holds) are never picked.
async function pickQuestions(deps, client, actorId, request, filters, target) {
   const { config } = deps
   const pick = (difficulties, limit, excludeIds) => deps.repository.pickCandidates(
      config.bankCodePrefix,
      { ...filters, difficulties },
      { userId: actorId, excludeIds: [...(filters.excludeIds ?? []), ...excludeIds], limit },
      client,
   )
   if (request.difficulty !== 'mixed' || request.mode === 'mistakes' || request.count === countAll) {
      return pick(filters.difficulties, target, [])
   }
   const picked = []
   const targets = splitByShares(target, config.mixedShares)
   for (const [index, level] of config.levels.entries()) {
      if (targets[index] === 0) continue
      picked.push(...await pick(difficultiesOf(level), targets[index], picked.map((row) => row.id)))
   }
   if (picked.length < target) {
      picked.push(...await pick(null, target - picked.length, picked.map((row) => row.id)))
   }
   return picked
}

// Mixed picks arrive grouped by level; the test order is shuffled once and then fixed.
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

// Trainings stored before topicCodes existed keep only topicCode.
function storedTopicCodes(stored) {
   if (Array.isArray(stored.topicCodes)) return stored.topicCodes
   return stored.topicCode ? [stored.topicCode] : []
}

function sameRequest(stored, request, subjectId) {
   return stored.subjectId === String(subjectId)
      && (stored.mode ?? 'standard') === request.mode
      && stored.difficulty === request.difficulty
      && stored.count === request.count
      && (request.language === null || stored.language === request.language)
      && (stored.sectionCode ?? null) === request.sectionCode
      && storedTopicCodes(stored).join(',') === request.topicCodes.join(',')
      && (stored.timeLimitMinutes ?? null) === request.timeLimitMinutes
}

// The request part of a training as the history and the overview return it.
function trainingFilters(filters) {
   const topicCodes = storedTopicCodes(filters)
   return {
      mode: filters.mode ?? 'standard',
      difficulty: filters.difficulty,
      language: filters.language ?? null,
      sectionCode: filters.sectionCode ?? null,
      topicCode: topicCodes.length === 1 ? topicCodes[0] : null,
      topicCodes,
      timeLimitMinutes: filters.timeLimitMinutes ?? null,
      sourceAttemptId: filters.sourceAttemptId ?? null,
   }
}

// Answer-sheet cells, chosen by the mock exam's rule: the subject has a cells item in an active
// blueprint and the question's verified key passes the same filter. Those questions get the
// mock exam's digits snapshot and points; acceptsValue keeps { value } clients working.
async function cellsExtensions(deps, subjectCode, questionIds, client) {
   const extensions = new Map()
   const points = new Map()
   const rule = await deps.repository.findCellsRule(subjectCode, client)
   if (!rule) return { extensions, points }
   const rows = await deps.repository.listCellsQuestions(questionIds, rule.max_digits, client)
   for (const row of rows) {
      extensions.set(String(row.id), digitsSnapshot(row.question_type, row.answer_data, rule.max_digits, {
         acceptsValue: true,
      }))
      points.set(String(row.id), rule.points)
   }
   return { extensions, points }
}

async function createTrainerAttemptService(userId, body, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const request = parseCreateBody(body, deps.config)
   if (request.mode === 'unanswered') return createUnansweredTraining(deps, actorId, request)
   const { attemptId, resumed } = await deps.transaction(async (client) => {
      const now = deps.clock()
      await deps.repository.lockTrainerSlot(actorId, client)
      await requireTrainerLearner(deps, actorId, client)
      const subject = await deps.repository.findSubject(request.subject, client)
      if (request.idempotencyKey) {
         const existing = await deps.repository.findTrainerAttemptByKey(actorId, request.idempotencyKey, client)
         if (existing) {
            if (!subject || !sameRequest(existing.generation_filters, request, subject.id)) {
               throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotencyKey was used for another request')
            }
            return { attemptId: existing.id, resumed: true }
         }
      }
      if (!subject) throw new AppError(404, 'SUBJECT_NOT_FOUND', 'Subject was not found')
      const open = await deps.repository.findOpenTrainerAttempt(actorId, client)
      if (open) {
         throw new AppError(409, 'TRAINER_ATTEMPT_IN_PROGRESS', 'Finish the current training first', [
            { field: 'attemptId', message: String(open.id) },
         ])
      }
      const filters = candidateFilters(deps, actorId, subject, request)
      const target = await plannedCount(deps, client, request, filters)
      const picked = await pickQuestions(deps, client, actorId, request, filters, target)
      // Only a standard numeric count must be met in full; the other targets were just counted
      // in this transaction and may only shrink if questions were withdrawn meanwhile.
      const exact = request.mode === 'standard' && request.count !== countAll
      if (exact ? picked.length < target : picked.length === 0) {
         throw notEnough(await deps.repository.countCandidates(deps.config.bankCodePrefix, filters, client))
      }
      const generationFilters = {
         subjectId: String(subject.id),
         subjectCode: subject.code,
         mode: request.mode,
         difficulty: request.difficulty,
         count: request.count,
         language: filters.language,
         sectionCode: request.sectionCode,
         topicCode: request.topicCodes.length === 1 ? request.topicCodes[0] : null,
         topicCodes: request.topicCodes,
         timeLimitMinutes: request.timeLimitMinutes,
         ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
      }
      const questionIds = shuffled(picked).map((row) => String(row.id))
      const id = await storeTraining(deps, client, { actorId, subject, request, generationFilters, questionIds, now })
      return { attemptId: id, resumed: false }
   })
   return { ...await getAttemptService(actorId, attemptId, deps.attempts), resumed }
}

// The generated test, its questions in the given order, the assignment, the first attempt and
// the audit event, all in the caller's transaction. Returns the attempt id.
async function storeTraining(deps, client, { actorId, subject, request, generationFilters, questionIds, now }) {
   const titleLanguage = generationFilters.language ?? subject.primary_language
   const title = subject.titles?.[titleLanguage] ?? subject.titles?.[subject.primary_language] ?? subject.code
   const testId = await deps.repository.createTrainerTest({
      title,
      generationFilters,
      createdBy: actorId,
      durationSeconds: request.timeLimitMinutes === null ? null : request.timeLimitMinutes * 60,
   }, client)
   const cells = await cellsExtensions(deps, subject.code, questionIds, client)
   await deps.repository.addTrainerQuestions(
      testId,
      questionIds,
      client,
      questionIds.map((questionId) => cells.points.get(questionId) ?? null),
   )
   await deps.repository.publishTrainerTest(testId, client)
   const assignmentId = await deps.repository.createTrainerAssignment(testId, actorId, now, client)
   const id = await startAttemptInTransactionService(actorId, assignmentId, client, deps.attempts, {
      snapshotExtensions: cells.extensions,
   })
   await deps.auth.appendAuditEvent({
      actorUserId: actorId,
      subjectUserId: actorId,
      code: 'trainer.attempt_created',
      entityType: 'test_attempt',
      entityId: id,
      metadata: {
         testId,
         subjectId: String(subject.id),
         mode: request.mode,
         difficulty: generationFilters.difficulty,
         count: request.count,
         questionCount: questionIds.length,
         ...(request.mode === 'unanswered' ? { sourceAttemptId: String(request.sourceAttemptId) } : {}),
      },
   }, client)
   return id
}

// ------------------------------------------------------------------ mode unanswered

// The source of a mode "unanswered" training: the student's own finished trainer attempt, its
// subject and its blank questions that are still trainable, in the attempt's order.
async function resolveUnanswered(deps, actorId, sourceAttemptId, db) {
   const source = await deps.repository.findTrainerSourceAttempt(actorId, sourceAttemptId, db)
   if (!source) throw new AppError(404, 'ATTEMPT_NOT_FOUND', 'Attempt was not found')
   if (!finishedStatuses.includes(source.status)) {
      throw new AppError(409, 'ATTEMPT_NOT_FINISHED', 'Finish the attempt first')
   }
   const filters = source.generation_filters
   const subject = await deps.repository.findSubject({ id: filters.subjectId }, db)
   if (!subject) throw new AppError(404, 'SUBJECT_NOT_FOUND', 'Subject was not found')
   const questionIds = await deps.repository.listUnansweredQuestionIds(deps.config.bankCodePrefix, source.id, db)
   return { filters, subject, questionIds }
}

// How many blank questions the training takes: up to the count ("all" = no count), never more
// than maxQuestions.
function unansweredTarget(config, available, count) {
   return Math.min(available, config.maxQuestions, count === countAll ? Infinity : count)
}

function sameUnansweredRequest(stored, request) {
   return stored.mode === 'unanswered'
      && stored.sourceAttemptId === String(request.sourceAttemptId)
      && stored.count === request.count
      && (stored.timeLimitMinutes ?? null) === request.timeLimitMinutes
}

// Mode unanswered: a new trainer test of the questions an attempt left blank, in that attempt's
// order. Subject, language, level, section and topics are copied from the source attempt.
async function createUnansweredTraining(deps, actorId, request) {
   const { attemptId, resumed, unanswered } = await deps.transaction(async (client) => {
      const now = deps.clock()
      await deps.repository.lockTrainerSlot(actorId, client)
      await requireTrainerLearner(deps, actorId, client)
      if (request.idempotencyKey) {
         const existing = await deps.repository.findTrainerAttemptByKey(actorId, request.idempotencyKey, client)
         if (existing) {
            if (!sameUnansweredRequest(existing.generation_filters, request)) {
               throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotencyKey was used for another request')
            }
            return {
               attemptId: existing.id,
               resumed: true,
               unanswered: { available: existing.generation_filters.available, questionCount: existing.question_count },
            }
         }
      }
      const { filters, subject, questionIds: blank } = await resolveUnanswered(deps, actorId, request.sourceAttemptId, client)
      const open = await deps.repository.findOpenTrainerAttempt(actorId, client)
      if (open) {
         throw new AppError(409, 'TRAINER_ATTEMPT_IN_PROGRESS', 'Finish the current training first', [
            { field: 'attemptId', message: String(open.id) },
         ])
      }
      if (blank.length === 0) {
         throw new AppError(409, 'TRAINER_NO_UNANSWERED', 'This attempt has no unanswered questions')
      }
      const questionIds = blank.slice(0, unansweredTarget(deps.config, blank.length, request.count))
      const topicCodes = storedTopicCodes(filters)
      const generationFilters = {
         subjectId: String(subject.id),
         subjectCode: subject.code,
         mode: 'unanswered',
         sourceAttemptId: String(request.sourceAttemptId),
         difficulty: filters.difficulty ?? 'mixed',
         count: request.count,
         language: filters.language ?? null,
         sectionCode: filters.sectionCode ?? null,
         topicCode: topicCodes.length === 1 ? topicCodes[0] : null,
         topicCodes,
         timeLimitMinutes: request.timeLimitMinutes,
         available: blank.length,
         ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
      }
      const id = await storeTraining(deps, client, { actorId, subject, request, generationFilters, questionIds, now })
      return { attemptId: id, resumed: false, unanswered: { available: blank.length, questionCount: questionIds.length } }
   })
   return {
      ...await getAttemptService(actorId, attemptId, deps.attempts),
      resumed,
      unanswered: { sourceAttemptId: String(request.sourceAttemptId), ...unanswered },
   }
}

async function getUnansweredAvailability(deps, actorId, request) {
   const { filters, subject, questionIds } = await resolveUnanswered(deps, actorId, request.sourceAttemptId)
   const available = questionIds.length
   return {
      mode: 'unanswered',
      sourceAttemptId: String(request.sourceAttemptId),
      subjectId: subject.id,
      language: filters.language ?? null,
      available,
      questionCount: unansweredTarget(deps.config, available, countAll),
      questionCounts: available > 0 ? [...deps.config.questionCounts] : [],
      allowsAll: available > 0,
   }
}

// ------------------------------------------------------------------ availability

// Exact number of questions one choice can draw right now (the union of several topics included,
// which catalog counts cannot give), and the counts the create request would accept.
async function getTrainerAvailabilityService(userId, query = {}, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const request = parseAvailabilityQuery(query, deps.config)
   await requireTrainerLearner(deps, actorId)
   if (request.mode === 'unanswered') return getUnansweredAvailability(deps, actorId, request)
   const subject = await deps.repository.findSubject(request.subject)
   if (!subject) throw new AppError(404, 'SUBJECT_NOT_FOUND', 'Subject was not found')
   const filters = candidateFilters(deps, actorId, subject, request)
   const available = await deps.repository.countCandidates(deps.config.bankCodePrefix, filters)
   const { questionCounts } = deps.config
   const mistakes = request.mode === 'mistakes'
   return {
      mode: request.mode,
      subjectId: subject.id,
      language: filters.language,
      available,
      // Mistakes take what there is, so every count works once one mistake exists.
      questionCounts: mistakes
         ? (available > 0 ? [...questionCounts] : [])
         : questionCounts.filter((count) => count <= available),
      allowsAll: mistakes ? available > 0 : available > 0 && available < Math.min(...questionCounts),
   }
}

// ------------------------------------------------------------------ test constructor (M10 tail)

// The selection fields the test constructor uses: the trainer's standard selection (no mode, no
// time limit, no idempotency key) without anybody's mistakes.
const constructorSelectionFields = ['subject', 'difficulty', 'language', 'sectionCode', 'topicCode', 'topicCodes']

function parseConstructorQuery(query, config) {
   validateBody(query, constructorSelectionFields)
   return parseAvailabilityQuery(query, config)
}

async function findSelectionSubject(deps, request, db) {
   const subject = await deps.repository.findSubject(request.subject, db)
   if (!subject) throw new AppError(404, 'SUBJECT_NOT_FOUND', 'Subject was not found')
   return subject
}

// GET /admin/trainer/availability (tests.manage, checked by the route): the learner availability
// in standard mode. excludeIds: the questions a draft already holds (the route's testId), so the
// number is what the generator could still add.
async function getStaffTrainerAvailabilityService(userId, query = {}, { excludeIds = [] } = {}, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const request = parseConstructorQuery(query, deps.config)
   const subject = await findSelectionSubject(deps, request)
   const filters = { ...candidateFilters(deps, actorId, subject, request), excludeIds }
   const available = await deps.repository.countCandidates(deps.config.bankCodePrefix, filters)
   const { questionCounts } = deps.config
   return {
      mode: 'standard',
      subjectId: subject.id,
      language: filters.language,
      available,
      questionCounts: questionCounts.filter((count) => count <= available),
      allowsAll: available > 0 && available < Math.min(...questionCounts),
   }
}

/**
 * The question generator of a draft test (POST /admin/tests/:testId/questions/generate), inside
 * the caller's transaction: the trainer's standard selection over trainable questions the test
 * does not hold yet. Same filters, 30/40/30 split, count rules ("all" only below the smallest
 * count) and errors as a training. Returns the questions in random order and the parameters to
 * keep in generation_filters.
 */
async function drawTrainableQuestionsService(client, { actorId, body, excludeIds }, overrides) {
   const deps = dependencies(overrides)
   validateBody(body, [...constructorSelectionFields, 'count'])
   const request = { ...parseSelection({ ...body, mode: undefined }, deps.config), count: parseCount(body.count, deps.config) }
   const subject = await findSelectionSubject(deps, request, client)
   const filters = { ...candidateFilters(deps, actorId, subject, request), excludeIds }
   const target = await plannedCount(deps, client, request, filters)
   const picked = await pickQuestions(deps, client, actorId, request, filters, target)
   const exact = request.count !== countAll
   if (exact ? picked.length < target : picked.length === 0) {
      throw notEnough(await deps.repository.countCandidates(deps.config.bankCodePrefix, filters, client))
   }
   return {
      questionIds: shuffled(picked).map((row) => String(row.id)),
      parameters: {
         subjectId: String(subject.id),
         subjectCode: subject.code,
         difficulty: request.difficulty,
         count: request.count,
         language: filters.language,
         sectionCode: request.sectionCode,
         topicCodes: request.topicCodes,
      },
   }
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
   let subjectId = null
   if (query.subjectId !== undefined) {
      try {
         subjectId = normalizeInternalId(query.subjectId)
      } catch {
         throw validationError('subjectId')
      }
   }
   return { limit, offset: integer(query.offset, 'offset', 0, 100000), subjectId }
}

function safeHistoryAttempt(row) {
   const finished = row.status === 'graded' || row.status === 'expired'
   const filters = row.generation_filters
   return {
      attemptId: row.id,
      status: row.status,
      subjectId: filters.subjectId,
      subjectCode: filters.subjectCode,
      ...trainingFilters(filters),
      questionCount: row.question_count,
      startedAt: iso(row.started_at),
      submittedAt: iso(row.submitted_at),
      score: finished ? row.score : null,
      maxScore: finished ? row.max_score : null,
      percent: finished ? scorePercent(row.score, row.max_score) : null,
   }
}

async function listTrainerHistoryService(userId, query = {}, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const paging = parsePaging(query)
   await requireTrainerLearner(deps, actorId)
   const [rows, stats] = await Promise.all([
      deps.repository.listTrainerAttempts(actorId, paging),
      deps.repository.listTrainerStats(actorId),
   ])
   return {
      attempts: rows.slice(0, paging.limit).map(safeHistoryAttempt),
      pagination: { limit: paging.limit, offset: paging.offset, hasMore: rows.length > paging.limit },
      stats: stats.map((row) => ({
         subjectId: row.subject_id,
         attempts: row.attempts,
         averagePercent: row.average_percent === null ? null : Number(row.average_percent),
         lastSubmittedAt: iso(row.last_submitted_at),
      })),
   }
}

// ------------------------------------------------------------------ overview (/nct page)

function roundPercent(value) {
   return Math.round(value * 100) / 100
}

// Readiness of a subject: points over questions of its last readinessWindow finished trainings
// (a cells question weighs its blueprint points, every other question 1 point), computed by
// subjectReadiness in utils/learning-metrics.js. Overall readiness: the mean of the subject
// values, every trained subject counting equally.

// Subject readiness and the overall figure from the last readinessWindow finished trainings of
// each subject. Shared by the /nct overview and the student home page.
async function computeReadiness(deps, actorId, { allSubjects = false } = {}) {
   const windowRows = await deps.repository.listRecentFinishedBySubject(actorId, deps.config.readinessWindow)
   const bySubject = new Map()
   for (const row of windowRows) {
      bySubject.set(row.subject_id, [...(bySubject.get(row.subject_id) ?? []), row])
   }
   // The home page lists every trainable subject, also those without trainings (readinessPercent
   // null); a subject with trainings stays listed even if its questions were withdrawn since.
   const trainable = allSubjects ? await deps.repository.listTrainableSubjectIds(deps.config.bankCodePrefix) : []
   const subjectRows = await deps.repository.listSubjects([...new Set([...bySubject.keys(), ...trainable])])
   if (allSubjects) {
      const label = (subject) => subject.titles[subject.primary_language] ?? subject.code
      subjectRows.sort((left, right) => label(left).localeCompare(label(right), left.primary_language)
         || (BigInt(left.id) < BigInt(right.id) ? -1 : 1))
   }
   const subjects = subjectRows.map((subject) => {
      const rows = bySubject.get(subject.id)
      if (!rows) {
         return {
            subjectId: subject.id,
            subjectCode: subject.code,
            titles: subject.titles,
            color: subject.color,
            readinessPercent: null,
            trainings: 0,
            lastSubmittedAt: null,
         }
      }
      return {
         subjectId: subject.id,
         subjectCode: subject.code,
         titles: subject.titles,
         color: subject.color,
         readinessPercent: subjectReadiness(rows),
         trainings: rows[0].total,
         lastSubmittedAt: iso(rows[0].submitted_at),
      }
   })
   const completedTrainings = subjects.reduce((sum, subject) => sum + subject.trainings, 0)
   // Subjects without trainings do not enter the mean.
   const measured = subjects.filter((subject) => subject.readinessPercent !== null)
   return {
      completedTrainings,
      readinessPercent: measured.length
         ? roundPercent(measured.reduce((sum, subject) => sum + subject.readinessPercent, 0) / measured.length)
         : null,
      subjects,
   }
}

// Own data only, no trainer permission check: the home page shows an empty block for accounts
// that never trained (teachers, new students).
async function getReadinessSummaryService(userId, overrides) {
   const deps = dependencies(overrides)
   const readiness = await computeReadiness(deps, parseUserId(userId), { allSubjects: true })
   return { ...readiness, readinessWindow: deps.config.readinessWindow }
}

async function getTrainerOverviewService(userId, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   await requireTrainerLearner(deps, actorId)
   const { config } = deps
   const [readiness, topicRows, recentRows, mistakeRows] = await Promise.all([
      computeReadiness(deps, actorId),
      deps.repository.listTopicResults(actorId, config.weakTopicMinAnswers, config.weakTopicsLimit),
      deps.repository.listRecentFinished(actorId, config.recentResultsLimit),
      deps.repository.listMistakeCounts(actorId, config.bankCodePrefix),
   ])
   const { completedTrainings, subjects } = readiness
   return {
      empty: completedTrainings === 0,
      readinessPercent: readiness.readinessPercent,
      completedTrainings,
      readinessWindow: config.readinessWindow,
      subjects,
      weakTopics: topicRows.map((row) => ({
         subjectId: row.subject_id,
         subjectCode: row.subject_code,
         topicCode: row.code,
         titles: row.titles,
         answered: row.answered,
         correct: row.correct,
         correctPercent: roundPercent((row.correct * 100) / row.answered),
      })),
      recentResults: recentRows.map((row) => ({
         attemptId: row.id,
         subjectId: row.generation_filters.subjectId,
         subjectCode: row.generation_filters.subjectCode,
         ...trainingFilters(row.generation_filters),
         questionCount: row.question_count,
         percent: scorePercent(row.score, row.max_score),
         submittedAt: iso(row.submitted_at),
      })),
      mistakes: mistakeSummary(mistakeRows),
   }
}

// Open mistakes for the /nct page: per subject, with its sections and topics. Titles come from
// the catalog. A question in two topics counts in both topics but once in the subject.
function mistakeSummary(rows) {
   const subjects = new Map()
   for (const row of rows) {
      const key = String(row.subject_id)
      const entry = subjects.get(key) ?? { subjectId: row.subject_id, total: 0, sections: [], topics: [] }
      if (row.level === 3) entry.total = row.total
      else if (row.level === 1 && row.section_code !== null) entry.sections.push({ code: row.section_code, total: row.total })
      else if (row.level === 0 && row.topic_code !== null) {
         entry.topics.push({ code: row.topic_code, sectionCode: row.section_code, total: row.total })
      }
      subjects.set(key, entry)
   }
   const list = [...subjects.values()].filter((entry) => entry.total > 0)
   return { total: list.reduce((sum, entry) => sum + entry.total, 0), subjects: list }
}

export {
   createTrainerAttemptService,
   drawTrainableQuestionsService,
   getReadinessSummaryService,
   getStaffTrainerAvailabilityService,
   getStaffTrainerCatalogService,
   getTrainerAvailabilityService,
   getTrainerOverviewService,
   getTrainerCatalogService,
   listTrainerHistoryService,
   splitByShares,
}
