import * as authRepository from '../repositories/auth-repository.js'
import * as authorizationRepository from '../repositories/authorization-repository.js'
import * as questionBankRepository from '../repositories/question-bank-repository.js'
import * as questionImportRepository from '../repositories/question-import-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import AppError from '../utils/app-error.js'
import { isPlainObject, parseAnswerData, parseContent } from '../utils/question-content.js'
import { convertContent, mapAnswerData } from '../utils/question-package-adapter.js'
import { validationError } from './course-service.js'
import { keyShape, replaceAnswerKeyService, updateQuestionService } from './question-bank-service.js'
import { loadImportActor } from './question-import-service.js'

// Attaches answer keys from an `everest.answer-key-import.v1` sidecar file to questions that
// were already imported. Keys become `proposed` through the same service as
// PUT /admin/questions/:id/answer-key; nothing is verified or published here. A proposed key
// that differs from the file is reported, never overwritten. Runs are recorded in
// question_imports (schema_version = everest.answer-key-import.v1).

const schemaVersion = 'everest.answer-key-import.v1'
const headerFields = ['schemaVersion', 'sourcePackage', 'bankCode', 'keySource', 'records']
const keySourceFields = ['filename', 'sha256', 'pages']
const recordFields = ['bankCode', 'questionExternalId', 'status', 'source', 'answerDataExternal', 'explanation']
const importSources = ['official_key', 'expert_review']
const bankCodePattern = /^[a-z0-9][a-z0-9_-]{0,99}$/
const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{1,200}$/
const sha256Pattern = /^[A-Fa-f0-9]{64}$/
const maxRecords = 20000
const maxBatchSize = 100
const outcomeCodes = [
   'APPLIED',
   'UNCHANGED',
   'KEY_CONFLICT',
   'KEY_VERIFIED_SKIPPED',
   'QUESTION_NOT_DRAFT',
   'QUESTION_NOT_FOUND',
   'ANSWER_KEY_INVALID',
]
const ruleCounters = {
   REQUIRE_ALL_LEFT_SET: ['requireAllLeft', 'set'],
   REQUIRE_ALL_LEFT_SKIPPED_ALREADY_SET: ['requireAllLeft', 'skippedAlreadySet'],
   REQUIRE_ALL_LEFT_SKIPPED_NOT_COVERED: ['requireAllLeft', 'skippedNotCovered'],
   RIGHT_REUSE_SET_FALSE: ['allowRightReuse', 'set'],
   RIGHT_REUSE_SKIPPED_ALREADY_SET: ['allowRightReuse', 'skippedAlreadySet'],
   RIGHT_REUSE_SKIPPED_NOT_DISTINCT: ['allowRightReuse', 'skippedNotDistinct'],
}

function dependencies(overrides = {}) {
   return {
      questions: overrides.questions || questionBankRepository,
      imports: overrides.imports || questionImportRepository,
      authorization: overrides.authorization || authorizationRepository,
      auth: overrides.auth || authRepository,
      transaction: overrides.transaction || withTransaction,
      replaceAnswerKey: overrides.replaceAnswerKey || replaceAnswerKeyService,
      updateQuestion: overrides.updateQuestion || updateQuestionService,
      log: overrides.log || (() => {}),
   }
}

// --- Report -----------------------------------------------------------------------------

function emptyCounters(batchSize, setMatchingRules) {
   return {
      records: 0,
      outcomes: Object.fromEntries(outcomeCodes.map((code) => [code, 0])),
      noKeyForQuestion: 0,
      recordsFailed: 0,
      recordsNotAttempted: 0,
      batches: { size: batchSize, committed: 0, failed: 0 },
      matchingRules: {
         enabled: setMatchingRules,
         requireAllLeft: { set: 0, skippedAlreadySet: 0, skippedNotCovered: 0, stillNull: 0 },
         allowRightReuse: { set: 0, skippedAlreadySet: 0, skippedNotDistinct: 0, stillNull: 0 },
         matchingDrafts: 0,
         publishableBySettings: 0,
      },
      errors: 0,
   }
}

function fileError(errors, code, path, message, externalId = null) {
   errors.push({ severity: 'error', code, path, message, externalId })
}

function topCodes(entries, limit = 10) {
   const counts = new Map()
   for (const entry of entries) counts.set(entry.code, (counts.get(entry.code) || 0) + 1)
   return [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, limit)
      .map(([code, count]) => ({ code, count }))
}

// --- File validation --------------------------------------------------------------------

function parseText(value, maximum) {
   return typeof value === 'string' && value.trim() && value.trim().length <= maximum ? value.trim() : null
}

function parseHeader(document, requestedBank, errors) {
   if (document.schemaVersion !== schemaVersion) {
      fileError(errors, 'KEY_FILE_SCHEMA_VERSION_UNSUPPORTED', 'schemaVersion', `schemaVersion must be ${schemaVersion}`)
   }
   for (const field of Object.keys(document)) {
      if (!headerFields.includes(field)) fileError(errors, 'KEY_FILE_FIELD_UNKNOWN', field, `${field} is not allowed`)
   }
   const sourcePackage = parseText(document.sourcePackage, 200)
   if (!sourcePackage) fileError(errors, 'KEY_FILE_HEADER_INVALID', 'sourcePackage', 'sourcePackage must be a non-empty string')
   const bankCode = typeof document.bankCode === 'string' && bankCodePattern.test(document.bankCode) ? document.bankCode : null
   if (!bankCode) fileError(errors, 'KEY_FILE_HEADER_INVALID', 'bankCode', 'bankCode is invalid')
   else if (requestedBank && requestedBank !== bankCode) {
      fileError(errors, 'KEY_FILE_BANK_MISMATCH', 'bankCode', `the file is for bank ${bankCode}, not ${requestedBank}`)
   }
   let keySource = null
   const raw = document.keySource
   if (!isPlainObject(raw) || Object.keys(raw).some((field) => !keySourceFields.includes(field))
      || !parseText(raw.filename, 255) || typeof raw.sha256 !== 'string' || !sha256Pattern.test(raw.sha256)
      || (raw.pages !== undefined && (!Number.isSafeInteger(raw.pages) || raw.pages < 1))) {
      fileError(errors, 'KEY_FILE_HEADER_INVALID', 'keySource', 'keySource must be { filename, sha256 (hex), pages? }')
   } else {
      keySource = {
         filename: parseText(raw.filename, 255),
         sha256: raw.sha256.toLowerCase(),
         ...(raw.pages === undefined ? {} : { pages: raw.pages }),
      }
   }
   return { sourcePackage, bankCode, keySource }
}

function parseExplanation(value) {
   if (value === undefined || value === null) return { blocks: [] }
   // Package-external rich content, converted like the question importer does. Image blocks
   // reference package assets, which a key file cannot carry, so the parser rejects them.
   return parseContent(convertContent(value, () => {}), 'explanation', new Set(), { allowEmpty: true })
}

function parseRecord(raw, path, header, errors) {
   if (!isPlainObject(raw)) {
      fileError(errors, 'KEY_RECORD_INVALID', path, 'a record must be an object')
      return null
   }
   const externalId = parseText(raw.questionExternalId, 200)
   const before = errors.length
   const unknown = Object.keys(raw).find((field) => !recordFields.includes(field))
   if (unknown) fileError(errors, 'KEY_FILE_FIELD_UNKNOWN', `${path}.${unknown}`, `${unknown} is not allowed`, externalId)
   if (!externalId) fileError(errors, 'KEY_RECORD_EXTERNAL_ID_INVALID', `${path}.questionExternalId`, 'questionExternalId must be a non-empty string (≤200)')
   if (header.bankCode && raw.bankCode !== header.bankCode) {
      fileError(errors, 'KEY_RECORD_BANK_MISMATCH', `${path}.bankCode`, 'record bankCode differs from the file bankCode', externalId)
   }
   if (raw.status === 'verified') {
      fileError(errors, 'ANSWER_KEY_VERIFIED_REJECTED', `${path}.status`, 'key files cannot carry verified keys; verification is a reviewer action', externalId)
   } else if (raw.status !== 'proposed') {
      fileError(errors, 'ANSWER_KEY_STATUS_INVALID', `${path}.status`, 'status must be proposed', externalId)
   }
   if (!importSources.includes(raw.source)) {
      fileError(errors, 'ANSWER_KEY_SOURCE_REJECTED', `${path}.source`, 'source must be official_key or expert_review', externalId)
   }
   if (!isPlainObject(raw.answerDataExternal)) {
      fileError(errors, 'ANSWER_DATA_REQUIRED', `${path}.answerDataExternal`, 'answerDataExternal must be an object', externalId)
   }
   let explanation = null
   try {
      explanation = parseExplanation(raw.explanation)
   } catch (error) {
      if (!(error instanceof AppError)) throw error
      fileError(errors, 'EXPLANATION_INVALID', `${path}.explanation`, 'explanation must be rich content without images', externalId)
   }
   if (errors.length !== before) return null
   return { path, externalId, source: raw.source, answerDataExternal: raw.answerDataExternal, explanation }
}

// Any error here rejects the whole file before anything is read from or written to the bank.
function parseKeyFile(document, requestedBank) {
   const errors = []
   if (!isPlainObject(document)) {
      fileError(errors, 'KEY_FILE_SCHEMA_INVALID', 'file', 'the file must be a JSON object')
      return { header: null, records: [], errors }
   }
   const header = parseHeader(document, requestedBank, errors)
   if (!Array.isArray(document.records) || !document.records.length || document.records.length > maxRecords) {
      fileError(errors, 'KEY_FILE_SCHEMA_INVALID', 'records', `records must be an array of 1-${maxRecords} records`)
      return { header, records: [], errors }
   }
   const records = []
   const seen = new Map()
   for (const [index, raw] of document.records.entries()) {
      const path = `records[${index}]`
      const record = parseRecord(raw, path, header, errors)
      const externalId = record?.externalId ?? (isPlainObject(raw) ? parseText(raw.questionExternalId, 200) : null)
      if (externalId && seen.has(externalId)) {
         fileError(errors, 'KEY_RECORD_DUPLICATE', `${path}.questionExternalId`, `the same question is also keyed by ${seen.get(externalId)}`, externalId)
         continue
      }
      if (externalId) seen.set(externalId, path)
      if (record) records.push({ ...record, index })
   }
   return { header, records, errors }
}

function parseOptions(options = {}) {
   const batchSize = options.batchSize ?? maxBatchSize
   if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > maxBatchSize) {
      throw validationError('batchSize', `batchSize must be 1-${maxBatchSize}`)
   }
   if (options.setMatchingRules !== undefined && typeof options.setMatchingRules !== 'boolean') {
      throw validationError('setMatchingRules')
   }
   let bankCode = null
   if (options.bankCode !== undefined && options.bankCode !== null) {
      if (typeof options.bankCode !== 'string' || !bankCodePattern.test(options.bankCode)) throw validationError('bank')
      bankCode = options.bankCode
   }
   return { batchSize, setMatchingRules: options.setMatchingRules === true, bankCode }
}

// Setting matching rules changes what is written, so the same bytes with it are another run.
function parseIdempotencyKey(value, fileSha256, setMatchingRules) {
   if (value === undefined || value === null) {
      return `answer-keys-${fileSha256}${setMatchingRules ? '-matching-rules' : ''}`
   }
   if (typeof value !== 'string' || !idempotencyKeyPattern.test(value)) {
      throw validationError('idempotencyKey', 'idempotencyKey must match [A-Za-z0-9._:-]{1,200}')
   }
   return value
}

// --- Classification ---------------------------------------------------------------------

// Order-insensitive form used to decide UNCHANGED vs KEY_CONFLICT.
function canonicalAnswer(data) {
   if (!isPlainObject(data)) return JSON.stringify(data ?? null)
   if (Array.isArray(data.pairs)) {
      const pairs = data.pairs.map((pair) => ({ left: String(pair?.left), right: String(pair?.right) }))
      return JSON.stringify({ pairs: pairs.sort((left, right) => left.left.localeCompare(right.left)) })
   }
   if (Array.isArray(data.optionKeys)) return JSON.stringify({ optionKeys: [...data.optionKeys].sort() })
   if (Array.isArray(data.acceptedAnswers)) return JSON.stringify({ acceptedAnswers: [...data.acceptedAnswers].sort() })
   return JSON.stringify(Object.fromEntries(Object.entries(data).sort(([left], [right]) => left.localeCompare(right))))
}

function mapRecordAnswer(record, questionType) {
   const ignored = []
   const mapped = mapAnswerData(record.answerDataExternal, questionType, (code) => ignored.push(code))
   // Tolerance, units and normalization would change grading; they are not stored, so a key
   // that depends on them is refused instead of being applied without them.
   if (ignored.length) {
      throw new AppError(400, 'ANSWER_KEY_INVALID', 'Answer key is invalid', [
         { field: 'answerData', message: 'grading rules (tolerance, unit, normalization) are not supported' },
      ])
   }
   return mapped
}

function classify(record, row, parts) {
   if (!row) return { code: 'QUESTION_NOT_FOUND', message: 'no question with this externalId in the bank' }
   if (row.status !== 'draft') {
      return { code: 'QUESTION_NOT_DRAFT', message: `question is ${row.status}; only drafts receive keys` }
   }
   const key = parts.answerKey
   if (key?.status === 'verified') {
      return { code: 'KEY_VERIFIED_SKIPPED', message: 'a verified key is stored; it is never changed by an import' }
   }
   let answerData
   try {
      answerData = parseAnswerData(mapRecordAnswer(record, row.question_type), keyShape(row, parts))
   } catch (error) {
      if (!(error instanceof AppError)) throw error
      return { code: 'ANSWER_KEY_INVALID', message: error.details?.[0]?.message || error.message }
   }
   if (key?.status === 'proposed') {
      if (key.source === record.source && canonicalAnswer(key.answer_data) === canonicalAnswer(answerData)) {
         return { code: 'UNCHANGED', message: 'the same proposed key is already stored', answerData }
      }
      return {
         code: 'KEY_CONFLICT',
         message: 'a different proposed key is stored; it was kept and must be resolved by a reviewer',
         answerData,
         stored: { source: key.source, answerData: key.answer_data },
      }
   }
   return { code: 'APPLIED', message: 'proposed key set', answerData }
}

// Pure: what --set-matching-rules does for one matching question. Each field is decided on
// its own, a boolean is never overwritten and allowRightReuse is never set to true.
function planMatchingRules(settings, leftKeys, pairs) {
   const current = {
      requireAllLeft: typeof settings?.requireAllLeft === 'boolean' ? settings.requireAllLeft : null,
      allowRightReuse: typeof settings?.allowRightReuse === 'boolean' ? settings.allowRightReuse : null,
   }
   const usedLeft = new Set(pairs.map((pair) => pair.left))
   const rights = pairs.map((pair) => pair.right)
   const requireAllLeft = current.requireAllLeft !== null
      ? 'REQUIRE_ALL_LEFT_SKIPPED_ALREADY_SET'
      : leftKeys.every((key) => usedLeft.has(key)) ? 'REQUIRE_ALL_LEFT_SET' : 'REQUIRE_ALL_LEFT_SKIPPED_NOT_COVERED'
   const allowRightReuse = current.allowRightReuse !== null
      ? 'RIGHT_REUSE_SKIPPED_ALREADY_SET'
      : new Set(rights).size === rights.length ? 'RIGHT_REUSE_SET_FALSE' : 'RIGHT_REUSE_SKIPPED_NOT_DISTINCT'
   const next = {
      requireAllLeft: requireAllLeft === 'REQUIRE_ALL_LEFT_SET' ? true : current.requireAllLeft,
      allowRightReuse: allowRightReuse === 'RIGHT_REUSE_SET_FALSE' ? false : current.allowRightReuse,
   }
   return {
      requireAllLeft,
      allowRightReuse,
      next,
      changed: next.requireAllLeft !== current.requireAllLeft || next.allowRightReuse !== current.allowRightReuse,
   }
}

function rulesFor(row, parts, outcome) {
   if (row?.question_type !== 'matching' || !['APPLIED', 'UNCHANGED'].includes(outcome.code)) return null
   const leftKeys = parts.matching.filter((item) => item.side === 'left').map((item) => item.item_key)
   return planMatchingRules(row.interaction_settings, leftKeys, outcome.answerData.pairs)
}

function outcomeEntry(item, questionId, outcome) {
   return {
      code: outcome.code,
      externalId: item.externalId,
      recordPath: item.path,
      questionId,
      message: outcome.message,
      ...(outcome.code === 'KEY_CONFLICT'
         ? { stored: outcome.stored, file: { source: item.source, answerData: outcome.answerData } }
         : {}),
   }
}

function ruleEntry(item, questionId, rules) {
   return {
      externalId: item.externalId,
      questionId,
      requireAllLeft: rules.requireAllLeft,
      allowRightReuse: rules.allowRightReuse,
      next: rules.next,
   }
}

function countRules(counters, entries) {
   for (const entry of entries) {
      for (const code of [entry.requireAllLeft, entry.allowRightReuse]) {
         const [field, key] = ruleCounters[code]
         counters.matchingRules[field][key] += 1
      }
   }
}

// stillNull and publishableBySettings cover every draft matching question of the bank.
function summarizeSettings(counters, states, projected = new Map()) {
   const summary = counters.matchingRules
   summary.requireAllLeft.stillNull = 0
   summary.allowRightReuse.stillNull = 0
   summary.matchingDrafts = 0
   summary.publishableBySettings = 0
   for (const state of states) {
      if (state.question_type !== 'matching' || state.status !== 'draft') continue
      const settings = projected.get(state.id) || state.interaction_settings || {}
      const requireAllLeft = typeof settings.requireAllLeft === 'boolean'
      const allowRightReuse = typeof settings.allowRightReuse === 'boolean'
      summary.matchingDrafts += 1
      if (!requireAllLeft) summary.requireAllLeft.stillNull += 1
      if (!allowRightReuse) summary.allowRightReuse.stillNull += 1
      if (requireAllLeft && allowRightReuse) summary.publishableBySettings += 1
   }
}

function missingKeys(states, records) {
   const keyed = new Set(records.map((record) => record.externalId))
   return states.filter((state) => !keyed.has(state.external_id)).map((state) => ({
      code: 'NO_KEY_FOR_QUESTION',
      externalId: state.external_id,
      recordPath: null,
      questionId: state.id,
      message: 'the file has no record for this question; it was not changed',
   }))
}

// --- Planner ------------------------------------------------------------------------------

async function resolveBank(deps, actor, bankCode, errors) {
   const bank = await deps.imports.findBankByCode(bankCode)
   if (!bank) {
      fileError(errors, 'QUESTION_BANK_NOT_FOUND', 'bankCode', `bank ${bankCode} does not exist; import the questions first`)
      return null
   }
   if (!actor.administrator && bank.owner_id !== actor.id) {
      fileError(errors, 'QUESTION_BANK_READ_ONLY', 'bankCode', `bank ${bankCode} belongs to another user`)
      return null
   }
   return bank
}

async function prepare(deps, actorIdValue, keyFile, options) {
   const actor = await loadImportActor(deps, actorIdValue)
   const settings = parseOptions(options)
   const idempotencyKey = parseIdempotencyKey(options.idempotencyKey, keyFile.sha256, settings.setMatchingRules)
   const parsed = parseKeyFile(keyFile.document, settings.bankCode)
   const bank = parsed.errors.length ? null : await resolveBank(deps, actor, parsed.header.bankCode, parsed.errors)
   return { actor, settings, idempotencyKey, parsed, bank }
}

async function planRecords(deps, bank, records, setMatchingRules) {
   const states = await deps.imports.listBankQuestionStates(bank.id)
   const byExternalId = new Map(states.filter((state) => state.external_id).map((state) => [state.external_id, state]))
   const items = []
   for (const record of records) {
      const state = byExternalId.get(record.externalId)
      const row = state ? await deps.questions.findQuestion(state.id) : null
      const parts = row ? await deps.questions.findQuestionParts(row.id) : null
      const outcome = classify(record, row, parts)
      items.push({
         record,
         questionId: row?.id ?? null,
         outcome,
         rules: setMatchingRules ? rulesFor(row, parts, outcome) : null,
      })
   }
   return { states, items }
}

function baseResult(keyFile, prepared) {
   return {
      fileSha256: keyFile.sha256,
      idempotencyKey: prepared.idempotencyKey,
      bankCode: prepared.parsed.header?.bankCode ?? null,
      sourcePackage: prepared.parsed.header?.sourcePackage ?? null,
      keySource: prepared.parsed.header?.keySource ?? null,
   }
}

function publicReport(extra, counters, outcomes, matchingRules, errors) {
   return {
      ...extra,
      counters,
      topOutcomeCodes: topCodes(outcomes),
      outcomes,
      matchingRules,
      errors,
   }
}

async function previousRun(deps, bank, idempotencyKey, fileSha256) {
   const run = await deps.imports.findRunByKey(bank.id, idempotencyKey)
   if (!run) return null
   if (run.package_sha256 !== fileSha256 || run.schema_version !== schemaVersion) {
      throw new AppError(409, 'IMPORT_IDEMPOTENCY_CONFLICT', 'This idempotency key was already used with another file', [
         { field: 'idempotencyKey', message: `run ${run.id} used another file` },
      ])
   }
   return run
}

// Validates and classifies every record and writes nothing; same report shape as a real run.
async function dryRunAnswerKeyImportService(actorIdValue, keyFile, options = {}, overrides) {
   const deps = dependencies(overrides)
   const prepared = await prepare(deps, actorIdValue, keyFile, options)
   const { settings, parsed, bank } = prepared
   const counters = emptyCounters(settings.batchSize, settings.setMatchingRules)
   const base = { mode: 'dry_run', ...baseResult(keyFile, prepared) }
   if (parsed.errors.length) {
      counters.errors = parsed.errors.length
      return publicReport({ ...base, valid: false, previousRunId: null }, counters, [], [], parsed.errors)
   }
   const previous = await previousRun(deps, bank, prepared.idempotencyKey, keyFile.sha256)
   const { states, items } = await planRecords(deps, bank, parsed.records, settings.setMatchingRules)
   counters.records = items.length
   const outcomes = items.map((item) => outcomeEntry(item.record, item.questionId, item.outcome))
   for (const entry of outcomes) counters.outcomes[entry.code] += 1
   const rules = items.filter((item) => item.rules).map((item) => ruleEntry(item.record, item.questionId, item.rules))
   countRules(counters, rules)
   summarizeSettings(counters, states, new Map(rules.map((entry) => [entry.questionId, entry.next])))
   const missing = missingKeys(states, parsed.records)
   counters.noKeyForQuestion = missing.length
   return publicReport(
      { ...base, valid: true, previousRunId: previous?.id ?? null },
      counters,
      [...outcomes, ...missing],
      rules,
      [],
   )
}

// --- Writer -------------------------------------------------------------------------------

async function writeRecord(deps, actor, bank, item, client, local, setMatchingRules) {
   const { record } = item
   const locked = await deps.imports.lockQuestionByExternalId(bank.id, record.externalId, client)
   const row = locked ? await deps.questions.findQuestion(locked.id, client) : null
   const parts = row ? await deps.questions.findQuestionParts(row.id, client) : null
   const outcome = classify(record, row, parts)
   // Inside the batch transaction: the same validation, draft rule and audit as the API.
   const scoped = { transaction: (work) => work(client) }
   if (outcome.code === 'APPLIED') {
      // An empty file explanation keeps an explanation an author already wrote on the draft.
      const explanation = record.explanation.blocks.length
         ? record.explanation
         : parts.answerKey?.explanation ?? { blocks: [] }
      await deps.replaceAnswerKey(actor.id, row.id, {
         answerData: outcome.answerData,
         source: record.source,
         explanation,
      }, scoped)
   }
   local.outcomes.push(outcomeEntry(record, row?.id ?? null, outcome))
   const rules = setMatchingRules ? rulesFor(row, parts, outcome) : null
   if (!rules) return
   if (rules.changed) {
      await deps.updateQuestion(actor.id, row.id, { interactionSettings: rules.next }, scoped)
   }
   local.rules.push(ruleEntry(record, row.id, rules))
}

function storedEntries(outcomes) {
   return outcomes.filter((entry) => !['APPLIED', 'UNCHANGED'].includes(entry.code)).map((entry) => ({
      severity: 'warning',
      code: entry.code,
      path: entry.recordPath,
      // Messages only; answer data stays out of stored run entries.
      message: entry.message,
      externalId: entry.externalId,
   }))
}

function replayResult(run, keyFile, prepared) {
   return {
      mode: 'import',
      replayed: true,
      status: run.status,
      runId: run.id,
      ...baseResult(keyFile, prepared),
      counters: run.counters,
      topOutcomeCodes: [],
      outcomes: [],
      matchingRules: [],
      errors: [],
   }
}

async function runAnswerKeyImportService(actorIdValue, keyFile, options = {}, overrides) {
   const deps = dependencies(overrides)
   const prepared = await prepare(deps, actorIdValue, keyFile, options)
   const { actor, settings, parsed, bank, idempotencyKey } = prepared
   const counters = emptyCounters(settings.batchSize, settings.setMatchingRules)
   const base = { mode: 'import', ...baseResult(keyFile, prepared) }
   if (parsed.errors.length) {
      counters.errors = parsed.errors.length
      return publicReport({ ...base, status: 'rejected', runId: null }, counters, [], [], parsed.errors)
   }
   const previous = await previousRun(deps, bank, idempotencyKey, keyFile.sha256)
   if (previous) return replayResult(previous, keyFile, prepared)

   const { states, items } = await planRecords(deps, bank, parsed.records, settings.setMatchingRules)
   const missing = missingKeys(states, parsed.records)
   counters.records = items.length
   counters.noKeyForQuestion = missing.length
   let runId
   try {
      runId = await deps.transaction(async (client) => {
         const id = await deps.imports.insertRun({
            bankId: bank.id,
            initiatedBy: actor.id,
            packageSha256: keyFile.sha256,
            schemaVersion,
            idempotencyKey,
            manifest: {
               kind: 'answer_keys',
               schemaVersion,
               bankCode: parsed.header.bankCode,
               sourcePackage: parsed.header.sourcePackage,
               keySource: parsed.header.keySource,
               records: items.length,
               setMatchingRules: settings.setMatchingRules,
            },
            counters,
         }, client)
         await deps.imports.insertRunErrors(id, storedEntries(missing), client)
         await deps.auth.appendAuditEvent({
            actorUserId: actor.id,
            subjectUserId: null,
            code: 'answer_key_import.started',
            entityType: 'question_import',
            entityId: id,
            metadata: { bankId: bank.id, records: items.length, setMatchingRules: settings.setMatchingRules },
         }, client)
         return id
      })
   } catch (error) {
      if (error.code === '23505' && error.constraint === 'question_imports_bank_id_idempotency_key_key') {
         const raced = await previousRun(deps, bank, idempotencyKey, keyFile.sha256)
         if (raced) return replayResult(raced, keyFile, prepared)
      }
      throw error
   }
   deps.log('answer-key import started', { runId, records: items.length })

   const outcomes = []
   const rules = []
   const errors = []
   let failed = false
   for (let start = 0; start < items.length; start += settings.batchSize) {
      const batch = items.slice(start, start + settings.batchSize)
      if (failed) {
         counters.recordsNotAttempted += batch.length
         continue
      }
      const local = { outcomes: [], rules: [], current: null }
      try {
         await deps.transaction(async (client) => {
            for (const item of batch) {
               local.current = item
               await writeRecord(deps, actor, bank, item, client, local, settings.setMatchingRules)
            }
            local.current = null
            const next = structuredClone(counters)
            for (const entry of local.outcomes) next.outcomes[entry.code] += 1
            countRules(next, local.rules)
            next.batches.committed += 1
            await deps.imports.updateRunProgress(runId, next, client)
            await deps.auth.appendAuditEvent({
               actorUserId: actor.id,
               subjectUserId: null,
               code: 'answer_key_import.batch_committed',
               entityType: 'question_import',
               entityId: runId,
               metadata: {
                  applied: local.outcomes.filter((entry) => entry.code === 'APPLIED').length,
                  skipped: local.outcomes.filter((entry) => entry.code !== 'APPLIED').length,
                  rulesChanged: local.rules.filter((entry) => entry.requireAllLeft === 'REQUIRE_ALL_LEFT_SET'
                     || entry.allowRightReuse === 'RIGHT_REUSE_SET_FALSE').length,
               },
            }, client)
         })
         for (const entry of local.outcomes) counters.outcomes[entry.code] += 1
         countRules(counters, local.rules)
         counters.batches.committed += 1
         outcomes.push(...local.outcomes)
         rules.push(...local.rules)
         await deps.imports.insertRunErrors(runId, storedEntries(local.outcomes))
      } catch (error) {
         failed = true
         counters.batches.failed += 1
         counters.recordsFailed += batch.length
         counters.errors += 1
         const entry = {
            severity: 'error',
            code: error instanceof AppError ? error.code : 'IMPORT_BATCH_FAILED',
            path: `records[${batch[0].record.index}..${batch[batch.length - 1].record.index}]`,
            message: error instanceof AppError
               ? `batch rolled back: ${error.details?.[0]?.message || error.message}`
               : `batch rolled back: database error ${error.code || 'unknown'}`,
            externalId: local.current?.record.externalId ?? null,
         }
         errors.push(entry)
         await deps.imports.insertRunErrors(runId, [entry])
         deps.log('answer-key import batch failed', { runId, code: entry.code })
      }
   }
   summarizeSettings(counters, await deps.imports.listBankQuestionStates(bank.id))
   const status = failed ? 'failed' : 'completed'
   await deps.transaction(async (client) => {
      await deps.imports.finishRun(runId, status, counters, client)
      await deps.auth.appendAuditEvent({
         actorUserId: actor.id,
         subjectUserId: null,
         code: `answer_key_import.${status}`,
         entityType: 'question_import',
         entityId: runId,
         metadata: {
            applied: counters.outcomes.APPLIED,
            conflicts: counters.outcomes.KEY_CONFLICT,
            failed: counters.recordsFailed,
         },
      }, client)
   })
   deps.log('answer-key import finished', { runId, status })
   return publicReport({ ...base, status, replayed: false, runId, bankId: bank.id }, counters, [...outcomes, ...missing], rules, errors)
}

export { canonicalAnswer, parseKeyFile, planMatchingRules }

export { dryRunAnswerKeyImportService, runAnswerKeyImportService }
