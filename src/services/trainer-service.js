import { randomInt } from 'node:crypto'

import env from '../configs/env.js'
import * as authRepository from '../repositories/auth-repository.js'
import * as trainerRepository from '../repositories/trainer-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import AppError from '../utils/app-error.js'
import { scorePercent } from '../utils/attempt-grading.js'
import { normalizeInternalId } from '../utils/internal-id.js'
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

function trainerOptions(config) {
   return {
      questionCounts: config.questionCounts,
      difficulties: [...config.levels.map((level) => level.name), 'mixed'],
      levels: config.levels.map((level) => ({ name: level.name, minDifficulty: level.min, maxDifficulty: level.max })),
      mixedShares: Object.fromEntries(config.levels.map((level, index) => [level.name, config.mixedShares[index]])),
   }
}

// ------------------------------------------------------------------ catalog

async function getTrainerCatalogService(userId, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   await requireTrainerLearner(deps, actorId)
   const { config } = deps
   const counts = await deps.repository.listTrainableCounts(config.bankCodePrefix)
   const subjectIds = [...new Set(counts.map((row) => row.subject_id))]
   const [subjects, sections, topics] = await Promise.all([
      deps.repository.listSubjects(subjectIds),
      deps.repository.listTrainableSections(config.bankCodePrefix),
      deps.repository.listTrainableTopics(config.bankCodePrefix),
   ])
   return {
      options: trainerOptions(config),
      subjects: subjects.map((subject) => {
         const byLanguage = new Map()
         for (const row of counts.filter((entry) => entry.subject_id === subject.id)) {
            const entry = byLanguage.get(row.language_code) ?? {
               language: row.language_code,
               total: 0,
               difficulties: Object.fromEntries(config.levels.map((level) => [level.name, 0])),
            }
            const level = levelOf(config, row.difficulty)
            // Questions without a difficulty (or outside every level) count only for mixed.
            entry.total += row.total
            if (level) entry.difficulties[level] += row.total
            byLanguage.set(row.language_code, entry)
         }
         return {
            id: subject.id,
            code: subject.code,
            color: subject.color,
            primaryLanguage: subject.primary_language,
            titles: subject.titles,
            languages: [...byLanguage.values()],
            sections: sections
               .filter((section) => section.subject_id === subject.id)
               .map((section) => ({ code: section.code, titles: section.titles, total: section.total })),
            topics: topics
               .filter((topic) => topic.subject_id === subject.id)
               .map((topic) => ({
                  code: topic.code,
                  sectionCode: topic.section_code,
                  titles: topic.titles,
                  total: topic.total,
               })),
         }
      }),
   }
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

function parseCreateBody(body, config) {
   validateBody(body, ['subject', 'difficulty', 'count', 'language', 'sectionCode', 'topicCode', 'idempotencyKey'])
   const difficulties = trainerOptions(config).difficulties
   if (!difficulties.includes(body.difficulty)) {
      throw validationError('difficulty', `difficulty must be one of ${difficulties.join(', ')}`)
   }
   if (!config.questionCounts.includes(body.count)) {
      throw validationError('count', `count must be one of ${config.questionCounts.join(', ')}`)
   }
   if (body.language !== undefined && !languages.includes(body.language)) throw validationError('language')
   if (body.idempotencyKey !== undefined
      && (typeof body.idempotencyKey !== 'string' || !idempotencyKeyPattern.test(body.idempotencyKey))) {
      throw validationError('idempotencyKey', 'idempotencyKey must be 8-100 characters of A-Z a-z 0-9 . _ : -')
   }
   return {
      subject: parseSubject(body.subject),
      difficulty: body.difficulty,
      count: body.count,
      language: body.language ?? null,
      sectionCode: parseOptionalCode(body.sectionCode, 'sectionCode'),
      topicCode: parseOptionalCode(body.topicCode, 'topicCode'),
      idempotencyKey: body.idempotencyKey ?? null,
   }
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

// Picks count questions. Mixed takes each level's share first and fills any shortfall from
// every trainable question of the request, so a thin level does not block the whole test.
async function pickQuestions(deps, client, actorId, request, filters) {
   const { config } = deps
   const pick = (difficulties, limit, excludeIds) => deps.repository.pickCandidates(
      config.bankCodePrefix,
      { ...filters, difficulties },
      { userId: actorId, excludeIds, limit },
      client,
   )
   if (request.difficulty !== 'mixed') {
      const level = config.levels.find((entry) => entry.name === request.difficulty)
      return pick(difficultiesOf(level), request.count, [])
   }
   const picked = []
   const targets = splitByShares(request.count, config.mixedShares)
   for (const [index, level] of config.levels.entries()) {
      if (targets[index] === 0) continue
      picked.push(...await pick(difficultiesOf(level), targets[index], picked.map((row) => row.id)))
   }
   if (picked.length < request.count) {
      picked.push(...await pick(null, request.count - picked.length, picked.map((row) => row.id)))
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

function sameRequest(stored, request, subjectId) {
   return stored.subjectId === String(subjectId)
      && stored.difficulty === request.difficulty
      && stored.count === request.count
      && (request.language === null || stored.language === request.language)
      && stored.sectionCode === request.sectionCode
      && stored.topicCode === request.topicCode
}

async function createTrainerAttemptService(userId, body, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   const request = parseCreateBody(body, deps.config)
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
      const filters = {
         subjectId: subject.id,
         language: request.language ?? subject.primary_language,
         sectionCode: request.sectionCode,
         topicCode: request.topicCode,
      }
      const picked = await pickQuestions(deps, client, actorId, request, filters)
      if (picked.length < request.count) {
         const level = deps.config.levels.find((entry) => entry.name === request.difficulty)
         const available = await deps.repository.countCandidates(
            deps.config.bankCodePrefix,
            { ...filters, difficulties: level ? difficultiesOf(level) : null },
            client,
         )
         throw new AppError(409, 'TRAINER_NOT_ENOUGH_QUESTIONS', 'Not enough questions for this request', [
            { field: 'available', message: String(available) },
         ])
      }
      const generationFilters = {
         subjectId: String(subject.id),
         subjectCode: subject.code,
         difficulty: request.difficulty,
         count: request.count,
         language: filters.language,
         sectionCode: request.sectionCode,
         topicCode: request.topicCode,
         ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
      }
      const title = subject.titles?.[filters.language] ?? subject.titles?.[subject.primary_language] ?? subject.code
      const testId = await deps.repository.createTrainerTest({
         title,
         generationFilters,
         createdBy: actorId,
      }, client)
      await deps.repository.addTrainerQuestions(testId, shuffled(picked).map((row) => row.id), client)
      await deps.repository.publishTrainerTest(testId, client)
      const assignmentId = await deps.repository.createTrainerAssignment(testId, actorId, now, client)
      const id = await startAttemptInTransactionService(actorId, assignmentId, client, deps.attempts)
      await deps.auth.appendAuditEvent({
         actorUserId: actorId,
         subjectUserId: actorId,
         code: 'trainer.attempt_created',
         entityType: 'test_attempt',
         entityId: id,
         metadata: { testId, subjectId: String(subject.id), difficulty: request.difficulty, count: request.count },
      }, client)
      return { attemptId: id, resumed: false }
   })
   return { ...await getAttemptService(actorId, attemptId, deps.attempts), resumed }
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
      difficulty: filters.difficulty,
      language: filters.language,
      sectionCode: filters.sectionCode,
      topicCode: filters.topicCode,
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
// (each question is 1 point, so this is the share of correct answers). Overall readiness: the
// mean of the subject values, every trained subject counting equally.
function subjectReadiness(rows) {
   const score = rows.reduce((sum, row) => sum + Number(row.score), 0)
   const maxScore = rows.reduce((sum, row) => sum + Number(row.max_score), 0)
   return roundPercent((score * 100) / maxScore)
}

async function getTrainerOverviewService(userId, overrides) {
   const deps = dependencies(overrides)
   const actorId = parseUserId(userId)
   await requireTrainerLearner(deps, actorId)
   const { config } = deps
   const [windowRows, topicRows, recentRows] = await Promise.all([
      deps.repository.listRecentFinishedBySubject(actorId, config.readinessWindow),
      deps.repository.listTopicResults(actorId, config.weakTopicMinAnswers, config.weakTopicsLimit),
      deps.repository.listRecentFinished(actorId, config.recentResultsLimit),
   ])
   const bySubject = new Map()
   for (const row of windowRows) {
      bySubject.set(row.subject_id, [...(bySubject.get(row.subject_id) ?? []), row])
   }
   const subjectRows = await deps.repository.listSubjects([...bySubject.keys()])
   const subjects = subjectRows.map((subject) => {
      const rows = bySubject.get(subject.id)
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
   return {
      empty: completedTrainings === 0,
      readinessPercent: subjects.length
         ? roundPercent(subjects.reduce((sum, subject) => sum + subject.readinessPercent, 0) / subjects.length)
         : null,
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
         difficulty: row.generation_filters.difficulty,
         sectionCode: row.generation_filters.sectionCode,
         topicCode: row.generation_filters.topicCode,
         questionCount: row.question_count,
         percent: scorePercent(row.score, row.max_score),
         submittedAt: iso(row.submitted_at),
      })),
   }
}

export {
   createTrainerAttemptService,
   getTrainerOverviewService,
   getTrainerCatalogService,
   listTrainerHistoryService,
   splitByShares,
}
