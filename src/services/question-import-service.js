import { createHash } from 'node:crypto'

import { getStorageProvider } from '../providers/storage/index.js'
import * as authRepository from '../repositories/auth-repository.js'
import * as authorizationRepository from '../repositories/authorization-repository.js'
import * as questionBankRepository from '../repositories/question-bank-repository.js'
import * as questionImportRepository from '../repositories/question-import-repository.js'
import * as taxonomyRepository from '../repositories/taxonomy-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import AppError from '../utils/app-error.js'
import { normalizePhone } from '../utils/auth-input.js'
import { normalizeInternalId } from '../utils/internal-id.js'
import { inspectMedia, MediaRejection, mimeTypes } from '../utils/media-inspection.js'
import {
   isPlainObject,
   parseAnswerData,
   parseContent,
   parseSourceMetadata,
   questionTypes,
} from '../utils/question-content.js'
import { packageFile, sha256 } from '../utils/question-package.js'
import { parsePagination, validateBody, validationError } from './course-service.js'
import { canManage, keyShape, parseQuestionBody, reconcileAnswerKey } from './question-bank-service.js'

// M09 importer for `everest.question-import.v1` packages. One planner validates the whole
// package read-only; a dry run returns its report, a real run executes the same plan.
// Imports only ever create or replace DRAFT questions and never verify answer keys.

const schemaVersion = 'everest.question-import.v1'
const mib = 1024 * 1024
const maxQuestions = 20000
const maxAssets = 20000
const maxBatchSize = 100
const maxImageBytes = 10 * mib
const languages = ['tg', 'ru', 'en']
const subjectColors = ['green', 'blue', 'orange', 'purple', 'neutral']
const taxonomyCodePattern = /^[a-z0-9][a-z0-9_-]{0,49}$/
const bankCodePattern = /^[a-z0-9][a-z0-9_-]{0,99}$/
const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{1,200}$/
const namespacePattern = /^[a-z0-9][a-z0-9:._-]{0,99}$/
const assetIdPattern = /^[A-Za-z0-9._:/-]{1,200}$/
const proposalSources = ['official_key', 'expert_review', 'ai_inference']
const imageTypes = [mimeTypes.png, mimeTypes.jpg]
const runStatuses = ['pending', 'validating', 'validated', 'importing', 'completed', 'failed']
const duplicateReason = 'import: same normalized text and options'
const manifestFields = ['schemaVersion', 'sourceNamespace', 'subjects', 'sections', 'topics', 'bank', 'assets', 'questions']
const questionPackageFields = [
   'externalId',
   'type',
   'language',
   'difficulty',
   'difficultySource',
   'content',
   'interactionSettings',
   'options',
   'matching',
   'topicCodes',
   'source',
   'answerKey',
   'translations',
]

function dependencies(overrides = {}) {
   return {
      questions: overrides.questions || questionBankRepository,
      imports: overrides.imports || questionImportRepository,
      taxonomy: overrides.taxonomy || taxonomyRepository,
      authorization: overrides.authorization || authorizationRepository,
      auth: overrides.auth || authRepository,
      transaction: overrides.transaction || withTransaction,
      storage: overrides.storage,
      log: overrides.log || (() => {}),
   }
}

// --- Report -----------------------------------------------------------------------------

function emptyCounters() {
   const entity = () => ({ created: 0, updated: 0, unchanged: 0 })
   return {
      subjects: entity(),
      sections: entity(),
      topics: entity(),
      bank: { created: 0, existing: 0 },
      assets: { total: 0, uploaded: 0, reusedByAlias: 0, reusedByHash: 0 },
      questions: { total: 0, created: 0, updated: 0, skippedImmutable: 0, failed: 0, notAttempted: 0 },
      answerKeys: { unknown: 0, proposed: 0, keptExisting: 0 },
      duplicates: { suggested: 0 },
      batches: { size: 0, committed: 0, failed: 0 },
      warnings: 0,
      errors: 0,
   }
}

function createReport() {
   return { errors: [], warnings: [], counters: emptyCounters() }
}

function addIssue(report, severity, code, path, message, externalId = null) {
   const entry = { severity, code, path, message, externalId }
   if (severity === 'error') report.errors.push(entry)
   else report.warnings.push(entry)
   report.counters[severity === 'error' ? 'errors' : 'warnings'] += 1
}

// Fields of package errors are either absolute (`bank.code`) or relative to `path`.
function issueFromError(report, error, path, externalId = null) {
   if (!(error instanceof AppError)) throw error
   const detail = error.details?.[0]
   const field = detail?.field
   const fullPath = !field ? path : !path ? field : path.endsWith(field) ? path : `${path}.${field}`
   addIssue(report, 'error', error.code, fullPath || 'manifest', detail?.message || error.message, externalId)
}

function topCodes(entries, limit = 10) {
   const counts = new Map()
   for (const entry of entries) counts.set(entry.code, (counts.get(entry.code) || 0) + 1)
   return [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, limit)
      .map(([code, count]) => ({ code, count }))
}

function packageError(code, message, field) {
   return new AppError(400, code, message, field ? [{ field, message }] : [])
}

// --- Actor ------------------------------------------------------------------------------

async function loadActor(deps, actorIdValue) {
   const actorId = normalizeInternalId(actorIdValue)
   const actor = await deps.imports.findActorById(actorId)
   if (!actor) throw new AppError(403, 'IMPORT_ACTOR_FORBIDDEN', 'Import actor does not exist')
   if (actor.status !== 'active') throw new AppError(403, 'IMPORT_ACTOR_INACTIVE', 'Import actor account is not active')
   if (!await deps.authorization.hasPermission(actorId, 'questions.manage')) {
      throw new AppError(403, 'IMPORT_ACTOR_FORBIDDEN', 'Import actor needs the questions.manage permission')
   }
   return {
      id: actorId,
      administrator: await deps.imports.isAdministrator(actorId),
      canManageTaxonomy: await deps.authorization.hasPermission(actorId, 'taxonomy.manage'),
   }
}

async function resolveImportActorService(phone, overrides) {
   const deps = dependencies(overrides)
   const actor = await deps.imports.findActorByPhone(normalizePhone(phone))
   if (!actor) throw new AppError(403, 'IMPORT_ACTOR_FORBIDDEN', 'No account uses this phone number')
   return (await loadActor(deps, actor.id)).id
}

// --- Package parsing ---------------------------------------------------------------------

function optionalArray(value, field, maximum) {
   if (value === undefined) return []
   if (!Array.isArray(value) || value.length > maximum) {
      throw packageError('PACKAGE_SCHEMA_INVALID', `${field} must be an array of at most ${maximum} items`, field)
   }
   return value
}

function requireFields(value, allowed, path) {
   if (!isPlainObject(value)) {
      throw packageError('PACKAGE_SCHEMA_INVALID', `${path || 'value'} must be an object`, path || undefined)
   }
   const unknown = Object.keys(value).find((key) => !allowed.includes(key))
   if (unknown) throw packageError('PACKAGE_FIELD_UNKNOWN', `${unknown} is not allowed`, path ? `${path}.${unknown}` : unknown)
}

function parseTitleTranslations(value, primaryLanguage, path) {
   if (!isPlainObject(value)) throw packageError('PACKAGE_SCHEMA_INVALID', 'translations must be an object', path)
   const parsed = {}
   for (const [language, translation] of Object.entries(value)) {
      if (!languages.includes(language) || !isPlainObject(translation)
         || Object.keys(translation).join() !== 'title' || typeof translation.title !== 'string'
         || !translation.title.trim() || translation.title.trim().length > 200) {
         throw packageError('PACKAGE_SCHEMA_INVALID', 'translations must map tg|ru|en to { title }', path)
      }
      parsed[language] = { title: translation.title.trim() }
   }
   if (!parsed[primaryLanguage]) {
      throw packageError('PACKAGE_SCHEMA_INVALID', 'translations must include the primary language title', path)
   }
   return parsed
}

function parseCode(value, pattern, path) {
   if (typeof value !== 'string' || !pattern.test(value)) {
      throw packageError('PACKAGE_SCHEMA_INVALID', 'code is invalid', path)
   }
   return value
}

function parseTaxonomyEntry(kind, raw, path) {
   const allowed = ['code', 'primaryLanguage', 'translations']
   if (kind !== 'subject') allowed.push('subjectCode')
   if (kind === 'subject') allowed.push('color')
   if (kind === 'topic') allowed.push('sectionCode', 'parentCode')
   requireFields(raw, allowed, path)
   const primaryLanguage = raw.primaryLanguage ?? 'tg'
   if (!languages.includes(primaryLanguage)) {
      throw packageError('PACKAGE_SCHEMA_INVALID', 'primaryLanguage is invalid', `${path}.primaryLanguage`)
   }
   const color = raw.color ?? 'neutral'
   if (kind === 'subject' && !subjectColors.includes(color)) {
      throw packageError('PACKAGE_SCHEMA_INVALID', 'color is invalid', `${path}.color`)
   }
   const optionalCode = (field) => (raw[field] === undefined || raw[field] === null
      ? null
      : parseCode(raw[field], taxonomyCodePattern, `${path}.${field}`))
   return {
      path,
      code: parseCode(raw.code, taxonomyCodePattern, `${path}.code`),
      subjectCode: kind === 'subject' ? null : parseCode(raw.subjectCode, taxonomyCodePattern, `${path}.subjectCode`),
      sectionCode: kind === 'topic' ? optionalCode('sectionCode') : null,
      parentCode: kind === 'topic' ? optionalCode('parentCode') : null,
      primaryLanguage,
      color,
      translations: parseTitleTranslations(raw.translations, primaryLanguage, `${path}.translations`),
   }
}

function translationsDiffer(stored, wanted) {
   return Object.entries(wanted).some(([language, { title }]) => stored?.[language]?.title !== title)
}

// --- Taxonomy and bank planning ------------------------------------------------------------

function requireTaxonomyPermission(report, actor, path, kind, code) {
   if (actor.canManageTaxonomy) return true
   addIssue(report, 'error', 'TAXONOMY_PERMISSION_REQUIRED', path,
      `${kind} ${code} does not exist and creating it needs taxonomy.manage`)
   return false
}

function planTranslationUpdate(report, actor, entry, existing, kind, counters) {
   if (!translationsDiffer(existing.translations, entry.translations)) {
      counters.unchanged += 1
      return 'unchanged'
   }
   if (!actor.canManageTaxonomy) {
      addIssue(report, 'warning', 'TAXONOMY_TRANSLATION_SKIPPED', `${entry.path}.translations`,
         `${kind} ${entry.code} titles differ; taxonomy.manage is needed to update them`)
      counters.unchanged += 1
      return 'unchanged'
   }
   counters.updated += 1
   return 'update'
}

async function planTaxonomy(deps, actor, manifest, report) {
   const subjects = new Map()
   const sections = new Map()
   const topics = new Map()
   const key = (subjectCode, code) => `${subjectCode}\u0000${code}`

   for (const [index, raw] of optionalArray(manifest.subjects, 'subjects', 100).entries()) {
      const path = `subjects[${index}]`
      try {
         const entry = parseTaxonomyEntry('subject', raw, path)
         if (subjects.has(entry.code)) {
            addIssue(report, 'error', 'TAXONOMY_CODE_DUPLICATE', `${path}.code`, `subject ${entry.code} appears twice`)
            continue
         }
         const existing = await deps.taxonomy.findEntityByCode('subject', entry.code, null)
         entry.id = existing?.id || null
         if (!existing) {
            if (requireTaxonomyPermission(report, actor, path, 'subject', entry.code)) report.counters.subjects.created += 1
            entry.action = 'create'
         } else {
            if (existing.primary_language !== entry.primaryLanguage || existing.color !== entry.color) {
               addIssue(report, 'warning', 'TAXONOMY_FIELD_MISMATCH', path,
                  `subject ${entry.code} keeps its stored primaryLanguage and color`)
            }
            entry.action = planTranslationUpdate(report, actor, entry, existing, 'subject', report.counters.subjects)
         }
         subjects.set(entry.code, entry)
      } catch (error) {
         issueFromError(report, error, '')
      }
   }

   // Subjects referenced by code but absent from the package must already exist.
   async function resolveSubject(code, path) {
      if (subjects.has(code)) return subjects.get(code)
      const existing = await deps.taxonomy.findEntityByCode('subject', code, null)
      if (!existing) {
         addIssue(report, 'error', 'REFERENCE_UNKNOWN', path, `subject ${code} is not in the package or the database`)
         return null
      }
      const entry = { code, id: existing.id, action: 'reference', primaryLanguage: existing.primary_language }
      subjects.set(code, entry)
      return entry
   }

   for (const [index, raw] of optionalArray(manifest.sections, 'sections', 1000).entries()) {
      const path = `sections[${index}]`
      try {
         const entry = parseTaxonomyEntry('section', raw, path)
         const subject = await resolveSubject(entry.subjectCode, `${path}.subjectCode`)
         if (!subject) continue
         if (sections.has(key(entry.subjectCode, entry.code))) {
            addIssue(report, 'error', 'TAXONOMY_CODE_DUPLICATE', `${path}.code`, `section ${entry.code} appears twice`)
            continue
         }
         const existing = subject.id ? await deps.taxonomy.findEntityByCode('section', entry.code, subject.id) : null
         entry.id = existing?.id || null
         if (!existing) {
            if (requireTaxonomyPermission(report, actor, path, 'section', entry.code)) report.counters.sections.created += 1
            entry.action = 'create'
         } else {
            entry.action = planTranslationUpdate(report, actor, entry, existing, 'section', report.counters.sections)
         }
         sections.set(key(entry.subjectCode, entry.code), entry)
      } catch (error) {
         issueFromError(report, error, '')
      }
   }

   const packageTopics = []
   for (const [index, raw] of optionalArray(manifest.topics, 'topics', 10000).entries()) {
      const path = `topics[${index}]`
      try {
         const entry = parseTaxonomyEntry('topic', raw, path)
         const subject = await resolveSubject(entry.subjectCode, `${path}.subjectCode`)
         if (!subject) continue
         if (topics.has(key(entry.subjectCode, entry.code))) {
            addIssue(report, 'error', 'TAXONOMY_CODE_DUPLICATE', `${path}.code`, `topic ${entry.code} appears twice`)
            continue
         }
         topics.set(key(entry.subjectCode, entry.code), entry)
         packageTopics.push(entry)
      } catch (error) {
         issueFromError(report, error, '')
      }
   }

   // References: section and parent may come from the package or the database, same subject.
   const existingTopic = async (subjectCode, code) => {
      const subject = subjects.get(subjectCode)
      return subject?.id ? deps.taxonomy.findEntityByCode('topic', code, subject.id) : null
   }
   for (const entry of packageTopics) {
      const subject = subjects.get(entry.subjectCode)
      if (entry.sectionCode && !sections.has(key(entry.subjectCode, entry.sectionCode))) {
         const section = subject.id
            ? await deps.taxonomy.findEntityByCode('section', entry.sectionCode, subject.id)
            : null
         if (!section) {
            addIssue(report, 'error', 'REFERENCE_UNKNOWN', `${entry.path}.sectionCode`,
               `section ${entry.sectionCode} is not in subject ${entry.subjectCode}`)
            entry.invalid = true
         } else {
            sections.set(key(entry.subjectCode, entry.sectionCode), {
               code: entry.sectionCode, id: section.id, action: 'reference',
            })
         }
      }
      if (entry.parentCode && !topics.has(key(entry.subjectCode, entry.parentCode))) {
         const parent = await existingTopic(entry.subjectCode, entry.parentCode)
         if (!parent) {
            addIssue(report, 'error', 'REFERENCE_UNKNOWN', `${entry.path}.parentCode`,
               `topic ${entry.parentCode} is not in subject ${entry.subjectCode}`)
            entry.invalid = true
         } else {
            topics.set(key(entry.subjectCode, entry.parentCode), {
               code: entry.parentCode, subjectCode: entry.subjectCode, id: parent.id, action: 'reference',
            })
         }
      }
      const existing = await existingTopic(entry.subjectCode, entry.code)
      entry.id = existing?.id || null
      if (!existing) {
         if (requireTaxonomyPermission(report, actor, entry.path, 'topic', entry.code)) report.counters.topics.created += 1
         entry.action = 'create'
      } else {
         const sectionId = entry.sectionCode ? sections.get(key(entry.subjectCode, entry.sectionCode))?.id : null
         const parentId = entry.parentCode ? topics.get(key(entry.subjectCode, entry.parentCode))?.id : null
         if (existing.primary_language !== entry.primaryLanguage
            || (sectionId ?? null) !== existing.section_id || (parentId ?? null) !== existing.parent_id) {
            addIssue(report, 'warning', 'TAXONOMY_FIELD_MISMATCH', entry.path,
               `topic ${entry.code} keeps its stored primaryLanguage, section and parent`)
         }
         entry.action = planTranslationUpdate(report, actor, entry, existing, 'topic', report.counters.topics)
      }
   }

   // Parents first; a cycle among new package topics is rejected.
   const ordered = []
   const state = new Map()
   function visit(entry) {
      const id = key(entry.subjectCode, entry.code)
      if (state.get(id) === 'done') return
      if (state.get(id) === 'visiting') {
         addIssue(report, 'error', 'TOPIC_CYCLE', `${entry.path}.parentCode`, `topic ${entry.code} is part of a parent cycle`)
         entry.invalid = true
         return
      }
      state.set(id, 'visiting')
      const parent = entry.parentCode ? topics.get(key(entry.subjectCode, entry.parentCode)) : null
      if (parent?.path && parent.action === 'create') visit(parent)
      state.set(id, 'done')
      ordered.push(entry)
   }
   for (const entry of packageTopics) visit(entry)

   return { subjects, sections, topics, orderedTopics: ordered, key }
}

async function planBank(deps, actor, manifest, taxonomy, report) {
   try {
      requireFields(manifest.bank, ['code', 'title', 'subjectCode', 'visibility', 'source'], 'bank')
      const bank = manifest.bank
      const code = parseCode(bank.code, bankCodePattern, 'bank.code')
      if (typeof bank.title !== 'string' || !bank.title.trim() || bank.title.trim().length > 200) {
         throw packageError('PACKAGE_SCHEMA_INVALID', 'title is invalid', 'bank.title')
      }
      const visibility = bank.visibility ?? 'private'
      if (!['private', 'staff'].includes(visibility)) {
         throw packageError('PACKAGE_SCHEMA_INVALID', 'visibility is invalid', 'bank.visibility')
      }
      const subjectCode = parseCode(bank.subjectCode, taxonomyCodePattern, 'bank.subjectCode')
      let subject = taxonomy.subjects.get(subjectCode)
      if (!subject) {
         const existing = await deps.taxonomy.findEntityByCode('subject', subjectCode, null)
         if (!existing) {
            addIssue(report, 'error', 'REFERENCE_UNKNOWN', 'bank.subjectCode', `subject ${subjectCode} is not in the package or the database`)
            return null
         }
         subject = { code: subjectCode, id: existing.id, action: 'reference' }
         taxonomy.subjects.set(subjectCode, subject)
      }
      const plan = {
         code,
         title: bank.title.trim(),
         visibility,
         subjectCode,
         sourceMetadata: bank.source === undefined ? {} : parseSourceMetadata(bank.source),
         existing: await deps.imports.findBankByCode(code),
      }
      if (plan.existing) {
         report.counters.bank.existing = 1
         if (!actor.administrator && plan.existing.owner_id !== actor.id) {
            addIssue(report, 'error', 'QUESTION_BANK_READ_ONLY', 'bank.code', `bank ${code} belongs to another user`)
         }
         if (plan.existing.subject_id !== subject.id) {
            addIssue(report, 'error', 'BANK_SUBJECT_MISMATCH', 'bank.subjectCode', `bank ${code} belongs to another subject`)
         }
         if (plan.existing.title !== plan.title || plan.existing.visibility !== visibility) {
            addIssue(report, 'warning', 'BANK_FIELD_MISMATCH', 'bank', `bank ${code} keeps its stored title and visibility`)
         }
      } else {
         report.counters.bank.created = 1
      }
      return plan
   } catch (error) {
      issueFromError(report, error, '')
      return null
   }
}

// --- Assets planning ---------------------------------------------------------------------

async function planAssets(deps, manifest, files, namespace, report) {
   const assets = new Map()
   const entries = optionalArray(manifest.assets, 'assets', maxAssets)
   report.counters.assets.total = entries.length
   for (const [index, raw] of entries.entries()) {
      const path = `assets[${index}]`
      try {
         requireFields(raw, ['id', 'file', 'mimeType', 'sha256', 'fileName'], path)
         if (typeof raw.id !== 'string' || !assetIdPattern.test(raw.id)) {
            throw packageError('PACKAGE_SCHEMA_INVALID', 'id is invalid', `${path}.id`)
         }
         if (assets.has(raw.id)) {
            addIssue(report, 'error', 'ASSET_ID_DUPLICATE', `${path}.id`, `asset ${raw.id} appears twice`)
            continue
         }
         const bytes = packageFile(files, raw.file)
         if (!bytes) {
            addIssue(report, 'error', 'ASSET_FILE_MISSING', `${path}.file`, `asset ${raw.id} file is not in the package`)
            continue
         }
         if (!imageTypes.includes(raw.mimeType)) {
            addIssue(report, 'error', 'ASSET_TYPE_INVALID', `${path}.mimeType`, 'only image/png and image/jpeg are accepted')
            continue
         }
         if (bytes.length > maxImageBytes) {
            addIssue(report, 'error', 'ASSET_TOO_LARGE', `${path}.file`, `asset ${raw.id} exceeds 10 MiB`)
            continue
         }
         let media
         try {
            media = await inspectMedia({
               read: async (start, end) => bytes.subarray(start, end + 1),
               size: bytes.length,
               kind: 'material',
               declaredMimeType: raw.mimeType,
            })
         } catch (error) {
            if (!(error instanceof MediaRejection)) throw error
            addIssue(report, 'error', 'ASSET_TYPE_INVALID', `${path}.file`, `asset ${raw.id} content is not a valid ${raw.mimeType}`)
            continue
         }
         const hash = sha256(bytes)
         if (raw.sha256 !== undefined && raw.sha256 !== hash) {
            addIssue(report, 'error', 'ASSET_HASH_MISMATCH', `${path}.sha256`, `asset ${raw.id} bytes do not match the declared sha256`)
            continue
         }
         const fileName = typeof raw.fileName === 'string' && raw.fileName.trim()
            ? raw.fileName.trim().slice(0, 255)
            : String(raw.file).split('/').pop().slice(0, 255)
         assets.set(raw.id, {
            id: raw.id,
            path,
            bytes,
            sha256: hash,
            mimeType: media.mimeType,
            widthPx: media.widthPx,
            heightPx: media.heightPx,
            fileName,
            used: false,
            action: 'upload',
            assetId: null,
         })
      } catch (error) {
         issueFromError(report, error, '')
      }
   }
   if (!assets.size) return assets

   for (const alias of await deps.imports.findAliases(namespace, [...assets.keys()])) {
      const asset = assets.get(alias.external_id)
      if (alias.sha256 !== asset.sha256) {
         addIssue(report, 'error', 'ASSET_ALIAS_CONFLICT', asset.path,
            `asset ${asset.id} was imported earlier with different bytes in namespace ${namespace}`)
         asset.invalid = true
      } else if (alias.status !== 'ready' || !imageTypes.includes(alias.mime_type)) {
         addIssue(report, 'error', 'ASSET_NOT_USABLE', asset.path, `asset ${asset.id} is no longer usable`)
         asset.invalid = true
      } else {
         asset.action = 'alias'
         asset.assetId = alias.asset_id
      }
   }
   const pending = [...assets.values()].filter((asset) => asset.action === 'upload' && !asset.invalid)
   const byHash = new Map((await deps.imports.findAssetsBySha256([...new Set(pending.map((asset) => asset.sha256))]))
      .map((row) => [row.sha256, row]))
   for (const asset of pending) {
      const stored = byHash.get(asset.sha256)
      if (!stored) continue
      if (stored.status !== 'ready' || !imageTypes.includes(stored.mime_type)) {
         addIssue(report, 'error', 'ASSET_NOT_USABLE', asset.path, `asset ${asset.id} matches a stored file that is not usable`)
         asset.invalid = true
      } else {
         asset.action = 'hash'
         asset.assetId = stored.id
      }
   }
   return assets
}

// --- Question planning ---------------------------------------------------------------------

// Package image blocks reference package-local assets (`{ type: 'image', asset, alt }`).
// They are rewritten to `{ assetId }` before the shared rich-content parser runs.
function resolveContent(value, resolveAsset, warn) {
   if (!isPlainObject(value) || !Array.isArray(value.blocks)) return value
   return {
      ...value,
      blocks: value.blocks.map((block) => {
         if (!isPlainObject(block)) return block
         if (block.type === 'image') {
            if (block.assetId !== undefined) {
               throw packageError('IMAGE_REFERENCE_INVALID', 'image blocks must reference package assets with "asset"', 'content')
            }
            const { asset, ...rest } = block
            return { ...rest, assetId: resolveAsset(asset) }
         }
         if (block.type === 'table' && block.header !== undefined) {
            warn('CONTENT_TABLE_HEADER_FLATTENED', 'table header flag is not supported; the header row is kept as a normal row')
            const { header, ...rest } = block
            void header
            return rest
         }
         return block
      }),
   }
}

function mapItems(items, path) {
   if (!Array.isArray(items)) return items
   return items.map((item, index) => {
      if (!isPlainObject(item)) return item
      if (item.isCorrect !== undefined) {
         throw packageError('OPTION_IS_CORRECT_REJECTED', 'correctness belongs in answerKey, not in items', `${path}[${index}].isCorrect`)
      }
      const { label, ...rest } = item
      return { ...rest, ...(label === undefined ? {} : { sourceLabel: label }) }
   })
}

function parseExternalId(value) {
   if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) return null
   return value.trim()
}

function parseTopicCodes(value) {
   if (value === undefined) return []
   if (!Array.isArray(value) || value.length > 20 || value.some((code) => typeof code !== 'string')
      || new Set(value).size !== value.length) {
      throw packageError('PACKAGE_SCHEMA_INVALID', 'topicCodes must be at most 20 distinct codes', 'topicCodes')
   }
   return value
}

// Converts one package question into the M08 API body and runs the M08 parsers on it.
// Called by the planner (placeholder asset IDs) and again by the writer (real IDs).
function prepareQuestion(raw, { resolveAsset, topicIds, warn }) {
   requireFields(raw, questionPackageFields, '')
   if (!questionTypes.includes(raw.type)) throw validationError('type')
   if (raw.translations !== undefined) {
      warn('QUESTION_TRANSLATIONS_IGNORED', 'per-question translations are not supported; only the question language is imported')
   }
   const resolve = (value) => resolveContent(value, resolveAsset, warn)
   const body = {
      externalId: parseExternalId(raw.externalId),
      questionType: raw.type,
      languageCode: raw.language ?? 'tg',
      ...(raw.difficulty === undefined ? {} : { difficulty: raw.difficulty }),
      ...(raw.difficultySource === undefined ? {} : { difficultySource: raw.difficultySource }),
      content: resolve(raw.content),
      ...(raw.interactionSettings === undefined ? {} : { interactionSettings: raw.interactionSettings }),
      sourceMetadata: raw.source ?? {},
      topicIds,
   }
   const items = (list, path) => (Array.isArray(list)
      ? mapItems(list, path).map((item) => (isPlainObject(item) ? { ...item, content: resolve(item.content) } : item))
      : list)
   if (raw.options !== undefined) body.options = items(raw.options, 'options')
   if (raw.matching !== undefined) {
      body.matching = isPlainObject(raw.matching)
         ? Object.fromEntries(Object.entries(raw.matching).map(([side, list]) => [side, items(list, `matching.${side}`)]))
         : raw.matching
   }
   const values = parseQuestionBody(body, raw.type, false)
   const shape = keyShape(
      { question_type: raw.type, interaction_settings: values.interactionSettings },
      {
         options: (values.options || []).map((option) => ({ option_key: option.key })),
         matching: values.matching
            ? [
               ...values.matching.left.map((item) => ({ side: 'left', item_key: item.key })),
               ...values.matching.right.map((item) => ({ side: 'right', item_key: item.key })),
            ]
            : [],
      },
   )
   return { values, answerKey: prepareAnswerKey(raw.answerKey, shape, resolve, warn) }
}

function prepareAnswerKey(raw, shape, resolve, warn) {
   if (raw === undefined || raw === null) return { status: 'unknown', source: 'none', answerData: null, explanation: { blocks: [] } }
   requireFields(raw, ['status', 'source', 'answerData', 'explanation', 'tolerance', 'normalization'], 'answerKey')
   if (raw.tolerance !== undefined || raw.normalization !== undefined) {
      warn('GRADING_RULE_IGNORED', 'grading tolerance and normalization are not supported yet and were not imported')
   }
   const explanation = raw.explanation === undefined
      ? { blocks: [] }
      : parseContent(resolve(raw.explanation), 'explanation', new Set(), { allowEmpty: true })
   if (raw.status === 'verified') {
      throw packageError('ANSWER_KEY_VERIFIED_REJECTED', 'packages cannot carry verified keys; verification is a reviewer action', 'answerKey.status')
   }
   if (raw.status === 'unknown') {
      if ((raw.answerData !== undefined && raw.answerData !== null) || (raw.source !== undefined && raw.source !== 'none')) {
         throw packageError('ANSWER_KEY_STATUS_INVALID', 'an unknown key carries no answerData or source', 'answerKey')
      }
      return { status: 'unknown', source: 'none', answerData: null, explanation }
   }
   if (raw.status === 'proposed') {
      if (!proposalSources.includes(raw.source)) {
         throw packageError('ANSWER_KEY_STATUS_INVALID', 'a proposed key needs source official_key, expert_review or ai_inference', 'answerKey.source')
      }
      return { status: 'proposed', source: raw.source, answerData: parseAnswerData(raw.answerData, shape), explanation }
   }
   throw packageError('ANSWER_KEY_STATUS_INVALID', 'answerKey.status must be unknown or proposed', 'answerKey.status')
}

async function planQuestions(deps, manifest, context, report) {
   const rawQuestions = optionalArray(manifest.questions, 'questions', maxQuestions)
   report.counters.questions.total = rawQuestions.length
   const items = []
   const seen = new Map()
   for (const [index, raw] of rawQuestions.entries()) {
      const path = `questions[${index}]`
      const externalId = isPlainObject(raw) ? parseExternalId(raw.externalId) : null
      if (!externalId) {
         addIssue(report, 'error', 'QUESTION_EXTERNAL_ID_REQUIRED', `${path}.externalId`, 'imported questions need a non-empty externalId (≤200)')
         continue
      }
      if (seen.has(externalId)) {
         addIssue(report, 'error', 'QUESTION_EXTERNAL_ID_DUPLICATE', `${path}.externalId`,
            `externalId also used by questions[${seen.get(externalId)}]`, externalId)
         continue
      }
      seen.set(externalId, index)
      const warnings = []
      try {
         const topicCodes = parseTopicCodes(raw.topicCodes)
         const unknownTopic = topicCodes.find((code) => !context.topicKnown(code))
         if (unknownTopic) {
            throw packageError('REFERENCE_UNKNOWN', `topic ${unknownTopic} is not in the bank subject`, 'topicCodes')
         }
         const prepared = prepareQuestion(raw, {
            resolveAsset: (reference) => {
               const asset = context.assets.get(reference)
               if (!asset) throw packageError('REFERENCE_UNKNOWN', `asset ${String(reference).slice(0, 200)} is not declared in assets`, 'content')
               asset.used = true
               return String(asset.placeholder)
            },
            topicIds: topicCodes.map((code, position) => String(position + 1)),
            warn: (code, message) => warnings.push({ code, message }),
         })
         for (const warning of new Map(warnings.map((entry) => [entry.code, entry])).values()) {
            addIssue(report, 'warning', warning.code, path, warning.message, externalId)
         }
         items.push({ index, path, externalId, raw, topicCodes, keyStatus: prepared.answerKey.status })
      } catch (error) {
         issueFromError(report, error, path, externalId)
      }
   }

   if (context.bankId && items.length) {
      const existing = new Map((await deps.imports.findQuestionsByExternalIds(
         context.bankId,
         items.map((item) => item.externalId),
      )).map((row) => [row.external_id, row]))
      for (const item of items) {
         const stored = existing.get(item.externalId)
         if (!stored) item.action = 'create'
         else if (stored.status !== 'draft') {
            item.action = 'skip'
            addIssue(report, 'warning', 'QUESTION_IMMUTABLE_SKIPPED', item.path,
               `question is ${stored.status}; published and archived questions are never changed by imports`, item.externalId)
         } else if (stored.question_type !== item.raw.type) {
            item.action = 'invalid'
            addIssue(report, 'error', 'QUESTION_TYPE_CHANGED', `${item.path}.type`,
               `stored draft is ${stored.question_type}; the question type cannot change`, item.externalId)
         } else item.action = 'update'
      }
   } else {
      for (const item of items) item.action = 'create'
   }
   const counters = report.counters.questions
   for (const item of items) {
      if (item.action === 'create') counters.created += 1
      if (item.action === 'update') counters.updated += 1
      if (item.action === 'skip') counters.skippedImmutable += 1
      if (['create', 'update'].includes(item.action)) report.counters.answerKeys[item.keyStatus] += 1
   }
   return items.filter((item) => ['create', 'update'].includes(item.action))
}

// --- Planner -------------------------------------------------------------------------------

function parseOptions(options = {}) {
   const batchSize = options.batchSize ?? maxBatchSize
   if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > maxBatchSize) {
      throw validationError('batchSize', `batchSize must be 1-${maxBatchSize}`)
   }
   return { batchSize }
}

function parseIdempotencyKey(value, packageSha256) {
   if (value === undefined || value === null) return `package-${packageSha256}`
   if (typeof value !== 'string' || !idempotencyKeyPattern.test(value)) {
      throw validationError('idempotencyKey', 'idempotencyKey must match [A-Za-z0-9._:-]{1,200}')
   }
   return value
}

function summarizeManifest(manifest, plan) {
   return {
      schemaVersion,
      bankCode: plan.bank?.code ?? null,
      sourceNamespace: plan.namespace,
      subjects: plan.taxonomy ? [...plan.taxonomy.subjects.values()].filter((entry) => entry.path).length : 0,
      sections: Array.isArray(manifest.sections) ? manifest.sections.length : 0,
      topics: Array.isArray(manifest.topics) ? manifest.topics.length : 0,
      assets: Array.isArray(manifest.assets) ? manifest.assets.length : 0,
      questions: Array.isArray(manifest.questions) ? manifest.questions.length : 0,
   }
}

async function planImport(deps, actor, pkg, report) {
   const manifest = pkg.manifest
   if (!isPlainObject(manifest)) throw packageError('PACKAGE_SCHEMA_INVALID', 'manifest must be a JSON object')
   if (manifest.schemaVersion !== schemaVersion) {
      throw packageError('PACKAGE_SCHEMA_VERSION_UNSUPPORTED', `schemaVersion must be ${schemaVersion}`, 'schemaVersion')
   }
   requireFields(manifest, manifestFields, 'manifest')
   if (!isPlainObject(manifest.bank)) throw packageError('PACKAGE_SCHEMA_INVALID', 'bank is required', 'bank')
   const namespace = manifest.sourceNamespace ?? (typeof manifest.bank.code === 'string' ? `bank:${manifest.bank.code}` : null)
   if (typeof namespace !== 'string' || !namespacePattern.test(namespace)) {
      throw packageError('PACKAGE_SCHEMA_INVALID', 'sourceNamespace is invalid', 'sourceNamespace')
   }

   const taxonomy = await planTaxonomy(deps, actor, manifest, report)
   const bank = await planBank(deps, actor, manifest, taxonomy, report)
   const assets = await planAssets(deps, manifest, pkg.files, namespace, report)
   let placeholder = 0
   for (const asset of assets.values()) {
      placeholder += 1
      asset.placeholder = placeholder
   }
   const subjectCode = bank?.subjectCode
   const topicKnown = (code) => Boolean(subjectCode && taxonomy.topics.has(taxonomy.key(subjectCode, code))
      && !taxonomy.topics.get(taxonomy.key(subjectCode, code)).invalid)
   // Topics referenced only by questions may already exist in the database.
   if (subjectCode && Array.isArray(manifest.questions)) {
      const subject = taxonomy.subjects.get(subjectCode)
      const codes = new Set(manifest.questions.flatMap((question) => (Array.isArray(question?.topicCodes) ? question.topicCodes : [])))
      for (const code of codes) {
         if (typeof code !== 'string' || taxonomy.topics.has(taxonomy.key(subjectCode, code)) || !subject?.id) continue
         const existing = await deps.taxonomy.findEntityByCode('topic', code, subject.id)
         if (existing) taxonomy.topics.set(taxonomy.key(subjectCode, code), { code, subjectCode, id: existing.id, action: 'reference' })
      }
   }
   const questions = await planQuestions(deps, manifest, {
      assets: new Map([...assets].filter(([, asset]) => !asset.invalid)),
      topicKnown,
      bankId: bank?.existing?.id || null,
   }, report)
   for (const asset of assets.values()) {
      if (!asset.used && !asset.invalid) {
         addIssue(report, 'warning', 'ASSET_UNUSED', asset.path, `asset ${asset.id} is not referenced by any question`)
      }
      if (!asset.invalid && asset.action === 'upload') report.counters.assets.uploaded += 1
      if (!asset.invalid && asset.action === 'alias') report.counters.assets.reusedByAlias += 1
      if (!asset.invalid && asset.action === 'hash') report.counters.assets.reusedByHash += 1
   }
   const plan = { namespace, taxonomy, bank, assets, questions }
   plan.manifestSummary = summarizeManifest(manifest, plan)
   return plan
}

function publicReport(report, extra = {}) {
   return {
      ...extra,
      counters: report.counters,
      topErrorCodes: topCodes(report.errors),
      topWarningCodes: topCodes(report.warnings),
      errors: report.errors,
      warnings: report.warnings,
   }
}

async function existingRunOutcome(deps, actor, bankCode, idempotencyKey, packageSha256) {
   if (typeof bankCode !== 'string') return null
   const bank = await deps.imports.findBankByCode(bankCode)
   if (!bank) return null
   const run = await deps.imports.findRunByKey(bank.id, idempotencyKey)
   if (!run) return null
   if (!actor.administrator && bank.owner_id !== actor.id) {
      throw new AppError(403, 'QUESTION_BANK_READ_ONLY', 'You can only read this question bank')
   }
   if (run.package_sha256 !== packageSha256) {
      throw new AppError(409, 'IMPORT_IDEMPOTENCY_CONFLICT', 'This idempotency key was already used with a different package', [
         { field: 'idempotencyKey', message: `run ${run.id} used another package hash` },
      ])
   }
   return run
}

// Validates everything and writes nothing. The report has the same shape as a real run.
async function dryRunQuestionImportService(actorIdValue, pkg, options = {}, overrides) {
   const deps = dependencies(overrides)
   const actor = await loadActor(deps, actorIdValue)
   const idempotencyKey = parseIdempotencyKey(options.idempotencyKey, pkg.sha256)
   const { batchSize } = parseOptions(options)
   const report = createReport()
   report.counters.batches.size = batchSize
   let previousRun = null
   try {
      previousRun = await existingRunOutcome(deps, actor, pkg.manifest?.bank?.code, idempotencyKey, pkg.sha256)
      await planImport(deps, actor, pkg, report)
   } catch (error) {
      issueFromError(report, error, '')
   }
   return publicReport(report, {
      mode: 'dry_run',
      valid: report.errors.length === 0,
      packageSha256: pkg.sha256,
      idempotencyKey,
      previousRunId: previousRun?.id ?? null,
   })
}

// --- Writer -------------------------------------------------------------------------------

function storageKey(asset) {
   return `question-imports/sha256/${asset.sha256}.${asset.mimeType === mimeTypes.png ? 'png' : 'jpg'}`
}

async function writeTaxonomy(deps, taxonomy, client) {
   for (const entry of taxonomy.subjects.values()) {
      if (entry.action === 'create') {
         entry.id = await deps.taxonomy.createSubject(entry, client)
         await deps.taxonomy.replaceTranslations('subject', entry.id, entry.translations, client)
      } else if (entry.action === 'update') {
         await deps.taxonomy.upsertTranslations('subject', entry.id, entry.translations, client)
      }
   }
   for (const entry of taxonomy.sections.values()) {
      if (entry.action === 'create') {
         entry.id = await deps.taxonomy.createSection({ ...entry, subjectId: taxonomy.subjects.get(entry.subjectCode).id }, client)
         await deps.taxonomy.replaceTranslations('section', entry.id, entry.translations, client)
      } else if (entry.action === 'update') {
         await deps.taxonomy.upsertTranslations('section', entry.id, entry.translations, client)
      }
   }
   for (const entry of taxonomy.orderedTopics) {
      const subjectId = taxonomy.subjects.get(entry.subjectCode).id
      if (entry.action === 'create') {
         await deps.taxonomy.lockTopicTree(subjectId, client)
         entry.id = await deps.taxonomy.createTopic({
            ...entry,
            subjectId,
            sectionId: entry.sectionCode ? taxonomy.sections.get(taxonomy.key(entry.subjectCode, entry.sectionCode)).id : null,
            parentId: entry.parentCode ? taxonomy.topics.get(taxonomy.key(entry.subjectCode, entry.parentCode)).id : null,
         }, client)
         await deps.taxonomy.replaceTranslations('topic', entry.id, entry.translations, client)
      } else if (entry.action === 'update') {
         await deps.taxonomy.upsertTranslations('topic', entry.id, entry.translations, client)
      }
   }
}

async function writeAssets(deps, actor, plan, bankId, client) {
   for (const asset of plan.assets.values()) {
      if (asset.action === 'upload') {
         const stored = await deps.imports.insertImportedImage({
            storageKey: storageKey(asset),
            mimeType: asset.mimeType,
            fileName: asset.fileName,
            sizeBytes: asset.bytes.length,
            sha256: asset.sha256,
            widthPx: asset.widthPx,
            heightPx: asset.heightPx,
            uploadedBy: actor.id,
            sourceMetadata: { importNamespace: plan.namespace, bankId },
         }, client)
         if (stored.status !== 'ready' || !imageTypes.includes(stored.mime_type)) {
            throw new AppError(409, 'ASSET_NOT_USABLE', 'A stored file with the same bytes is not usable')
         }
         asset.assetId = stored.id
      }
      const aliased = await deps.imports.insertAlias(plan.namespace, asset.id, asset.assetId, client)
      if (aliased !== asset.assetId) {
         throw new AppError(409, 'ASSET_ALIAS_CONFLICT', 'Asset alias was created concurrently for other bytes')
      }
   }
}

function normalizeText(value) {
   return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

function contentText(content) {
   return normalizeText((content?.blocks || []).map((block) => {
      switch (block.type) {
         case 'text': return block.text
         case 'verse': return block.lines.join('\n')
         case 'formula': return `formula:${block.latex}`
         case 'chemistry': return `chemistry:${block.formula}`
         case 'table': return block.rows.map((row) => row.join('|')).join('/')
         case 'image': return `image:${block.assetId}`
         default: return ''
      }
   }).join('\n'))
}

// Conservative duplicate signature: question type, normalized content and the unordered
// set of normalized option / matching item contents.
function duplicateSignature(row) {
   const items = (list) => list.map(contentText).sort().join('\u0001')
   return createHash('sha256')
      .update([row.question_type, contentText(row.content), items(row.options), items(row.matching)].join('\u0000'))
      .digest('hex')
}

async function suggestDuplicates(deps, actor, bankId, writtenIds, client) {
   if (!writtenIds.length) return 0
   const groups = new Map()
   for (const row of await deps.imports.listDuplicateCandidates(bankId, client)) {
      const signature = duplicateSignature(row)
      if (!groups.has(signature)) groups.set(signature, [])
      groups.get(signature).push(row.id)
   }
   const signatureOf = new Map()
   for (const [signature, ids] of groups) for (const id of ids) signatureOf.set(id, signature)
   let suggested = 0
   for (const questionId of writtenIds) {
      const others = groups.get(signatureOf.get(questionId)).filter((id) => id !== questionId)
      if (!others.length) continue
      const earliest = others.reduce((low, id) => (BigInt(id) < BigInt(low) ? id : low))
      if (BigInt(earliest) > BigInt(questionId)) continue
      if (await deps.imports.insertDuplicateSuggestion(questionId, earliest, duplicateReason, actor.id, client)) suggested += 1
   }
   return suggested
}

async function writeQuestion(deps, actor, context, item, client, local) {
   const stored = await deps.imports.lockQuestionByExternalId(context.bankId, item.externalId, client)
   if (stored && stored.status !== 'draft') {
      local.skipped.push(item)
      return null
   }
   if (stored && stored.question_type !== item.raw.type) {
      throw new AppError(409, 'QUESTION_TYPE_CHANGED', 'The stored draft has another question type')
   }
   const { values, answerKey } = prepareQuestion(item.raw, {
      resolveAsset: (reference) => context.assets.get(reference).assetId,
      topicIds: item.topicCodes.map((code) => context.topicId(code)),
      warn: () => {},
   })
   let questionId
   if (stored) {
      questionId = stored.id
      await deps.questions.updateQuestion(questionId, { ...values, hasExternalId: false, hasDifficulty: true }, client)
   } else {
      questionId = await deps.questions.createQuestion({
         ...values,
         bankId: context.bankId,
         subjectId: context.subjectId,
         questionType: item.raw.type,
         sourceQuestionId: null,
         actorId: actor.id,
         importId: context.runId,
      }, client)
   }
   if (values.options) await deps.questions.replaceOptions(questionId, values.options, client)
   if (values.matching) await deps.questions.replaceMatchingItems(questionId, values.matching, client)
   await deps.questions.replaceTopics(questionId, context.subjectId, values.topicIds, client)
   await deps.imports.setQuestionImport(questionId, context.runId, client)
   // A package key replaces the stored one only when it carries an answer; an unknown key
   // never erases an answer a reviewer or author already entered on the draft.
   const current = (await deps.questions.findQuestionParts(questionId, client)).answerKey
   if (answerKey.status === 'proposed' || !current) {
      await deps.questions.upsertAnswerKey(questionId, answerKey, client)
      local.keys[answerKey.status] += 1
   } else {
      local.keys.keptExisting += 1
   }
   await reconcileAnswerKey(deps.questions, client, questionId)
   local[stored ? 'updated' : 'created'] += 1
   return questionId
}

async function writeBatch(deps, actor, context, batch, client, local) {
   const bank = await deps.questions.lockReadableBank(actor.id, context.bankId, client)
   if (!bank || !canManage(bank, actor.id)) {
      throw new AppError(403, 'QUESTION_BANK_READ_ONLY', 'You can only read this question bank')
   }
   const written = []
   for (const item of batch) {
      local.current = item
      const questionId = await writeQuestion(deps, actor, context, item, client, local)
      if (questionId) written.push(questionId)
   }
   local.current = null
   local.duplicates = await suggestDuplicates(deps, actor, context.bankId, written, client)
   await deps.auth.appendAuditEvent({
      actorUserId: actor.id,
      subjectUserId: null,
      code: 'question_import.batch_committed',
      entityType: 'question_import',
      entityId: context.runId,
      metadata: { created: local.created, updated: local.updated, skipped: local.skipped.length },
   }, client)
}

function replayResult(run) {
   return { mode: 'import', replayed: true, run: safeRun(run) }
}

async function runQuestionImportService(actorIdValue, pkg, options = {}, overrides) {
   const deps = dependencies(overrides)
   const actor = await loadActor(deps, actorIdValue)
   const idempotencyKey = parseIdempotencyKey(options.idempotencyKey, pkg.sha256)
   const { batchSize } = parseOptions(options)
   const previous = await existingRunOutcome(deps, actor, pkg.manifest?.bank?.code, idempotencyKey, pkg.sha256)
   if (previous) return replayResult(previous)

   const report = createReport()
   report.counters.batches.size = batchSize
   let plan
   try {
      plan = await planImport(deps, actor, pkg, report)
   } catch (error) {
      issueFromError(report, error, '')
   }
   if (report.errors.length) {
      return publicReport(report, { mode: 'import', status: 'rejected', packageSha256: pkg.sha256, idempotencyKey })
   }

   // Objects are content-addressed, so uploading before the database transaction is
   // idempotent: a failed run leaves at most an unreferenced object under the same key.
   const uploads = [...plan.assets.values()].filter((asset) => asset.action === 'upload')
   if (uploads.length) {
      const storage = deps.storage || getStorageProvider()
      for (const asset of uploads) {
         await storage.uploadObject({ key: storageKey(asset), body: asset.bytes, contentType: asset.mimeType })
      }
   }

   const context = { runId: null, bankId: null, subjectId: null, assets: plan.assets, topicId: null }
   try {
      await deps.transaction(async (client) => {
         await writeTaxonomy(deps, plan.taxonomy, client)
         const subjectId = plan.taxonomy.subjects.get(plan.bank.subjectCode).id
         let bankId = plan.bank.existing?.id
         if (!bankId) {
            bankId = await deps.questions.createBank({ ...plan.bank, subjectId, ownerId: actor.id }, client)
         } else {
            const bank = await deps.questions.lockReadableBank(actor.id, bankId, client)
            if (!bank || !canManage(bank, actor.id)) {
               throw new AppError(403, 'QUESTION_BANK_READ_ONLY', 'You can only read this question bank')
            }
         }
         context.runId = await deps.imports.insertRun({
            bankId,
            initiatedBy: actor.id,
            packageSha256: pkg.sha256,
            schemaVersion,
            idempotencyKey,
            manifest: plan.manifestSummary,
            counters: report.counters,
         }, client)
         await writeAssets(deps, actor, plan, bankId, client)
         await deps.imports.insertRunErrors(context.runId, report.warnings, client)
         await deps.auth.appendAuditEvent({
            actorUserId: actor.id,
            subjectUserId: null,
            code: 'question_import.started',
            entityType: 'question_import',
            entityId: context.runId,
            metadata: { bankId, questions: plan.questions.length },
         }, client)
         context.bankId = bankId
         context.subjectId = subjectId
      })
   } catch (error) {
      if (error.code === '23505' && error.constraint === 'question_imports_bank_id_idempotency_key_key') {
         const raced = await existingRunOutcome(deps, actor, plan.bank.code, idempotencyKey, pkg.sha256)
         if (raced) return replayResult(raced)
      }
      throw error
   }
   context.topicId = (code) => plan.taxonomy.topics.get(plan.taxonomy.key(plan.bank.subjectCode, code)).id
   deps.log('question import started', { runId: context.runId, questions: plan.questions.length })

   // Planned counts become actual counts as batches commit.
   const counters = report.counters
   counters.questions.created = 0
   counters.questions.updated = 0
   counters.answerKeys = { unknown: 0, proposed: 0, keptExisting: 0 }
   let failed = false
   for (let start = 0; start < plan.questions.length; start += batchSize) {
      const batch = plan.questions.slice(start, start + batchSize)
      if (failed) {
         counters.questions.notAttempted += batch.length
         continue
      }
      const local = { created: 0, updated: 0, skipped: [], keys: { unknown: 0, proposed: 0, keptExisting: 0 }, duplicates: 0, current: null }
      try {
         await deps.transaction(async (client) => {
            await writeBatch(deps, actor, context, batch, client, local)
            const next = structuredClone(counters)
            next.questions.created += local.created
            next.questions.updated += local.updated
            next.questions.skippedImmutable += local.skipped.length
            for (const status of Object.keys(local.keys)) next.answerKeys[status] += local.keys[status]
            next.duplicates.suggested += local.duplicates
            next.batches.committed += 1
            await deps.imports.updateRunProgress(context.runId, next, client)
         })
         counters.questions.created += local.created
         counters.questions.updated += local.updated
         counters.questions.skippedImmutable += local.skipped.length
         for (const status of Object.keys(local.keys)) counters.answerKeys[status] += local.keys[status]
         counters.duplicates.suggested += local.duplicates
         counters.batches.committed += 1
         const skippedNow = local.skipped.map((item) => ({
            severity: 'warning',
            code: 'QUESTION_IMMUTABLE_SKIPPED',
            path: item.path,
            message: 'question was published or archived before its batch ran; it was not changed',
            externalId: item.externalId,
         }))
         if (skippedNow.length) {
            counters.warnings += skippedNow.length
            report.warnings.push(...skippedNow)
            await deps.imports.insertRunErrors(context.runId, skippedNow)
         }
      } catch (error) {
         failed = true
         counters.batches.failed += 1
         counters.questions.failed += batch.length
         counters.errors += 1
         const entry = {
            severity: 'error',
            code: error instanceof AppError ? error.code : 'IMPORT_BATCH_FAILED',
            path: `questions[${batch[0].index}..${batch[batch.length - 1].index}]`,
            message: error instanceof AppError
               ? `batch rolled back: ${error.details?.[0]?.message || error.message}`
               : `batch rolled back: database error ${error.code || 'unknown'}`,
            externalId: local.current?.externalId ?? null,
         }
         report.errors.push(entry)
         await deps.imports.insertRunErrors(context.runId, [entry])
         deps.log('question import batch failed', { runId: context.runId, code: entry.code })
      }
   }
   const status = failed ? 'failed' : 'completed'
   await deps.transaction(async (client) => {
      await deps.imports.finishRun(context.runId, status, counters, client)
      await deps.auth.appendAuditEvent({
         actorUserId: actor.id,
         subjectUserId: null,
         code: `question_import.${status}`,
         entityType: 'question_import',
         entityId: context.runId,
         metadata: { created: counters.questions.created, updated: counters.questions.updated, failed: counters.questions.failed },
      }, client)
   })
   deps.log('question import finished', { runId: context.runId, status })
   return publicReport(report, {
      mode: 'import',
      status,
      runId: context.runId,
      bankId: context.bankId,
      packageSha256: pkg.sha256,
      idempotencyKey,
   })
}

// --- Read API -----------------------------------------------------------------------------

function safeRun(row) {
   return {
      id: row.id,
      bankId: row.bank_id,
      bankCode: row.bank_code,
      initiatedBy: row.initiated_by,
      packageSha256: row.package_sha256,
      schemaVersion: row.schema_version,
      idempotencyKey: row.idempotency_key,
      isDryRun: row.is_dry_run,
      status: row.status,
      manifest: row.manifest,
      counters: row.counters,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
   }
}

function safeRunEntry(row) {
   return {
      id: row.id,
      externalId: row.external_id,
      recordPath: row.record_path,
      severity: row.severity,
      code: row.error_code,
      message: row.message,
      createdAt: row.created_at,
   }
}

function parseRunId(value) {
   try {
      return normalizeInternalId(value)
   } catch {
      throw new AppError(400, 'INVALID_IMPORT_ID', 'Import identifier is invalid')
   }
}

function parseOptionalId(value, field) {
   if (value === undefined) return null
   try {
      return normalizeInternalId(value)
   } catch {
      throw validationError(field)
   }
}

function importNotFound() {
   return new AppError(404, 'QUESTION_IMPORT_NOT_FOUND', 'Question import was not found')
}

async function listQuestionImportsService(userId, query = {}, overrides) {
   const deps = dependencies(overrides)
   const actorId = normalizeInternalId(userId)
   validateBody(query || {}, ['limit', 'offset', 'bankId', 'status'])
   if (query.status !== undefined && !runStatuses.includes(query.status)) throw validationError('status')
   const filters = {
      ...parsePagination(query),
      bankId: parseOptionalId(query.bankId, 'bankId'),
      status: query.status ?? null,
   }
   const rows = await deps.imports.listVisibleRuns(actorId, filters)
   return {
      imports: rows.slice(0, filters.limit).map(safeRun),
      pagination: { limit: filters.limit, offset: filters.offset, hasMore: rows.length > filters.limit },
   }
}

async function getQuestionImportService(userId, importIdValue, overrides) {
   const deps = dependencies(overrides)
   const run = await deps.imports.findVisibleRun(normalizeInternalId(userId), parseRunId(importIdValue))
   if (!run) throw importNotFound()
   return safeRun(run)
}

async function listQuestionImportErrorsService(userId, importIdValue, query = {}, overrides) {
   const deps = dependencies(overrides)
   const runId = parseRunId(importIdValue)
   validateBody(query || {}, ['limit', 'offset', 'severity'])
   if (query.severity !== undefined && !['warning', 'error'].includes(query.severity)) throw validationError('severity')
   if (!await deps.imports.findVisibleRun(normalizeInternalId(userId), runId)) throw importNotFound()
   const filters = { ...parsePagination(query), severity: query.severity ?? null }
   const rows = await deps.imports.listRunErrors(runId, filters)
   return {
      entries: rows.slice(0, filters.limit).map(safeRunEntry),
      pagination: { limit: filters.limit, offset: filters.offset, hasMore: rows.length > filters.limit },
   }
}

export {
   dryRunQuestionImportService,
   getQuestionImportService,
   listQuestionImportErrorsService,
   listQuestionImportsService,
   resolveImportActorService,
   runQuestionImportService,
}
