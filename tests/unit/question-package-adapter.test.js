import assert from 'node:assert/strict'
import test from 'node:test'

import { adaptEntityPackage, isEntityPackage } from '../../src/utils/question-package-adapter.js'
import { createPng, entityPackage } from '../helpers/import-fixtures.js'

function load(options = {}) {
   const { manifest, files } = entityPackage({
      subjectCode: 'unit-subject',
      bankCode: 'unit-bank',
      namespace: 'unit-ns',
      png: createPng(3, 2, 5),
      ...options,
   })
   return { manifest, files: new Map(Object.entries(files)), sha256: 'x'.repeat(64) }
}

function codes(issues, severity) {
   return [...new Set(issues.filter((issue) => issue.severity === severity).map((issue) => issue.code))].sort()
}

test('entity-file packages are detected and mapped to the internal model', () => {
   const pkg = load()
   assert.equal(isEntityPackage(pkg), true)
   assert.equal(isEntityPackage({ manifest: { bank: {} }, files: pkg.files }), false)
   const { manifest, issues, questionPaths } = adaptEntityPackage(pkg)
   assert.deepEqual(codes(issues, 'error'), [])
   assert.equal(manifest.bank.code, 'unit-bank')
   assert.deepEqual(manifest.bank.source, { year: 2026, sourceFile: 'synthetic.pdf' })
   assert.equal(manifest.subjects[0].translations.tg.title, 'Synthetic subject')
   assert.equal(manifest.topics[0].sectionCode, 'part-a')
   assert.equal(manifest.questions.length, 5)
   assert.equal(questionPaths[3], 'data/questions.part002.json#records[0]')

   const [single, linked, , matching, open] = manifest.questions
   // Mixed inline marks collapse to the marks shared by the whole paragraph.
   assert.deepEqual(single.content.blocks[0], { type: 'text', text: 'Synthetic stem with mixed marks', marks: ['bold'] })
   assert.deepEqual(single.content.blocks[1], { type: 'image', asset: 'fig-1', alt: 'Synthetic figure' })
   assert.deepEqual(single.options[0], { key: 'a', label: 'A)', content: { blocks: [{ type: 'text', text: 'alpha a' }] } })
   assert.deepEqual(single.source, {
      page: 3, number: '7', sourceFile: 'synthetic.pdf', printedPage: '3', sequence: 1,
      bookSectionTitle: 'Synthetic section', isSample: false, examPart: ['A'], reviewRequired: false,
   })
   assert.deepEqual(single.topicCodes, ['topic-a'])
   assert.deepEqual(single.answerKey, { status: 'unknown', source: 'none', explanation: { blocks: [] } })
   // A question_assets link without an image block becomes an appended image block.
   assert.deepEqual(linked.content.blocks.at(-1), { type: 'image', asset: 'fig-1' })
   assert.deepEqual(matching.interactionSettings, { requireAllLeft: true, allowRightReuse: null })
   assert.deepEqual(matching.content.blocks[1], { type: 'table', rows: [['Term', 'Meaning']] })
   assert.deepEqual(matching.matching.right.map((item) => item.key), ['r1', 'r2', 'r3'])
   assert.equal(open.type, 'short_text')
   assert.equal(open.interactionSettings, undefined)
   assert.deepEqual(open.content.blocks[0], { type: 'verse', lines: ['Line one', 'Line two'] })
   assert.deepEqual(manifest.duplicates, [{
      externalId: 'unit-bank-single-0003',
      duplicateOf: 'unit-bank-single-0001',
      reason: 'synthetic full-text duplicate',
   }])
   assert.deepEqual(manifest.assets[0].sourceMetadata, { extractionMethod: 'synthetic', pageIndex1Based: 3 })

   assert.deepEqual(codes(issues, 'warning'), [
      'CONTENT_INLINE_MARKS_FLATTENED',
      'IMAGE_BLOCK_APPENDED',
      'INTERACTION_SETTINGS_DROPPED',
      'MATCHING_COLUMN_HEADERS_AS_TABLE',
      'QUESTION_TYPE_MAPPED',
      'SOURCE_FIELD_DROPPED',
   ])
   const dropped = issues.filter((issue) => issue.code === 'SOURCE_FIELD_DROPPED').map((issue) => `${issue.path}:${issue.message.split(' ')[0]}`)
   for (const field of [
      'data/questions:sectionCode',
      'data/questions:difficultyReason',
      'data/questions.sourceMetadata:bbox',
      'data/sections:position',
      'data/topics:metadata',
      'data/question_options:sourceMetadata',
      'data/question_topics:isPrimary',
      'data/question_banks:primaryLanguage',
      'data/question_banks.sourceMetadata:totalPdfPages',
   ]) assert.ok(dropped.includes(field), `${field} missing from ${dropped}`)
   // Warnings never repeat for the same code and record.
   const keys = issues.map((issue) => `${issue.code}|${issue.path}|${issue.message}`)
   assert.equal(new Set(keys).size, keys.length)
})

test('answerDataExternal is converted to EVEREST answer data', () => {
   const { manifest } = adaptEntityPackage(load({
      answerKeys: {
         'single-0001': { status: 'proposed', source: 'official_key', answerDataExternal: { optionKeys: ['b'] } },
         'matching-0001': {
            status: 'proposed',
            source: 'expert_review',
            answerDataExternal: { pairs: [{ leftKey: 'l1', rightKey: 'r2' }] },
         },
         'open-0001': {
            status: 'proposed',
            source: 'official_key',
            answerDataExternal: { acceptedAnswers: ['0042'], normalization: 'trim' },
         },
      },
   }))
   const keyOf = (externalId) => manifest.questions.find((question) => question.externalId === externalId).answerKey
   assert.deepEqual(keyOf('unit-bank-single-0001').answerData, { optionKey: 'b' })
   assert.deepEqual(keyOf('unit-bank-matching-0001').answerData, { pairs: [{ left: 'l1', right: 'r2' }] })
   assert.deepEqual(keyOf('unit-bank-open-0001').answerData, { acceptedAnswers: ['0042'] })
})

test('broken references, hashes, envelopes and multiple banks are errors', () => {
   const pkg = load()
   pkg.files.set('data/question_options.part001.json', Buffer.from(JSON.stringify({
      schemaVersion: 'everest.question-import.v1',
      entity: 'question_options',
      records: [{ bankCode: 'unit-bank', questionExternalId: 'missing', optionKey: 'a', position: 1, content: { blocks: [] } }],
   })))
   pkg.files.set('data/extra.json', Buffer.from(JSON.stringify({ schemaVersion: 'everest.question-import.v1', entity: 'pages', records: [] })))
   pkg.files.set('data/broken.json', Buffer.from('{'))
   const { issues } = adaptEntityPackage(pkg)
   const errors = codes(issues, 'error')
   for (const code of ['PACKAGE_FILE_HASH_MISMATCH', 'REFERENCE_UNKNOWN', 'PACKAGE_ENTITY_UNKNOWN', 'PACKAGE_JSON_INVALID']) {
      assert.ok(errors.includes(code), `${code} missing from ${errors}`)
   }

   const twoBanks = load()
   twoBanks.manifest.files = []
   const banks = JSON.parse(twoBanks.files.get('data/question_banks.json'))
   banks.records.push({ ...banks.records[0], code: 'other-bank' })
   twoBanks.files.set('data/question_banks.json', Buffer.from(JSON.stringify(banks)))
   const result = adaptEntityPackage(twoBanks)
   assert.equal(result.manifest, null)
   assert.deepEqual(codes(result.issues, 'error'), ['PACKAGE_BANK_COUNT_UNSUPPORTED'])
})
