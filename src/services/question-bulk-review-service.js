import { randomUUID } from 'node:crypto'

import * as authRepository from '../repositories/auth-repository.js'
import * as authorizationRepository from '../repositories/authorization-repository.js'
import * as questionBankRepository from '../repositories/question-bank-repository.js'
import * as questionImportRepository from '../repositories/question-import-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import AppError from '../utils/app-error.js'
import { normalizePhone } from '../utils/auth-input.js'
import { normalizeInternalId } from '../utils/internal-id.js'
import { validationError } from './course-service.js'
import {
   answerKeyVerificationBlocker,
   publishQuestionService,
   questionPublicationBlocker,
   verifyAnswerKeyService,
} from './question-bank-service.js'

// Bulk reviewer actions for one bank, run from the CLI after an answer-key import:
// verify proposed keys, then publish drafts that pass the publication check. Every write goes
// through verifyAnswerKeyService / publishQuestionService, the same services as the admin
// buttons, inside one transaction per batch. The report carries ids and codes only.

const bankCodePattern = /^[a-z0-9][a-z0-9_-]{0,99}$/
const maxBatchSize = 100
const verifiableSources = ['official_key', 'expert_review']
const keySources = ['official_key', 'expert_review', 'ai_inference']
const verifyCodes = [
   'VERIFIED',
   'SKIPPED_EXCLUDED',
   'SKIPPED_NOT_DRAFT',
   'SKIPPED_NOT_PROPOSED',
   'SKIPPED_SOURCE_FILTERED',
   'SKIPPED_SOURCE_NOT_VERIFIABLE',
   'FAILED',
]
const publishCodes = ['PUBLISHED', 'SKIPPED_NOT_DRAFT', 'SKIPPED_KEY_NOT_VERIFIED', 'NOT_PUBLISHABLE', 'FAILED']

function dependencies(overrides = {}) {
   return {
      questions: overrides.questions || questionBankRepository,
      imports: overrides.imports || questionImportRepository,
      authorization: overrides.authorization || authorizationRepository,
      auth: overrides.auth || authRepository,
      transaction: overrides.transaction || withTransaction,
      verifyAnswerKey: overrides.verifyAnswerKey || verifyAnswerKeyService,
      publishQuestion: overrides.publishQuestion || publishQuestionService,
      newRunId: overrides.newRunId || randomUUID,
      log: overrides.log || (() => {}),
   }
}

// --- Options ------------------------------------------------------------------------------

function parseCommon(options = {}) {
   if (typeof options.bankCode !== 'string' || !bankCodePattern.test(options.bankCode)) throw validationError('bank')
   const batchSize = options.batchSize ?? maxBatchSize
   if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > maxBatchSize) {
      throw validationError('batchSize', `batchSize must be 1-${maxBatchSize}`)
   }
   return { bankCode: options.bankCode, batchSize, dryRun: options.dryRun === true }
}

function parseVerifyOptions(options = {}) {
   const common = parseCommon(options)
   let onlySource = null
   if (options.onlySource !== undefined && options.onlySource !== null) {
      if (!keySources.includes(options.onlySource)) throw validationError('onlySource')
      onlySource = options.onlySource
   }
   const exclude = options.exclude ?? []
   if (!Array.isArray(exclude) || exclude.some((value) => typeof value !== 'string' || !value.trim())) {
      throw validationError('exclude', 'exclude must be a list of externalId strings')
   }
   return { ...common, onlySource, exclude: new Set(exclude.map((value) => value.trim())) }
}

// --- Actor and bank -------------------------------------------------------------------------

// Same requirements as the admin buttons: an active account holding questions.review.
async function loadReviewer(deps, actorIdValue) {
   const actorId = normalizeInternalId(actorIdValue)
   const actor = await deps.imports.findActorById(actorId)
   if (!actor) throw new AppError(403, 'BULK_ACTOR_FORBIDDEN', 'Actor does not exist')
   if (actor.status !== 'active') throw new AppError(403, 'BULK_ACTOR_INACTIVE', 'Actor account is not active')
   if (!await deps.authorization.hasPermission(actorId, 'questions.review')) {
      throw new AppError(403, 'BULK_ACTOR_FORBIDDEN', 'Actor needs the questions.review permission')
   }
   return actorId
}

async function resolveReviewerService(phone, overrides) {
   const deps = dependencies(overrides)
   const actor = await deps.imports.findActorByPhone(normalizePhone(phone))
   if (!actor) throw new AppError(403, 'BULK_ACTOR_FORBIDDEN', 'No account uses this phone number')
   return loadReviewer(deps, actor.id)
}

async function loadBank(deps, bankCode) {
   const bank = await deps.imports.findBankByCode(bankCode)
   if (!bank) throw new AppError(404, 'QUESTION_BANK_NOT_FOUND', `Bank ${bankCode} does not exist`)
   return bank
}

// --- Classification (pure) ------------------------------------------------------------------

function classifyVerify(question, parts, settings) {
   if (question.external_id && settings.exclude.has(question.external_id)) return { code: 'SKIPPED_EXCLUDED' }
   if (question.status !== 'draft') return { code: 'SKIPPED_NOT_DRAFT' }
   const key = parts.answerKey
   if (!key || key.status !== 'proposed') return { code: 'SKIPPED_NOT_PROPOSED' }
   if (settings.onlySource && key.source !== settings.onlySource) return { code: 'SKIPPED_SOURCE_FILTERED' }
   // An AI proposal needs a reviewer to choose the verification source; bulk never relabels it.
   if (!verifiableSources.includes(key.source)) return { code: 'SKIPPED_SOURCE_NOT_VERIFIABLE' }
   const reason = answerKeyVerificationBlocker(question, parts)
   if (reason) return { code: 'FAILED', reason }
   return { code: 'VERIFIED', keySource: key.source }
}

function classifyPublishState(question, parts) {
   if (question.status !== 'draft') return { code: 'SKIPPED_NOT_DRAFT' }
   if (parts.answerKey?.status !== 'verified') return { code: 'SKIPPED_KEY_NOT_VERIFIED' }
   return null
}

// --- Report ----------------------------------------------------------------------------------

function emptyCounters(codes, batchSize) {
   return {
      questions: 0,
      outcomes: Object.fromEntries(codes.map((code) => [code, 0])),
      reasons: {},
      notAttempted: 0,
      batches: { size: batchSize, committed: 0, failed: 0 },
   }
}

function count(counters, entry) {
   counters.outcomes[entry.outcome] += 1
   if (entry.reason) counters.reasons[entry.reason] = (counters.reasons[entry.reason] || 0) + 1
}

function entryOf(question, outcome) {
   return {
      externalId: question.external_id ?? null,
      questionId: question.id,
      outcome: outcome.code,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
   }
}

function reasonOf(error) {
   if (!(error instanceof AppError)) return null
   return error.code === 'QUESTION_NOT_PUBLISHABLE' ? error.details?.[0]?.message || error.code : error.code
}

// --- Shared runner ---------------------------------------------------------------------------

async function readState(deps, questionId, client) {
   const question = client
      ? await deps.questions.lockQuestion(questionId, client)
      : await deps.questions.findQuestion(questionId)
   if (!question) return null
   return { question, parts: await deps.questions.findQuestionParts(questionId, client) }
}

// `plan` classifies one question (dry run and real run alike); `apply` writes one question that
// plan accepted. An AppError from apply is a per-question FAILED / NOT_PUBLISHABLE; the
// services throw it before any write, so the batch transaction stays usable. Any other error
// rolls the batch back and stops the run.
async function execute(deps, kind, run, plan, apply) {
   const { actorId, bank, settings, codes, runId } = run
   const counters = emptyCounters(codes, settings.batchSize)
   const states = await deps.imports.listBankQuestionStates(bank.id)
   counters.questions = states.length
   const entries = []
   const errors = []
   const base = { mode: settings.dryRun ? 'dry_run' : kind, runId, bankCode: bank.code }

   if (settings.dryRun) {
      for (const state of states) {
         const current = await readState(deps, state.id)
         if (!current) continue
         const entry = entryOf(current.question, await plan(current.question, current.parts, null))
         count(counters, entry)
         entries.push(entry)
      }
      return { ...base, status: 'completed', counters, entries, errors }
   }

   let started = false
   let failed = false
   for (let start = 0; start < states.length; start += settings.batchSize) {
      const batch = states.slice(start, start + settings.batchSize)
      if (failed) {
         counters.notAttempted += batch.length
         continue
      }
      const local = []
      let current = null
      let startedHere = false
      try {
         await deps.transaction(async (client) => {
            for (const state of batch) {
               current = state
               const locked = await readState(deps, state.id, client)
               if (!locked) continue
               let outcome = await plan(locked.question, locked.parts, client)
               if (outcome.write) {
                  if (!started) {
                     // Written once, and only when something changes: a repeated run that has
                     // nothing left to do leaves no audit rows.
                     await deps.auth.appendAuditEvent({
                        actorUserId: actorId,
                        subjectUserId: null,
                        code: `question_bulk_${kind}.started`,
                        entityType: 'question_bank',
                        entityId: bank.id,
                        metadata: { runId, origin: 'bulk' },
                     }, client)
                     started = true
                     startedHere = true
                  }
                  try {
                     await apply(locked.question, outcome, client)
                  } catch (error) {
                     const reason = reasonOf(error)
                     if (!reason) throw error
                     outcome = { code: outcome.failCode(error), reason }
                  }
               }
               local.push(entryOf(locked.question, outcome))
            }
         })
         for (const entry of local) count(counters, entry)
         entries.push(...local)
         counters.batches.committed += 1
      } catch (error) {
         failed = true
         counters.batches.failed += 1
         for (const state of batch) {
            const entry = entryOf(state, { code: 'FAILED', reason: 'BATCH_ROLLED_BACK' })
            count(counters, entry)
            entries.push(entry)
         }
         errors.push({
            code: error instanceof AppError ? error.code : 'BULK_BATCH_FAILED',
            questionId: current?.id ?? null,
            externalId: current?.external_id ?? null,
            message: error instanceof AppError ? error.message : `batch rolled back: database error ${error.code || 'unknown'}`,
         })
         deps.log(`bulk ${kind} batch failed`, { runId, code: errors.at(-1).code })
         // The start event rolled back with this batch.
         if (startedHere) started = false
      }
   }
   const status = failed ? 'failed' : 'completed'
   if (started) {
      await deps.transaction(async (client) => {
         await deps.auth.appendAuditEvent({
            actorUserId: actorId,
            subjectUserId: null,
            code: `question_bulk_${kind}.${status}`,
            entityType: 'question_bank',
            entityId: bank.id,
            metadata: { runId, origin: 'bulk', outcomes: counters.outcomes, reasons: counters.reasons },
         }, client)
      })
   }
   return { ...base, status, counters, entries, errors }
}

// --- Verify ----------------------------------------------------------------------------------

async function bulkVerifyAnswerKeysService(actorIdValue, options = {}, overrides) {
   const deps = dependencies(overrides)
   const actorId = await loadReviewer(deps, actorIdValue)
   const settings = parseVerifyOptions(options)
   const bank = await loadBank(deps, settings.bankCode)
   const runId = settings.dryRun ? null : deps.newRunId()

   const plan = async (question, parts, client) => {
      const outcome = classifyVerify(question, parts, settings)
      if (outcome.code !== 'VERIFIED' || !client) return outcome
      return { ...outcome, write: true, failCode: () => 'FAILED' }
   }
   const apply = async (question, outcome, client) => {
      await deps.verifyAnswerKey(actorId, question.id, { source: outcome.keySource }, {
         transaction: (work) => work(client),
      }, {
         auditMetadata: { origin: 'bulk', runId, keySource: outcome.keySource },
      })
   }
   const run = { actorId, bank, settings, codes: verifyCodes, runId }
   const result = await execute(deps, 'verify', run, plan, apply)
   const known = new Set((await deps.imports.listBankQuestionStates(bank.id)).map((state) => state.external_id))
   const excludeNotFound = [...settings.exclude].filter((externalId) => !known.has(externalId))
   return {
      ...result,
      onlySource: settings.onlySource,
      exclude: { requested: settings.exclude.size, notFoundInBank: excludeNotFound },
   }
}

// --- Publish ---------------------------------------------------------------------------------

async function bulkPublishQuestionsService(actorIdValue, options = {}, overrides) {
   const deps = dependencies(overrides)
   const actorId = await loadReviewer(deps, actorIdValue)
   const settings = parseCommon(options)
   const bank = await loadBank(deps, settings.bankCode)
   const runId = settings.dryRun ? null : deps.newRunId()

   const plan = async (question, parts, client) => {
      const skipped = classifyPublishState(question, parts)
      if (skipped) return skipped
      const reason = await questionPublicationBlocker(deps.questions, client ?? undefined, actorId, question, parts)
      if (reason) return { code: 'NOT_PUBLISHABLE', reason }
      if (!client) return { code: 'PUBLISHED' }
      return {
         code: 'PUBLISHED',
         write: true,
         failCode: (error) => (error.code === 'QUESTION_NOT_PUBLISHABLE' ? 'NOT_PUBLISHABLE' : 'FAILED'),
      }
   }
   const apply = async (question, outcome, client) => {
      await deps.publishQuestion(actorId, question.id, { transaction: (work) => work(client) }, {
         auditMetadata: { origin: 'bulk', runId },
      })
   }
   return execute(deps, 'publish', { actorId, bank, settings, codes: publishCodes, runId }, plan, apply)
}

export { classifyPublishState, classifyVerify, parseVerifyOptions }

export { bulkPublishQuestionsService, bulkVerifyAnswerKeysService, resolveReviewerService }
