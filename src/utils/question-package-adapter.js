import { isPlainObject } from './question-content.js'
import { sha256 } from './question-package.js'

// Converts the relational `everest.question-import.v1` package (manifest.json + data/*.json
// entity envelopes, see docs/import-contract.md §9) into the importer's internal model.
// Pure function: no database access. Every value the internal model cannot hold is either
// mapped to the closest valid form or reported; nothing is dropped silently.

const schemaVersion = 'everest.question-import.v1'
const entities = [
   'subjects',
   'subject_translations',
   'sections',
   'section_translations',
   'topics',
   'topic_translations',
   'question_banks',
   'questions',
   'question_options',
   'question_matching_items',
   'question_answer_keys',
   'question_topics',
   'assets',
   'question_assets',
   'question_duplicate_links',
]

// Fields each entity maps 1:1 (or uses as a reference). Any other non-null field is counted
// and reported once per entity as SOURCE_FIELD_DROPPED.
const mappedFields = {
   subjects: ['code', 'primaryLanguage', 'color', 'isActive'],
   subject_translations: ['subjectCode', 'languageCode', 'title'],
   sections: ['subjectCode', 'code', 'primaryLanguage', 'isActive'],
   section_translations: ['subjectCode', 'sectionCode', 'languageCode', 'title'],
   topics: ['subjectCode', 'code', 'sectionCode', 'parentTopicCode', 'primaryLanguage'],
   topic_translations: ['subjectCode', 'topicCode', 'languageCode', 'title'],
   question_banks: ['code', 'title', 'subjectCode', 'visibility', 'sourceMetadata'],
   questions: [
      'bankCode', 'subjectCode', 'externalId', 'questionType', 'languageCode', 'difficulty',
      'difficultySource', 'status', 'content', 'interactionSettings', 'sourceMetadata',
   ],
   question_options: ['bankCode', 'questionExternalId', 'optionKey', 'position', 'sourceLabel', 'content'],
   question_matching_items: ['bankCode', 'questionExternalId', 'side', 'itemKey', 'position', 'sourceLabel', 'content'],
   question_answer_keys: ['bankCode', 'questionExternalId', 'status', 'source', 'answerDataExternal', 'explanation'],
   question_topics: ['bankCode', 'questionExternalId', 'subjectCode', 'topicCode'],
   assets: [
      'sourceNamespace', 'externalId', 'relativePath', 'mimeType', 'sizeBytes', 'sha256', 'widthPx',
      'heightPx', 'status', 'sourceMetadata',
   ],
   question_assets: ['bankCode', 'questionExternalId', 'assetExternalId', 'sourceNamespace', 'usageRole'],
   question_duplicate_links: ['bankCode', 'questionExternalId', 'duplicateOfExternalId', 'reason'],
}

// sourceMetadata keys that reach the source_metadata allowlist (utils/question-content.js);
// the rest is reported per key.
const sourceMetadataMapped = [
   'book', 'edition', 'page', 'number', 'note', 'year', 'examYear', 'sourceFile', 'printedPage',
   'pageIndex1Based', 'sourceNumber', 'sequence', 'bookSectionTitle', 'bookRubric', 'isSample',
   'examPart', 'reviewRequired',
]

function isEntityPackage(pkg) {
   return isPlainObject(pkg.manifest) && pkg.manifest.bank === undefined
      && [...pkg.files.keys()].some((name) => /^data\/[^/]+\.json$/.test(name))
}

function createCollector() {
   const issues = []
   const dropped = new Map()
   const seen = new Set()
   return {
      issues,
      error(code, path, message, externalId = null) {
         issues.push({ severity: 'error', code, path, message, externalId })
      },
      // One warning per code and record: a question with many flattened spans reports once.
      warn(code, path, message, externalId = null) {
         const key = `${code}\u0000${path}`
         if (seen.has(key)) return
         seen.add(key)
         issues.push({ severity: 'warning', code, path, message, externalId })
      },
      drop(scope, field) {
         dropped.set(`${scope}\u0000${field}`, (dropped.get(`${scope}\u0000${field}`) || 0) + 1)
      },
      flushDropped() {
         for (const [key, count] of [...dropped].sort(([left], [right]) => left.localeCompare(right))) {
            const [scope, field] = key.split('\u0000')
            issues.push({
               severity: 'warning',
               code: 'SOURCE_FIELD_DROPPED',
               path: `data/${scope}`,
               message: `${field} has no database column and was not imported (${count} records); it stays in the package`,
               externalId: null,
            })
         }
      },
   }
}

function readEnvelopes(pkg, collect) {
   const records = Object.fromEntries(entities.map((entity) => [entity, []]))
   const names = [...pkg.files.keys()].filter((name) => /^data\/[^/]+\.json$/.test(name)).sort()
   for (const name of names) {
      let document
      try {
         document = JSON.parse(pkg.files.get(name).toString('utf8').replace(/^﻿/, ''))
      } catch {
         collect.error('PACKAGE_JSON_INVALID', name, `${name} is not valid JSON`)
         continue
      }
      if (!isPlainObject(document) || !Array.isArray(document.records)) {
         collect.error('PACKAGE_SCHEMA_INVALID', name, 'an entity file must be { schemaVersion, entity, records[] }')
         continue
      }
      if (document.schemaVersion !== schemaVersion) {
         collect.error('PACKAGE_SCHEMA_VERSION_UNSUPPORTED', name, `schemaVersion must be ${schemaVersion}`)
         continue
      }
      if (!entities.includes(document.entity)) {
         collect.error('PACKAGE_ENTITY_UNKNOWN', name, `entity ${String(document.entity).slice(0, 60)} is not supported`)
         continue
      }
      document.records.forEach((record, index) => {
         records[document.entity].push({ record, path: `${name}#records[${index}]` })
      })
   }
   return records
}

// The manifest may list every file with its hash and record count; verify what it declares.
function verifyManifestFiles(pkg, collect) {
   if (!Array.isArray(pkg.manifest.files)) return
   for (const [index, entry] of pkg.manifest.files.entries()) {
      if (!isPlainObject(entry) || typeof entry.path !== 'string') continue
      const data = pkg.files.get(entry.path)
      const path = `manifest.files[${index}]`
      if (!data) {
         collect.error('PACKAGE_FILE_MISSING', path, `${entry.path.slice(0, 200)} is listed but not in the package`)
      } else if (typeof entry.sha256 === 'string' && entry.sha256 !== sha256(data)) {
         collect.error('PACKAGE_FILE_HASH_MISMATCH', path, `${entry.path.slice(0, 200)} does not match its sha256`)
      }
   }
}

function reportDropped(collect, scope, record, mapped) {
   if (!isPlainObject(record)) return
   for (const [field, value] of Object.entries(record)) {
      if (!mapped.includes(field) && value !== null && value !== undefined) collect.drop(scope, field)
   }
}

// --- Rich content ---------------------------------------------------------------------

function inlineText(children) {
   return (Array.isArray(children) ? children : []).map((child) => {
      if (child?.type === 'text') return child.text ?? ''
      if (child?.type === 'math' || child?.type === 'chemistry') return child.latex ?? ''
      return ''
   }).join('')
}

function commonMarks(children) {
   const marked = children.filter((child) => child?.type === 'text' && typeof child.text === 'string' && child.text.trim())
   if (!marked.length) return { marks: [], mixed: false }
   const sets = marked.map((child) => (Array.isArray(child.marks) ? child.marks : []))
   const marks = sets[0].filter((mark) => sets.every((set) => set.includes(mark)))
   const mixed = sets.some((set) => set.length !== marks.length)
   return { marks, mixed }
}

function textBlock(text, marks) {
   return { type: 'text', text, ...(marks.length ? { marks } : {}) }
}

function convertParagraph(block, warn) {
   const children = Array.isArray(block.children) ? block.children : []
   if (children.some((child) => child?.type === 'math' || child?.type === 'chemistry')) {
      warn('CONTENT_INLINE_FORMULA_SPLIT', 'inline math/chemistry was split into separate formula blocks')
      const blocks = []
      let run = []
      const flush = () => {
         const text = inlineText(run)
         if (text.trim()) {
            const { marks, mixed } = commonMarks(run)
            if (mixed) warn('CONTENT_INLINE_MARKS_FLATTENED', 'inline marks inside a paragraph were reduced to the marks shared by the whole text')
            blocks.push(textBlock(text, marks))
         }
         run = []
      }
      for (const child of children) {
         if (child?.type === 'math') {
            flush()
            blocks.push({ type: 'formula', latex: child.latex, display: false })
         } else if (child?.type === 'chemistry') {
            flush()
            blocks.push({ type: 'chemistry', formula: child.latex })
         } else run.push(child)
      }
      flush()
      return blocks
   }
   const text = inlineText(children)
   if (!text.trim()) {
      warn('CONTENT_EMPTY_BLOCK_DROPPED', 'an empty paragraph was not imported')
      return []
   }
   const { marks, mixed } = commonMarks(children)
   if (mixed) warn('CONTENT_INLINE_MARKS_FLATTENED', 'inline marks inside a paragraph were reduced to the marks shared by the whole text')
   return [textBlock(text, marks)]
}

function plainText(blocks) {
   return (Array.isArray(blocks) ? blocks : []).map((block) => {
      if (block?.type === 'paragraph') return inlineText(block.children)
      if (block?.type === 'line_group') return (block.lines || []).map((line) => inlineText(line?.children)).join('\n')
      if (block?.type === 'math' || block?.type === 'chemistry') return block.latex ?? ''
      return ''
   }).join('\n')
}

function convertBlock(block, warn) {
   if (!isPlainObject(block)) return [block]
   switch (block.type) {
      case 'paragraph':
         return convertParagraph(block, warn)
      case 'line_group': {
         const lines = Array.isArray(block.lines) ? block.lines : []
         if (lines.some((line) => (line?.children || []).some((child) => child?.type !== 'text' || child.marks?.length))) {
            warn('CONTENT_INLINE_MARKS_FLATTENED', 'line group marks or inline formulas were flattened to plain verse lines')
         }
         return [{ type: 'verse', lines: lines.map((line) => inlineText(line?.children)) }]
      }
      case 'math':
         return [{ type: 'formula', latex: block.latex, ...(typeof block.display === 'boolean' ? { display: block.display } : {}) }]
      case 'chemistry':
         if (block.display === true) warn('CONTENT_DISPLAY_IGNORED', 'chemistry display mode is not stored')
         return [{ type: 'chemistry', formula: block.latex }]
      case 'image':
         return [{
            type: 'image',
            asset: block.assetExternalId,
            ...(block.alt === undefined ? {} : { alt: block.alt }),
            ...(block.sourceNamespace === undefined ? {} : { assetNamespace: block.sourceNamespace }),
         }]
      case 'table': {
         const rows = (Array.isArray(block.rows) ? block.rows : []).map((row) => (Array.isArray(row?.cells) ? row.cells : []).map((cell) => {
            if (cell?.isHeader || (cell?.rowSpan ?? 1) > 1 || (cell?.colSpan ?? 1) > 1) {
               warn('CONTENT_TABLE_FLATTENED', 'table header flags and merged cells are not supported; cells were kept as plain text')
            }
            return plainText(cell?.blocks)
         }))
         return [{ type: 'table', rows }]
      }
      case 'columnHeaders':
         warn('MATCHING_COLUMN_HEADERS_AS_TABLE', 'matching column headers were stored as a one-row table in the question content')
         return [{ type: 'table', rows: [[String(block.left ?? ''), String(block.right ?? '')]] }]
      default:
         return [block]
   }
}

function convertContent(content, warn) {
   if (!isPlainObject(content) || !Array.isArray(content.blocks)) return content
   return { blocks: content.blocks.flatMap((block) => convertBlock(block, warn)) }
}

function referencedAssets(content, into) {
   for (const block of content?.blocks || []) if (block?.type === 'image') into.add(block.asset)
}

// --- Metadata ------------------------------------------------------------------------

function mapSourceMetadata(value, scope, collect) {
   if (!isPlainObject(value)) return {}
   for (const [field, fieldValue] of Object.entries(value)) {
      if (!sourceMetadataMapped.includes(field) && fieldValue !== null && fieldValue !== undefined) {
         collect.drop(`${scope}.sourceMetadata`, field)
      }
   }
   const out = {}
   const set = (key, fieldValue) => {
      if (fieldValue !== null && fieldValue !== undefined && fieldValue !== '') out[key] = fieldValue
   }
   set('book', value.book)
   set('edition', value.edition)
   set('note', value.note)
   const printed = typeof value.printedPage === 'string' && /^[1-9][0-9]*$/.test(value.printedPage)
      ? Number(value.printedPage)
      : null
   set('page', value.page ?? printed ?? value.pageIndex1Based)
   set('number', value.number !== null && value.number !== undefined ? String(value.number) : value.sourceNumber)
   set('year', value.year ?? value.examYear)
   for (const key of ['sourceFile', 'printedPage', 'sequence', 'bookSectionTitle', 'bookRubric', 'isSample', 'examPart', 'reviewRequired']) {
      set(key, value[key])
   }
   return out
}

// answerDataExternal uses item keys with external field names; convert to M08 answer_data.
function mapAnswerData(value, questionType, warn) {
   if (!isPlainObject(value)) return value
   if (Array.isArray(value.optionKeys)) {
      if (questionType === 'single_choice') {
         return value.optionKeys.length === 1 ? { optionKey: value.optionKeys[0] } : { optionKeys: value.optionKeys }
      }
      return { optionKeys: value.optionKeys }
   }
   if (Array.isArray(value.pairs)) {
      return { pairs: value.pairs.map((pair) => (isPlainObject(pair) ? { left: pair.leftKey, right: pair.rightKey } : pair)) }
   }
   if (Array.isArray(value.acceptedValues)) {
      if (value.absoluteTolerance !== null && value.absoluteTolerance !== undefined || value.unit !== null && value.unit !== undefined) {
         warn('GRADING_RULE_IGNORED', 'numeric tolerance and unit are not supported yet and were not imported')
      }
      const number = value.acceptedValues.length === 1 ? Number(value.acceptedValues[0]) : NaN
      return { value: Number.isFinite(number) ? number : value.acceptedValues }
   }
   if (Array.isArray(value.acceptedAnswers)) {
      if (value.normalization !== null && value.normalization !== undefined) {
         warn('GRADING_RULE_IGNORED', 'short-text normalization is not supported yet and was not imported')
      }
      return { acceptedAnswers: value.acceptedAnswers }
   }
   return value
}

function mapInteraction(question, warn) {
   const settings = isPlainObject(question.interactionSettings) ? question.interactionSettings : {}
   let type = question.questionType
   if (type === 'open') {
      if (settings.answerFormat === 'short_text' || settings.answerFormat === 'numeric') {
         type = settings.answerFormat
         warn('QUESTION_TYPE_MAPPED', `open question imported as ${type}`)
      }
   }
   if (type === 'matching') {
      const extra = Object.keys(settings).filter((key) => !['requireAllLeft', 'allowRightReuse'].includes(key))
      if (extra.length) warn('INTERACTION_SETTINGS_DROPPED', `interaction settings ${extra.join(', ')} are not supported`)
      return {
         type,
         interactionSettings: {
            requireAllLeft: settings.requireAllLeft ?? null,
            allowRightReuse: settings.allowRightReuse ?? null,
         },
      }
   }
   if (Object.keys(settings).length) {
      warn('INTERACTION_SETTINGS_DROPPED', `interaction settings ${Object.keys(settings).join(', ')} are not supported for ${type}`)
   }
   return { type, interactionSettings: undefined }
}

// --- Adapter -------------------------------------------------------------------------

function groupBy(entries, key) {
   const map = new Map()
   for (const entry of entries) {
      const value = entry.record?.[key]
      if (!map.has(value)) map.set(value, [])
      map.get(value).push(entry)
   }
   return map
}

function translationsOf(entries, codeField, code, subjectCode) {
   const translations = {}
   for (const { record } of entries) {
      if (record?.[codeField] === code && (subjectCode === undefined || record.subjectCode === subjectCode)) {
         translations[record.languageCode] = { title: record.title }
      }
   }
   return translations
}

function adaptEntityPackage(pkg) {
   const collect = createCollector()
   const manifest = pkg.manifest
   if (manifest.schemaVersion !== schemaVersion) {
      collect.error('PACKAGE_SCHEMA_VERSION_UNSUPPORTED', 'manifest.schemaVersion', `schemaVersion must be ${schemaVersion}`)
      return { manifest: null, issues: collect.issues, questionPaths: [] }
   }
   if (manifest.readyForImport === false) {
      collect.warn('PACKAGE_NOT_READY_FOR_IMPORT', 'manifest.readyForImport', 'the package declares readyForImport: false')
   }
   if (manifest.extractionComplete === false) {
      collect.warn('PACKAGE_EXTRACTION_INCOMPLETE', 'manifest.extractionComplete', 'the package declares extractionComplete: false')
   }
   verifyManifestFiles(pkg, collect)
   const data = readEnvelopes(pkg, collect)
   for (const entity of entities) {
      for (const { record } of data[entity]) reportDropped(collect, entity, record, mappedFields[entity])
   }

   const banks = data.question_banks
   if (banks.length !== 1) {
      collect.error('PACKAGE_BANK_COUNT_UNSUPPORTED', 'data/question_banks', `a package must contain exactly one bank (found ${banks.length})`)
      collect.flushDropped()
      return { manifest: null, issues: collect.issues, questionPaths: [] }
   }
   const bankRecord = banks[0].record
   const bankCode = bankRecord.code
   const namespace = manifest.sourceNamespace ?? bankRecord.sourceMetadata?.sourceNamespace
   const questionsByExternalId = new Map()

   const subjects = data.subjects.map(({ record }) => {
      if (record.isActive === false) collect.warn('TAXONOMY_INACTIVE_IGNORED', 'data/subjects', `subject ${record.code} is inactive in the package; EVEREST has no inactive flag`)
      return {
         code: record.code,
         ...(record.primaryLanguage === undefined ? {} : { primaryLanguage: record.primaryLanguage }),
         ...(record.color === undefined ? {} : { color: record.color }),
         translations: translationsOf(data.subject_translations, 'subjectCode', record.code),
      }
   })
   const sections = data.sections.map(({ record }) => {
      if (record.isActive === false) collect.warn('TAXONOMY_INACTIVE_IGNORED', 'data/sections', `section ${record.code} is inactive in the package; EVEREST has no inactive flag`)
      return {
         subjectCode: record.subjectCode,
         code: record.code,
         ...(record.primaryLanguage === undefined ? {} : { primaryLanguage: record.primaryLanguage }),
         translations: translationsOf(data.section_translations, 'sectionCode', record.code, record.subjectCode),
      }
   })
   const topics = data.topics.map(({ record }) => ({
      subjectCode: record.subjectCode,
      code: record.code,
      ...(record.sectionCode ? { sectionCode: record.sectionCode } : {}),
      ...(record.parentTopicCode ? { parentCode: record.parentTopicCode } : {}),
      ...(record.primaryLanguage === undefined ? {} : { primaryLanguage: record.primaryLanguage }),
      translations: translationsOf(data.topic_translations, 'topicCode', record.code, record.subjectCode),
   }))

   const questionPaths = []
   const questions = data.questions.map(({ record, path }) => {
      const externalId = record.externalId
      const warn = (code, message) => collect.warn(code, path, message, externalId ?? null)
      if (record.bankCode !== bankCode) collect.error('PACKAGE_BANK_MISMATCH', `${path}.bankCode`, 'question belongs to another bank', externalId)
      if (record.subjectCode !== undefined && record.subjectCode !== bankRecord.subjectCode) {
         collect.error('TAXONOMY_SUBJECT_MISMATCH', `${path}.subjectCode`, 'question subject differs from the bank subject', externalId)
      }
      if (record.status !== undefined && record.status !== 'draft') {
         warn('QUESTION_STATUS_IGNORED', `package status ${String(record.status).slice(0, 20)} ignored; imports create drafts only`)
      }
      const reviewNotes = (record.sourceMetadata?.transcriptionIssues?.length || 0) + (record.sourceMetadata?.reviewFlags?.length || 0)
      if (reviewNotes) warn('SOURCE_REVIEW_NOTES_PRESENT', `${reviewNotes} transcription issue(s) or review flag(s) in the package; check the package reports`)
      const { type, interactionSettings } = mapInteraction(record, warn)
      const question = {
         externalId,
         type,
         ...(record.languageCode === undefined ? {} : { language: record.languageCode }),
         ...(record.difficulty === undefined || record.difficulty === null ? {} : { difficulty: record.difficulty }),
         ...(record.difficultySource === undefined || record.difficultySource === null ? {} : { difficultySource: record.difficultySource }),
         content: convertContent(record.content, warn),
         ...(interactionSettings === undefined ? {} : { interactionSettings }),
         source: mapSourceMetadata(record.sourceMetadata, 'questions', collect),
      }
      if (typeof externalId === 'string') questionsByExternalId.set(externalId, { question, path, warn })
      questionPaths.push(path)
      return question
   })

   function owner(entity, entry) {
      const { record, path } = entry
      const target = questionsByExternalId.get(record?.questionExternalId)
      if (!target) {
         collect.error('REFERENCE_UNKNOWN', path, `${entity} references an unknown question`, record?.questionExternalId ?? null)
         return null
      }
      if (record.bankCode !== undefined && record.bankCode !== bankCode) {
         collect.error('PACKAGE_BANK_MISMATCH', `${path}.bankCode`, `${entity} belongs to another bank`, record.questionExternalId)
         return null
      }
      return target
   }
   const byPosition = (left, right) => (left.record.position ?? 0) - (right.record.position ?? 0)

   for (const [, entries] of groupBy(data.question_options, 'questionExternalId')) {
      const target = owner('question_options', entries[0])
      if (!target) continue
      target.question.options = entries.sort(byPosition).map(({ record }) => ({
         key: record.optionKey,
         ...(record.sourceLabel === undefined || record.sourceLabel === null ? {} : { label: record.sourceLabel }),
         content: convertContent(record.content, target.warn),
      }))
   }
   for (const [, entries] of groupBy(data.question_matching_items, 'questionExternalId')) {
      const target = owner('question_matching_items', entries[0])
      if (!target) continue
      const side = (name) => entries.filter(({ record }) => record.side === name).sort(byPosition).map(({ record }) => ({
         key: record.itemKey,
         ...(record.sourceLabel === undefined || record.sourceLabel === null ? {} : { label: record.sourceLabel }),
         content: convertContent(record.content, target.warn),
      }))
      const unknownSide = entries.find(({ record }) => !['left', 'right'].includes(record.side))
      if (unknownSide) collect.error('PACKAGE_SCHEMA_INVALID', `${unknownSide.path}.side`, 'side must be left or right', unknownSide.record.questionExternalId)
      target.question.matching = { left: side('left'), right: side('right') }
   }
   for (const entry of data.question_answer_keys) {
      const target = owner('question_answer_keys', entry)
      if (!target) continue
      if (target.question.answerKey) {
         collect.error('ANSWER_KEY_DUPLICATE', entry.path, 'a question has more than one answer key record', entry.record.questionExternalId)
         continue
      }
      const { record } = entry
      target.question.answerKey = {
         status: record.status,
         ...(record.source === undefined ? {} : { source: record.source }),
         ...(record.answerDataExternal === undefined || record.answerDataExternal === null
            ? {}
            : { answerData: mapAnswerData(record.answerDataExternal, target.question.type, target.warn) }),
         ...(record.explanation === undefined ? {} : { explanation: convertContent(record.explanation, target.warn) }),
      }
   }
   for (const entry of data.question_topics) {
      const target = owner('question_topics', entry)
      if (!target) continue
      if (entry.record.subjectCode !== undefined && entry.record.subjectCode !== bankRecord.subjectCode) {
         collect.error('TAXONOMY_SUBJECT_MISMATCH', `${entry.path}.subjectCode`, 'topic link uses another subject', entry.record.questionExternalId)
         continue
      }
      target.question.topicCodes ||= []
      if (!target.question.topicCodes.includes(entry.record.topicCode)) target.question.topicCodes.push(entry.record.topicCode)
   }

   const assets = data.assets.map(({ record, path }) => {
      if ((record.sourceNamespace ?? namespace) !== namespace) {
         collect.error('ASSET_NAMESPACE_UNSUPPORTED', `${path}.sourceNamespace`, 'all assets must use the package sourceNamespace')
      }
      if (record.status !== undefined && record.status !== 'ready') {
         collect.error('ASSET_NOT_USABLE', `${path}.status`, `asset ${String(record.externalId).slice(0, 200)} is not ready in the package`)
      }
      return {
         id: record.externalId,
         file: record.relativePath,
         mimeType: record.mimeType,
         ...(record.sha256 === undefined ? {} : { sha256: record.sha256 }),
         ...(record.sizeBytes === undefined ? {} : { sizeBytes: record.sizeBytes }),
         ...(record.widthPx === undefined ? {} : { widthPx: record.widthPx }),
         ...(record.heightPx === undefined ? {} : { heightPx: record.heightPx }),
         ...(record.sourceMetadata === undefined ? {} : { sourceMetadata: record.sourceMetadata }),
      }
   })
   const assetIds = new Set(assets.map((asset) => asset.id))

   // question_assets is derived from image blocks in EVEREST. A link without a matching
   // image block becomes an image block appended to the question content.
   for (const entry of data.question_assets) {
      const target = owner('question_assets', entry)
      if (!target) continue
      const { record } = entry
      if ((record.sourceNamespace ?? namespace) !== namespace || !assetIds.has(record.assetExternalId)) {
         collect.error('REFERENCE_UNKNOWN', entry.path, 'question_assets references an unknown asset', record.questionExternalId)
         continue
      }
      const used = new Set()
      const question = target.question
      referencedAssets(question.content, used)
      for (const item of [...(question.options || []), ...(question.matching?.left || []), ...(question.matching?.right || [])]) {
         referencedAssets(item.content, used)
      }
      referencedAssets(question.answerKey?.explanation, used)
      if (used.has(record.assetExternalId)) continue
      if (isPlainObject(question.content) && Array.isArray(question.content.blocks)) {
         question.content.blocks.push({ type: 'image', asset: record.assetExternalId })
         target.warn('IMAGE_BLOCK_APPENDED', `asset linked as ${String(record.usageRole ?? 'stem').slice(0, 30)} had no image block; it was appended to the question content`)
      }
   }

   const duplicates = []
   for (const { record, path } of data.question_duplicate_links) {
      if (record.bankCode !== undefined && record.bankCode !== bankCode) {
         collect.error('PACKAGE_BANK_MISMATCH', `${path}.bankCode`, 'duplicate link belongs to another bank', record.questionExternalId ?? null)
         continue
      }
      if (!questionsByExternalId.has(record.questionExternalId) || !questionsByExternalId.has(record.duplicateOfExternalId)) {
         collect.error('REFERENCE_UNKNOWN', path, 'duplicate link references an unknown question', record.questionExternalId ?? null)
         continue
      }
      duplicates.push({
         externalId: record.questionExternalId,
         duplicateOf: record.duplicateOfExternalId,
         ...(typeof record.reason === 'string' && record.reason.trim() ? { reason: record.reason.trim().slice(0, 1000) } : {}),
      })
   }

   const bank = {
      code: bankCode,
      title: bankRecord.title,
      subjectCode: bankRecord.subjectCode,
      ...(bankRecord.visibility === undefined ? {} : { visibility: bankRecord.visibility }),
      source: mapSourceMetadata(bankRecord.sourceMetadata, 'question_banks', collect),
   }
   collect.flushDropped()
   return {
      manifest: {
         schemaVersion,
         sourceNamespace: namespace,
         subjects,
         sections,
         topics,
         bank,
         assets,
         questions,
         duplicates,
      },
      issues: collect.issues,
      questionPaths,
   }
}

export { adaptEntityPackage, isEntityPackage }
