import * as authRepository from '../repositories/auth-repository.js'
import * as questionBankRepository from '../repositories/question-bank-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import AppError from '../utils/app-error.js'
import { normalizeInternalId } from '../utils/internal-id.js'
import {
   choiceTypes,
   isValidAnswerData,
   parseAnswerData,
   parseContent,
   parseInteractionSettings,
   parseMatching,
   parseOptions,
   parseSourceMetadata,
   questionTypes,
} from '../utils/question-content.js'
import { parsePagination, validateBody, validationError } from './course-service.js'

const languages = ['tg', 'ru', 'en']
const bankCodePattern = /^[a-z0-9][a-z0-9_-]{0,99}$/
const questionStatuses = ['draft', 'published', 'archived']
const keyStatuses = ['unknown', 'proposed', 'verified']
const difficultySources = ['ai', 'expert', 'official']
const proposalSources = ['official_key', 'expert_review', 'ai_inference']
const verificationSources = ['official_key', 'expert_review']
const questionFields = [
   'externalId',
   'questionType',
   'languageCode',
   'difficulty',
   'difficultySource',
   'content',
   'interactionSettings',
   'sourceMetadata',
   'options',
   'matching',
   'topicIds',
]

function dependencies(overrides = {}) {
   return {
      repository: overrides.repository || questionBankRepository,
      auth: overrides.auth || authRepository,
      transaction: overrides.transaction || withTransaction,
   }
}

function parseId(value, code, message) {
   try {
      return normalizeInternalId(value)
   } catch {
      throw new AppError(400, code, message)
   }
}

function parseBankId(value) {
   return parseId(value, 'INVALID_QUESTION_BANK_ID', 'Question bank identifier is invalid')
}

function parseQuestionId(value) {
   return parseId(value, 'INVALID_QUESTION_ID', 'Question identifier is invalid')
}

function parseOptionalQueryId(value, field) {
   if (value === undefined) return null
   try {
      return normalizeInternalId(value)
   } catch {
      throw validationError(field)
   }
}

function parseOptionalEnum(value, field, allowed) {
   if (value === undefined) return null
   if (!allowed.includes(value)) throw validationError(field)
   return value
}

function bankNotFound() {
   return new AppError(404, 'QUESTION_BANK_NOT_FOUND', 'Question bank was not found')
}

function questionNotFound() {
   return new AppError(404, 'QUESTION_NOT_FOUND', 'Question was not found')
}

function canManage(bank, actorId) {
   return Boolean(bank.administrator) || bank.owner_id === actorId
}

function requireManage(bank, actorId) {
   if (!canManage(bank, actorId)) {
      throw new AppError(403, 'QUESTION_BANK_READ_ONLY', 'You can only read this question bank')
   }
}

function requireDraft(question) {
   if (question.status !== 'draft') {
      throw new AppError(409, 'QUESTION_IMMUTABLE', 'Published and archived questions cannot be changed; create a copy')
   }
}

function mapConstraintError(error) {
   if (error.code === '23505' && error.constraint === 'question_banks_code_key') {
      return new AppError(409, 'QUESTION_BANK_CODE_CONFLICT', 'Question bank code already exists')
   }
   if (error.code === '23505' && error.constraint === 'questions_bank_id_external_id_key') {
      return new AppError(409, 'QUESTION_EXTERNAL_ID_CONFLICT', 'External identifier already exists in this bank')
   }
   return error
}

function safeBank(row, actorId) {
   return {
      id: row.id,
      code: row.code,
      title: row.title,
      subjectId: row.subject_id,
      ownerId: row.owner_id,
      visibility: row.visibility,
      sourceMetadata: row.source_metadata,
      questionCount: row.question_count ?? 0,
      permissions: { manage: canManage(row, actorId) },
      createdAt: row.created_at,
   }
}

function safeQuestionSummary(row) {
   return {
      id: row.id,
      externalId: row.external_id,
      questionType: row.question_type,
      languageCode: row.language_code,
      difficulty: row.difficulty,
      difficultySource: row.difficulty_source,
      status: row.status,
      keyStatus: row.key_status,
      content: row.content,
      updatedAt: row.updated_at,
   }
}

function safeItem(row, keyField) {
   return {
      key: row[keyField],
      position: row.position,
      sourceLabel: row.source_label,
      content: row.content,
   }
}

// The answer key is part of the response only for people who may manage the bank;
// read-only staff see the key status but never answer_data or the explanation.
function safeQuestion(row, parts, includeKey) {
   const question = {
      id: row.id,
      bankId: row.bank_id,
      subjectId: row.subject_id,
      externalId: row.external_id,
      questionType: row.question_type,
      languageCode: row.language_code,
      difficulty: row.difficulty,
      difficultySource: row.difficulty_source,
      status: row.status,
      content: row.content,
      interactionSettings: row.interaction_settings,
      sourceMetadata: row.source_metadata,
      sourceQuestionId: row.source_question_id,
      importId: row.import_id,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      options: parts.options.map((option) => safeItem(option, 'option_key')),
      matching: row.question_type === 'matching'
         ? {
            left: parts.matching.filter((item) => item.side === 'left').map((item) => safeItem(item, 'item_key')),
            right: parts.matching.filter((item) => item.side === 'right').map((item) => safeItem(item, 'item_key')),
         }
         : null,
      topicIds: parts.topicIds,
      assetIds: parts.assetIds,
      keyStatus: parts.answerKey?.status || 'unknown',
   }
   if (includeKey) {
      question.answerKey = parts.answerKey
         ? {
            status: parts.answerKey.status,
            source: parts.answerKey.source,
            answerData: parts.answerKey.answer_data,
            explanation: parts.answerKey.explanation,
            verifiedBy: parts.answerKey.verified_by,
            verifiedAt: parts.answerKey.verified_at,
         }
         : { status: 'unknown', source: 'none', answerData: null, explanation: { blocks: [] }, verifiedBy: null, verifiedAt: null }
   }
   return question
}

// The structure the answer-key validator needs, built from stored rows.
function keyShape(row, parts) {
   return {
      questionType: row.question_type,
      interactionSettings: row.interaction_settings,
      options: parts.options.map((option) => ({ key: option.option_key })),
      matching: {
         left: parts.matching.filter((item) => item.side === 'left').map((item) => ({ key: item.item_key })),
         right: parts.matching.filter((item) => item.side === 'right').map((item) => ({ key: item.item_key })),
      },
   }
}

function collectContentAssets(content, assetIds) {
   for (const block of content?.blocks || []) {
      if (block.type === 'image') assetIds.add(block.assetId)
   }
}

function storedAssetIds(row, parts) {
   const assetIds = new Set()
   collectContentAssets(row.content, assetIds)
   for (const item of [...parts.options, ...parts.matching]) collectContentAssets(item.content, assetIds)
   collectContentAssets(parts.answerKey?.explanation, assetIds)
   return [...assetIds]
}

function parseBankBody(body, partial) {
   validateBody(body, partial ? ['code', 'title', 'visibility', 'sourceMetadata']
      : ['code', 'title', 'subjectId', 'visibility', 'sourceMetadata'])
   if (partial && !Object.keys(body).length) throw validationError('body')
   if (!partial || body.code !== undefined) {
      if (typeof body.code !== 'string' || !bankCodePattern.test(body.code)) throw validationError('code')
   }
   let title = null
   if (!partial || body.title !== undefined) {
      if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 200) {
         throw validationError('title')
      }
      title = body.title.trim()
   }
   return {
      code: body.code === undefined ? null : body.code,
      title,
      subjectId: partial ? null : parseOptionalQueryId(body.subjectId ?? '', 'subjectId'),
      visibility: body.visibility === undefined
         ? (partial ? null : 'private')
         : parseOptionalEnum(body.visibility, 'visibility', ['private', 'staff']),
      sourceMetadata: body.sourceMetadata === undefined
         ? (partial ? null : {})
         : parseSourceMetadata(body.sourceMetadata),
   }
}

function parseTopicIds(value) {
   if (!Array.isArray(value) || value.length > 20) throw validationError('topicIds')
   const topicIds = value.map((topicId) => parseOptionalQueryId(topicId, 'topicIds'))
   if (new Set(topicIds).size !== topicIds.length) throw validationError('topicIds')
   return topicIds
}

function parseExternalId(value) {
   if (value === null) return null
   if (typeof value !== 'string' || !value.trim() || value.length > 200) throw validationError('externalId')
   return value.trim()
}

function parseDifficulty(body, values) {
   if (body.difficulty === undefined && body.difficultySource === undefined) return
   if (body.difficulty === null && (body.difficultySource === null || body.difficultySource === undefined)) {
      values.hasDifficulty = true
      return
   }
   if (!Number.isInteger(body.difficulty) || body.difficulty < 1 || body.difficulty > 5) {
      throw validationError('difficulty')
   }
   if (!difficultySources.includes(body.difficultySource)) throw validationError('difficultySource')
   values.hasDifficulty = true
   values.difficulty = body.difficulty
   values.difficultySource = body.difficultySource
}

// One parser for create and PATCH. `questionType` comes from the body on create and from
// the stored row on PATCH; type-specific structure is required or forbidden accordingly.
function parseQuestionBody(body, questionType, partial) {
   validateBody(body, partial ? questionFields.filter((field) => field !== 'questionType') : questionFields)
   if (partial && !Object.keys(body).length) throw validationError('body')
   const assetIds = new Set()
   const values = {
      hasExternalId: body.externalId !== undefined,
      externalId: body.externalId === undefined ? null : parseExternalId(body.externalId),
      languageCode: body.languageCode === undefined
         ? (partial ? null : 'tg')
         : parseOptionalEnum(body.languageCode, 'languageCode', languages),
      hasDifficulty: false,
      difficulty: null,
      difficultySource: null,
      content: null,
      interactionSettings: null,
      sourceMetadata: body.sourceMetadata === undefined
         ? (partial ? null : {})
         : parseSourceMetadata(body.sourceMetadata),
      options: null,
      matching: null,
      topicIds: body.topicIds === undefined ? (partial ? null : []) : parseTopicIds(body.topicIds),
      assetIds,
   }
   parseDifficulty(body, values)
   if (!partial || body.content !== undefined) {
      values.content = parseContent(body.content, 'content', assetIds)
   }
   if (questionType === 'matching') {
      if (!partial || body.interactionSettings !== undefined) {
         values.interactionSettings = parseInteractionSettings(body.interactionSettings, questionType)
      }
   } else if (body.interactionSettings !== undefined) {
      values.interactionSettings = parseInteractionSettings(body.interactionSettings, questionType)
   } else if (!partial) {
      values.interactionSettings = {}
   }
   if (choiceTypes.includes(questionType)) {
      if (!partial || body.options !== undefined) values.options = parseOptions(body.options, assetIds)
   } else if (body.options !== undefined) {
      throw validationError('options', 'options are allowed only for choice questions')
   }
   if (questionType === 'matching') {
      if (!partial || body.matching !== undefined) values.matching = parseMatching(body.matching, assetIds)
   } else if (body.matching !== undefined) {
      throw validationError('matching', 'matching items are allowed only for matching questions')
   }
   return values
}

function parseListQuery(query = {}) {
   return {
      ...parsePagination(query),
      status: parseOptionalEnum(query.status, 'status', questionStatuses),
      questionType: parseOptionalEnum(query.questionType, 'questionType', questionTypes),
      languageCode: parseOptionalEnum(query.languageCode, 'languageCode', languages),
      keyStatus: parseOptionalEnum(query.keyStatus, 'keyStatus', keyStatuses),
      topicId: parseOptionalQueryId(query.topicId, 'topicId'),
   }
}

async function audit(auth, client, actorId, code, entityType, entityId, metadata = {}) {
   await auth.appendAuditEvent({
      actorUserId: actorId,
      subjectUserId: null,
      code,
      entityType,
      entityId,
      metadata,
   }, client)
}

async function validateAssets(repository, client, actorId, bankId, assetIds) {
   const requested = [...assetIds]
   if (!requested.length) return
   const usable = new Set(await repository.findUsableImageAssets(actorId, bankId, requested, client))
   const rejected = requested.find((assetId) => !usable.has(assetId))
   if (rejected) {
      throw new AppError(422, 'QUESTION_ASSET_NOT_USABLE', 'Image asset is not available for this question', [
         { field: 'assetId', message: `asset ${rejected} is not a usable image` },
      ])
   }
}

async function validateTopics(repository, client, subjectId, topicIds) {
   if (!topicIds?.length) return
   if (await repository.countSubjectTopics(subjectId, topicIds, client) !== topicIds.length) {
      throw new AppError(422, 'TAXONOMY_SUBJECT_MISMATCH', 'Every topic must belong to the question subject')
   }
}

async function loadQuestionForChange(repository, client, actorId, questionId) {
   const question = await repository.lockQuestion(questionId, client)
   if (!question) throw questionNotFound()
   const bank = await repository.lockReadableBank(actorId, question.bank_id, client)
   if (!bank) throw questionNotFound()
   return { question, bank }
}

// After any draft edit, a key that no longer fits the structure becomes unknown and a
// verified key goes back to proposed: a reviewer verified the previous content, not this one.
async function reconcileAnswerKey(repository, client, questionId) {
   const row = await repository.findQuestion(questionId, client)
   const parts = await repository.findQuestionParts(questionId, client)
   const key = parts.answerKey
   let keyChange = null
   if (key && key.answer_data && !isValidAnswerData(key.answer_data, keyShape(row, parts))) {
      await repository.upsertAnswerKey(questionId, {
         status: 'unknown',
         source: 'none',
         answerData: null,
         explanation: key.explanation,
      }, client)
      keyChange = 'reset_to_unknown'
   } else if (key && key.status === 'verified') {
      await repository.upsertAnswerKey(questionId, {
         status: 'proposed',
         source: key.source,
         answerData: key.answer_data,
         explanation: key.explanation,
      }, client)
      keyChange = 'returned_to_proposed'
   }
   const refreshed = keyChange ? await repository.findQuestionParts(questionId, client) : parts
   await repository.replaceAssets(questionId, storedAssetIds(row, refreshed), client)
   return keyChange
}

async function readQuestion(repository, client, questionId, includeKey) {
   const row = await repository.findQuestion(questionId, client)
   const parts = await repository.findQuestionParts(questionId, client)
   return safeQuestion(row, parts, includeKey)
}

async function listQuestionBanksService(userId, query, overrides) {
   const { repository } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   validateBody(query || {}, ['limit', 'offset', 'subjectId'])
   const filters = {
      ...parsePagination(query),
      subjectId: parseOptionalQueryId(query?.subjectId, 'subjectId'),
   }
   const rows = await repository.listReadableBanks(actorId, filters)
   return {
      banks: rows.slice(0, filters.limit).map((row) => safeBank(row, actorId)),
      pagination: { limit: filters.limit, offset: filters.offset, hasMore: rows.length > filters.limit },
   }
}

async function getQuestionBankService(userId, bankIdValue, overrides) {
   const { repository } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const bank = await repository.findReadableBank(actorId, parseBankId(bankIdValue))
   if (!bank) throw bankNotFound()
   return safeBank(bank, actorId)
}

async function createQuestionBankService(userId, body, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const values = parseBankBody(body, false)
   try {
      return await transaction(async (client) => {
         if (!await repository.subjectExists(values.subjectId, client)) throw validationError('subjectId')
         const bankId = await repository.createBank({ ...values, ownerId: actorId }, client)
         await audit(auth, client, actorId, 'question_bank.created', 'question_bank', bankId, {
            code: values.code,
         })
         return safeBank(await repository.findReadableBank(actorId, bankId, client), actorId)
      })
   } catch (error) {
      throw mapConstraintError(error)
   }
}

async function updateQuestionBankService(userId, bankIdValue, body, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const bankId = parseBankId(bankIdValue)
   const values = parseBankBody(body, true)
   try {
      return await transaction(async (client) => {
         const bank = await repository.lockReadableBank(actorId, bankId, client)
         if (!bank) throw bankNotFound()
         requireManage(bank, actorId)
         await repository.updateBank(bankId, values, client)
         await audit(auth, client, actorId, 'question_bank.updated', 'question_bank', bankId, {
            fields: Object.keys(body),
         })
         return safeBank(await repository.findReadableBank(actorId, bankId, client), actorId)
      })
   } catch (error) {
      throw mapConstraintError(error)
   }
}

async function listBankQuestionsService(userId, bankIdValue, query, overrides) {
   const { repository } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const bankId = parseBankId(bankIdValue)
   validateBody(query || {}, ['limit', 'offset', 'status', 'questionType', 'languageCode', 'keyStatus', 'topicId'])
   const filters = parseListQuery(query)
   if (!await repository.findReadableBank(actorId, bankId)) throw bankNotFound()
   const rows = await repository.listQuestions(bankId, filters)
   return {
      questions: rows.slice(0, filters.limit).map(safeQuestionSummary),
      pagination: { limit: filters.limit, offset: filters.offset, hasMore: rows.length > filters.limit },
   }
}

async function getQuestionService(userId, questionIdValue, overrides) {
   const { repository } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const questionId = parseQuestionId(questionIdValue)
   const row = await repository.findQuestion(questionId)
   if (!row) throw questionNotFound()
   const bank = await repository.findReadableBank(actorId, row.bank_id)
   if (!bank) throw questionNotFound()
   return safeQuestion(row, await repository.findQuestionParts(questionId), canManage(bank, actorId))
}

async function createQuestionService(userId, bankIdValue, body, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const bankId = parseBankId(bankIdValue)
   validateBody(body, questionFields)
   if (!questionTypes.includes(body.questionType)) throw validationError('questionType')
   const values = parseQuestionBody(body, body.questionType, false)
   try {
      return await transaction(async (client) => {
         const bank = await repository.lockReadableBank(actorId, bankId, client)
         if (!bank) throw bankNotFound()
         requireManage(bank, actorId)
         await validateTopics(repository, client, bank.subject_id, values.topicIds)
         await validateAssets(repository, client, actorId, bankId, values.assetIds)
         const questionId = await repository.createQuestion({
            ...values,
            bankId,
            subjectId: bank.subject_id,
            questionType: body.questionType,
            sourceQuestionId: null,
            actorId,
         }, client)
         if (values.options) await repository.replaceOptions(questionId, values.options, client)
         if (values.matching) await repository.replaceMatchingItems(questionId, values.matching, client)
         await repository.replaceTopics(questionId, bank.subject_id, values.topicIds, client)
         await repository.replaceAssets(questionId, [...values.assetIds], client)
         await audit(auth, client, actorId, 'question.created', 'question', questionId, {
            bankId,
            questionType: body.questionType,
         })
         return readQuestion(repository, client, questionId, true)
      })
   } catch (error) {
      throw mapConstraintError(error)
   }
}

async function updateQuestionService(userId, questionIdValue, body, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const questionId = parseQuestionId(questionIdValue)
   try {
      return await transaction(async (client) => {
         const { question, bank } = await loadQuestionForChange(repository, client, actorId, questionId)
         requireManage(bank, actorId)
         requireDraft(question)
         const values = parseQuestionBody(body, question.question_type, true)
         await validateTopics(repository, client, bank.subject_id, values.topicIds)
         await validateAssets(repository, client, actorId, bank.id, values.assetIds)
         await repository.updateQuestion(questionId, values, client)
         if (values.options) await repository.replaceOptions(questionId, values.options, client)
         if (values.matching) await repository.replaceMatchingItems(questionId, values.matching, client)
         if (values.topicIds) await repository.replaceTopics(questionId, bank.subject_id, values.topicIds, client)
         const keyChange = await reconcileAnswerKey(repository, client, questionId)
         await audit(auth, client, actorId, 'question.updated', 'question', questionId, {
            fields: Object.keys(body),
            keyChange,
         })
         return readQuestion(repository, client, questionId, true)
      })
   } catch (error) {
      throw mapConstraintError(error)
   }
}

async function deleteQuestionService(userId, questionIdValue, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const questionId = parseQuestionId(questionIdValue)
   return transaction(async (client) => {
      const { question, bank } = await loadQuestionForChange(repository, client, actorId, questionId)
      requireManage(bank, actorId)
      requireDraft(question)
      if (await repository.isQuestionReferenced(questionId, client)) {
         throw new AppError(409, 'QUESTION_IN_USE', 'Question is referenced by copies, tests or duplicate links')
      }
      await repository.deleteDraftQuestion(questionId, client)
      await audit(auth, client, actorId, 'question.deleted', 'question', questionId, { bankId: bank.id })
      return { id: questionId, status: 'deleted' }
   })
}

async function copyQuestionService(userId, questionIdValue, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const questionId = parseQuestionId(questionIdValue)
   return transaction(async (client) => {
      const { question, bank } = await loadQuestionForChange(repository, client, actorId, questionId)
      requireManage(bank, actorId)
      const parts = await repository.findQuestionParts(questionId, client)
      const copyId = await repository.createQuestion({
         bankId: question.bank_id,
         subjectId: question.subject_id,
         externalId: null,
         questionType: question.question_type,
         languageCode: question.language_code,
         difficulty: question.difficulty,
         difficultySource: question.difficulty_source,
         content: question.content,
         interactionSettings: question.interaction_settings,
         sourceMetadata: question.source_metadata,
         sourceQuestionId: questionId,
         actorId,
      }, client)
      const toItem = (row, keyField) => ({
         key: row[keyField],
         position: row.position,
         sourceLabel: row.source_label,
         content: row.content,
      })
      await repository.replaceOptions(copyId, parts.options.map((row) => toItem(row, 'option_key')), client)
      if (question.question_type === 'matching') {
         await repository.replaceMatchingItems(copyId, {
            left: parts.matching.filter((row) => row.side === 'left').map((row) => toItem(row, 'item_key')),
            right: parts.matching.filter((row) => row.side === 'right').map((row) => toItem(row, 'item_key')),
         }, client)
      }
      await repository.replaceTopics(copyId, question.subject_id, parts.topicIds, client)
      await repository.replaceAssets(copyId, parts.assetIds, client)
      // A copy is new content: the key travels with it but must be verified again.
      if (parts.answerKey) {
         await repository.upsertAnswerKey(copyId, {
            status: parts.answerKey.answer_data ? 'proposed' : 'unknown',
            source: parts.answerKey.answer_data ? parts.answerKey.source : 'none',
            answerData: parts.answerKey.answer_data,
            explanation: parts.answerKey.explanation,
         }, client)
      }
      await audit(auth, client, actorId, 'question.copied', 'question', copyId, {
         sourceQuestionId: questionId,
      })
      return readQuestion(repository, client, copyId, true)
   })
}

async function replaceAnswerKeyService(userId, questionIdValue, body, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const questionId = parseQuestionId(questionIdValue)
   validateBody(body, ['answerData', 'source', 'explanation'])
   if (body.answerData === undefined) throw validationError('answerData')
   const assetIds = new Set()
   const explanation = body.explanation === undefined
      ? { blocks: [] }
      : parseContent(body.explanation, 'explanation', assetIds, { allowEmpty: true })
   if (body.answerData === null) {
      if (body.source !== undefined && body.source !== 'none') throw validationError('source')
   } else if (!proposalSources.includes(body.source)) {
      throw validationError('source')
   }
   return transaction(async (client) => {
      const { question, bank } = await loadQuestionForChange(repository, client, actorId, questionId)
      requireManage(bank, actorId)
      requireDraft(question)
      const parts = await repository.findQuestionParts(questionId, client)
      const answerData = body.answerData === null
         ? null
         : parseAnswerData(body.answerData, keyShape(question, parts))
      await validateAssets(repository, client, actorId, bank.id, assetIds)
      const status = answerData ? 'proposed' : 'unknown'
      await repository.upsertAnswerKey(questionId, {
         status,
         source: answerData ? body.source : 'none',
         answerData,
         explanation,
      }, client)
      await repository.replaceAssets(
         questionId,
         storedAssetIds(question, await repository.findQuestionParts(questionId, client)),
         client,
      )
      await audit(auth, client, actorId, 'question.answer_key.updated', 'question', questionId, {
         status,
         source: answerData ? body.source : 'none',
      })
      return readQuestion(repository, client, questionId, true)
   })
}

async function verifyAnswerKeyService(userId, questionIdValue, body, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const questionId = parseQuestionId(questionIdValue)
   validateBody(body, ['source'])
   if (!verificationSources.includes(body.source)) throw validationError('source')
   return transaction(async (client) => {
      const { question } = await loadQuestionForChange(repository, client, actorId, questionId)
      requireDraft(question)
      const key = await repository.lockAnswerKey(questionId, client)
      if (!key || key.status !== 'proposed') {
         throw new AppError(409, 'ANSWER_KEY_NOT_PROPOSED', 'Only a proposed answer key can be verified')
      }
      const parts = await repository.findQuestionParts(questionId, client)
      parseAnswerData(key.answer_data, keyShape(question, parts))
      await repository.verifyAnswerKey(questionId, body.source, actorId, client)
      await audit(auth, client, actorId, 'question.answer_key.verified', 'question', questionId, {
         source: body.source,
      })
      return readQuestion(repository, client, questionId, true)
   })
}

async function publishQuestionService(userId, questionIdValue, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const questionId = parseQuestionId(questionIdValue)
   return transaction(async (client) => {
      const { question } = await loadQuestionForChange(repository, client, actorId, questionId)
      if (question.status !== 'draft') {
         throw new AppError(409, 'INVALID_QUESTION_TRANSITION', 'Only draft questions can be published')
      }
      const parts = await repository.findQuestionParts(questionId, client)
      const notReady = (reason) => new AppError(409, 'QUESTION_NOT_PUBLISHABLE', 'Question is not ready for publication', [
         { field: 'question', message: reason },
      ])
      if (parts.answerKey?.status !== 'verified') throw notReady('ANSWER_KEY_NOT_VERIFIED')
      if (!isValidAnswerData(parts.answerKey.answer_data, keyShape(question, parts))) {
         throw notReady('ANSWER_KEY_INVALID')
      }
      if (parts.assetIds.length && (await repository.findUsableImageAssets(
         actorId,
         question.bank_id,
         parts.assetIds,
         client,
      )).length !== parts.assetIds.length) {
         throw notReady('ASSET_NOT_READY')
      }
      await repository.setQuestionStatus(questionId, 'published', client)
      await audit(auth, client, actorId, 'question.published', 'question', questionId, {})
      return readQuestion(repository, client, questionId, true)
   })
}

async function archiveQuestionService(userId, questionIdValue, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   const questionId = parseQuestionId(questionIdValue)
   return transaction(async (client) => {
      const { question } = await loadQuestionForChange(repository, client, actorId, questionId)
      if (question.status !== 'published') {
         throw new AppError(409, 'INVALID_QUESTION_TRANSITION', 'Only published questions can be archived')
      }
      await repository.setQuestionStatus(questionId, 'archived', client)
      await audit(auth, client, actorId, 'question.archived', 'question', questionId, {})
      return readQuestion(repository, client, questionId, true)
   })
}

export {
   archiveQuestionService,
   copyQuestionService,
   createQuestionBankService,
   createQuestionService,
   deleteQuestionService,
   getQuestionBankService,
   getQuestionService,
   listBankQuestionsService,
   listQuestionBanksService,
   publishQuestionService,
   replaceAnswerKeyService,
   updateQuestionBankService,
   updateQuestionService,
   verifyAnswerKeyService,
}
