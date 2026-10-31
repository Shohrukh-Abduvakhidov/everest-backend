import AppError from './app-error.js'
import { normalizeInternalId } from './internal-id.js'

const questionTypes = ['single_choice', 'multiple_choice', 'matching', 'numeric', 'short_text']
const choiceTypes = ['single_choice', 'multiple_choice']
const textMarks = ['bold', 'italic', 'underline', 'subscript', 'superscript']
const itemKeyPattern = /^[A-Za-z0-9_-]{1,20}$/
const maxContentBytes = 65536
const maxBlocks = 100
const sourceMetadataFields = {
   book: 'text',
   edition: 'text',
   page: 'integer',
   number: 'text',
   note: 'text',
   // M09: provenance fields used by real book packages.
   year: 'year',
   sourceFile: 'text',
   printedPage: 'text',
   sequence: 'integer',
   bookSectionTitle: 'text',
   bookRubric: 'text',
   isSample: 'boolean',
   reviewRequired: 'boolean',
   examPart: 'labels',
}

function validationError(field, message = `${field} is invalid`) {
   return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [{ field, message }])
}

function isPlainObject(value) {
   return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireKeys(value, field, allowed) {
   if (!isPlainObject(value)) throw validationError(field)
   const unknown = Object.keys(value).find((key) => !allowed.includes(key))
   if (unknown) throw validationError(field, `${field}.${unknown} is not allowed`)
}

function parseString(value, field, maximum, allowEmpty = false) {
   if (typeof value !== 'string' || value.length > maximum) throw validationError(field)
   if (!allowEmpty && !value.trim()) throw validationError(field)
   return value
}

function parseBlock(block, field, assetIds) {
   if (!isPlainObject(block) || typeof block.type !== 'string') throw validationError(field)
   switch (block.type) {
      case 'text': {
         requireKeys(block, field, ['type', 'text', 'marks'])
         const parsed = { type: 'text', text: parseString(block.text, field, 10000) }
         if (block.marks !== undefined) {
            if (!Array.isArray(block.marks) || block.marks.some((mark) => !textMarks.includes(mark))
               || new Set(block.marks).size !== block.marks.length) {
               throw validationError(field)
            }
            parsed.marks = [...block.marks]
         }
         return parsed
      }
      case 'verse': {
         requireKeys(block, field, ['type', 'lines'])
         if (!Array.isArray(block.lines) || !block.lines.length || block.lines.length > 100) {
            throw validationError(field)
         }
         return { type: 'verse', lines: block.lines.map((line) => parseString(line, field, 1000, true)) }
      }
      case 'formula': {
         requireKeys(block, field, ['type', 'latex', 'display'])
         if (block.display !== undefined && typeof block.display !== 'boolean') throw validationError(field)
         return {
            type: 'formula',
            latex: parseString(block.latex, field, 2000),
            ...(block.display === undefined ? {} : { display: block.display }),
         }
      }
      case 'chemistry': {
         requireKeys(block, field, ['type', 'formula'])
         return { type: 'chemistry', formula: parseString(block.formula, field, 2000) }
      }
      case 'table': {
         requireKeys(block, field, ['type', 'rows'])
         if (!Array.isArray(block.rows) || !block.rows.length || block.rows.length > 50) {
            throw validationError(field)
         }
         const rows = block.rows.map((row) => {
            if (!Array.isArray(row) || !row.length || row.length > 20) throw validationError(field)
            return row.map((cell) => parseString(cell, field, 1000, true))
         })
         return { type: 'table', rows }
      }
      case 'image': {
         requireKeys(block, field, ['type', 'assetId', 'alt'])
         let assetId
         try {
            assetId = normalizeInternalId(block.assetId)
         } catch {
            throw validationError(field)
         }
         assetIds.add(assetId)
         return {
            type: 'image',
            assetId,
            ...(block.alt === undefined ? {} : { alt: parseString(block.alt, field, 500, true) }),
         }
      }
      default:
         throw validationError(field, `${field} block type is not supported`)
   }
}

// Rich content is the shared `{ blocks: [...] }` contract. Every block is rebuilt from an
// allowlist, so unknown properties never reach the database or a later student response.
function parseContent(value, field, assetIds, { allowEmpty = false } = {}) {
   requireKeys(value, field, ['blocks'])
   if (!Array.isArray(value.blocks) || value.blocks.length > maxBlocks
      || (!allowEmpty && !value.blocks.length)) {
      throw validationError(field)
   }
   const content = { blocks: value.blocks.map((block) => parseBlock(block, field, assetIds)) }
   if (Buffer.byteLength(JSON.stringify(content)) > maxContentBytes) {
      throw validationError(field, `${field} is too large`)
   }
   return content
}

function parseItems(value, field, assetIds, maximum) {
   if (!Array.isArray(value) || !value.length || value.length > maximum) throw validationError(field)
   const keys = new Set()
   return value.map((item, index) => {
      requireKeys(item, field, ['key', 'content', 'sourceLabel'])
      if (typeof item.key !== 'string' || !itemKeyPattern.test(item.key) || keys.has(item.key)) {
         throw validationError(field)
      }
      keys.add(item.key)
      return {
         key: item.key,
         position: index + 1,
         sourceLabel: item.sourceLabel === undefined || item.sourceLabel === null
            ? null
            : parseString(item.sourceLabel, field, 50),
         content: parseContent(item.content, field, assetIds),
      }
   })
}

function parseOptions(value, assetIds) {
   const options = parseItems(value, 'options', assetIds, 10)
   if (options.length < 2) throw validationError('options', 'options require at least two items')
   return options
}

function parseMatching(value, assetIds) {
   requireKeys(value, 'matching', ['left', 'right'])
   return {
      left: parseItems(value.left, 'matching', assetIds, 20),
      right: parseItems(value.right, 'matching', assetIds, 20),
   }
}

function parseInteractionSettings(value, questionType) {
   if (questionType !== 'matching') {
      requireKeys(value, 'interactionSettings', [])
      return {}
   }
   requireKeys(value, 'interactionSettings', ['requireAllLeft', 'allowRightReuse'])
   // null = not stated by the source yet. Drafts may keep it; publication requires booleans.
   const isRule = (rule) => typeof rule === 'boolean' || rule === null
   if (!isRule(value.requireAllLeft) || !isRule(value.allowRightReuse)) {
      throw validationError('interactionSettings')
   }
   return { requireAllLeft: value.requireAllLeft, allowRightReuse: value.allowRightReuse }
}

function parseSourceMetadata(value) {
   requireKeys(value, 'sourceMetadata', Object.keys(sourceMetadataFields))
   const parsed = {}
   for (const [field, kind] of Object.entries(sourceMetadataFields)) {
      if (value[field] === undefined) continue
      if (kind === 'integer') {
         if (!Number.isSafeInteger(value[field]) || value[field] < 1) {
            throw validationError('sourceMetadata')
         }
         parsed[field] = value[field]
      } else if (kind === 'boolean') {
         if (typeof value[field] !== 'boolean') throw validationError('sourceMetadata')
         parsed[field] = value[field]
      } else if (kind === 'labels') {
         const labels = value[field]
         if (!Array.isArray(labels) || !labels.length || labels.length > 10
            || labels.some((label) => typeof label !== 'string' || !label.trim() || label.length > 20)) {
            throw validationError('sourceMetadata')
         }
         parsed[field] = labels.map((label) => label.trim())
      } else if (kind === 'year') {
         if (!Number.isSafeInteger(value[field]) || value[field] < 1900 || value[field] > 2100) {
            throw validationError('sourceMetadata')
         }
         parsed[field] = value[field]
      } else {
         parsed[field] = parseString(value[field], 'sourceMetadata', 500).trim()
      }
   }
   return parsed
}

function invalidKey(message) {
   return new AppError(400, 'ANSWER_KEY_INVALID', 'Answer key is invalid', [
      { field: 'answerData', message },
   ])
}

function uniqueStrings(values, maximum) {
   return Array.isArray(values) && values.length > 0 && values.length <= maximum
      && values.every((value) => typeof value === 'string')
      && new Set(values).size === values.length
}

// answer_data references option and matching item KEYS, never row IDs, so a question copy
// keeps a valid key. Every reference is checked against the question's current structure.
function parseAnswerData(value, question) {
   if (!isPlainObject(value)) throw invalidKey('answerData must be an object')
   const optionKeys = new Set((question.options || []).map((option) => option.key))
   const leftKeys = new Set((question.matching?.left || []).map((item) => item.key))
   const rightKeys = new Set((question.matching?.right || []).map((item) => item.key))
   const keys = Object.keys(value)
   switch (question.questionType) {
      case 'single_choice':
         if (keys.join() !== 'optionKey' || !optionKeys.has(value.optionKey)) {
            throw invalidKey('optionKey must reference an existing option')
         }
         return { optionKey: value.optionKey }
      case 'multiple_choice':
         if (keys.join() !== 'optionKeys' || !uniqueStrings(value.optionKeys, optionKeys.size)
            || value.optionKeys.some((key) => !optionKeys.has(key))) {
            throw invalidKey('optionKeys must reference distinct existing options')
         }
         return { optionKeys: [...value.optionKeys] }
      case 'matching': {
         if (keys.join() !== 'pairs' || !Array.isArray(value.pairs) || !value.pairs.length) {
            throw invalidKey('pairs must be a non-empty array')
         }
         const usedLeft = new Set()
         const usedRight = new Set()
         const pairs = value.pairs.map((pair) => {
            if (!isPlainObject(pair) || Object.keys(pair).sort().join() !== 'left,right'
               || !leftKeys.has(pair.left) || !rightKeys.has(pair.right) || usedLeft.has(pair.left)) {
               throw invalidKey('pairs must reference existing items with each left item once')
            }
            // An unstated reuse rule (null) is treated strictly: no reuse.
            if (question.interactionSettings.allowRightReuse !== true && usedRight.has(pair.right)) {
               throw invalidKey('right items cannot be reused')
            }
            usedLeft.add(pair.left)
            usedRight.add(pair.right)
            return { left: pair.left, right: pair.right }
         })
         if (question.interactionSettings.requireAllLeft === true && usedLeft.size !== leftKeys.size) {
            throw invalidKey('every left item must be paired')
         }
         return { pairs }
      }
      case 'numeric':
         if (keys.join() !== 'value' || typeof value.value !== 'number' || !Number.isFinite(value.value)) {
            throw invalidKey('value must be a finite number')
         }
         return { value: value.value }
      case 'short_text':
         if (keys.join() !== 'acceptedAnswers' || !uniqueStrings(value.acceptedAnswers, 20)
            || value.acceptedAnswers.some((answer) => !answer.trim() || answer.length > 500)) {
            throw invalidKey('acceptedAnswers must be distinct non-empty strings')
         }
         return { acceptedAnswers: [...value.acceptedAnswers] }
      default:
         throw invalidKey('question type is not supported')
   }
}

function isValidAnswerData(value, question) {
   try {
      parseAnswerData(value, question)
      return true
   } catch {
      return false
   }
}

function hasCompleteInteractionSettings(questionType, settings) {
   return questionType !== 'matching'
      || (typeof settings?.requireAllLeft === 'boolean' && typeof settings?.allowRightReuse === 'boolean')
}

export {
   choiceTypes,
   hasCompleteInteractionSettings,
   isPlainObject,
   isValidAnswerData,
   parseAnswerData,
   parseContent,
   parseInteractionSettings,
   parseMatching,
   parseOptions,
   parseSourceMetadata,
   questionTypes,
   requireKeys,
}
