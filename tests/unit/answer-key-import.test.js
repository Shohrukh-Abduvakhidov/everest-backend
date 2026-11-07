import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { canonicalAnswer, parseKeyFile, planMatchingRules } from '../../src/services/answer-key-import-service.js'
import { parseAnswerKeyFileBuffer } from '../../src/utils/answer-key-file.js'

const fixturePath = path.resolve('tests/fixtures/answer-keys/sample-keys.json')

async function fixture() {
   return JSON.parse(await readFile(fixturePath, 'utf8'))
}

function codes(errors) {
   return [...new Set(errors.map((error) => error.code))].sort()
}

test('the committed synthetic key file parses without errors', async () => {
   const keyFile = parseAnswerKeyFileBuffer(await readFile(fixturePath))
   assert.match(keyFile.sha256, /^[a-f0-9]{64}$/)
   const parsed = parseKeyFile(keyFile.document, 'synthetic-bank')
   assert.deepEqual(parsed.errors, [])
   assert.equal(parsed.records.length, 2)
   assert.deepEqual(parsed.header.keySource, {
      filename: 'synthetic-key.pdf',
      sha256: '0'.repeat(64),
      pages: 1,
   })
   assert.deepEqual(parsed.records[0].explanation, { blocks: [] })
})

test('file-level validation collects header and record errors', async () => {
   const base = await fixture()
   assert.deepEqual(codes(parseKeyFile({ ...base, schemaVersion: 'v0' }).errors), ['KEY_FILE_SCHEMA_VERSION_UNSUPPORTED'])
   assert.deepEqual(codes(parseKeyFile({ ...base, extra: 1 }).errors), ['KEY_FILE_FIELD_UNKNOWN'])
   assert.deepEqual(codes(parseKeyFile({ ...base, keySource: { filename: 'x.pdf' } }).errors), ['KEY_FILE_HEADER_INVALID'])
   assert.deepEqual(codes(parseKeyFile(base, 'another-bank').errors), ['KEY_FILE_BANK_MISMATCH'])
   assert.deepEqual(codes(parseKeyFile({ ...base, records: [] }).errors), ['KEY_FILE_SCHEMA_INVALID'])
   assert.deepEqual(codes(parseKeyFile([]).errors), ['KEY_FILE_SCHEMA_INVALID'])

   const [single, matching] = base.records
   const withRecords = (...records) => parseKeyFile({ ...base, records })
   assert.deepEqual(codes(withRecords(single, { ...single }).errors), ['KEY_RECORD_DUPLICATE'])
   assert.deepEqual(codes(withRecords({ ...single, status: 'verified' }).errors), ['ANSWER_KEY_VERIFIED_REJECTED'])
   assert.deepEqual(codes(withRecords({ ...single, status: 'unknown' }).errors), ['ANSWER_KEY_STATUS_INVALID'])
   assert.deepEqual(codes(withRecords({ ...single, source: 'ai_inference' }).errors), ['ANSWER_KEY_SOURCE_REJECTED'])
   assert.deepEqual(codes(withRecords({ ...single, source: 'none' }).errors), ['ANSWER_KEY_SOURCE_REJECTED'])
   assert.deepEqual(codes(withRecords({ ...matching, answerDataExternal: undefined }).errors), ['ANSWER_DATA_REQUIRED'])
   assert.deepEqual(codes(withRecords({ ...single, bankCode: 'other' }).errors), ['KEY_RECORD_BANK_MISMATCH'])
   assert.deepEqual(codes(withRecords({ ...single, questionExternalId: ' ' }).errors), ['KEY_RECORD_EXTERNAL_ID_INVALID'])
   assert.deepEqual(codes(withRecords({ ...single, isCorrect: true }).errors), ['KEY_FILE_FIELD_UNKNOWN'])
   assert.deepEqual(codes(withRecords({
      ...single,
      explanation: { blocks: [{ type: 'image', assetExternalId: 'fig-1' }] },
   }).errors), ['EXPLANATION_INVALID'])
   // Package-external explanation paragraphs are converted to stored rich content.
   const explained = withRecords({
      ...single,
      explanation: { blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'Because.' }] }] },
   })
   assert.deepEqual(explained.errors, [])
   assert.deepEqual(explained.records[0].explanation, { blocks: [{ type: 'text', text: 'Because.' }] })
})

test('answers compare without depending on pair or option order', () => {
   assert.equal(
      canonicalAnswer({ pairs: [{ left: 'l2', right: 'r1' }, { left: 'l1', right: 'r2' }] }),
      canonicalAnswer({ pairs: [{ right: 'r2', left: 'l1' }, { left: 'l2', right: 'r1' }] }),
   )
   assert.notEqual(canonicalAnswer({ optionKey: 'a' }), canonicalAnswer({ optionKey: 'b' }))
   assert.equal(canonicalAnswer({ optionKeys: ['b', 'a'] }), canonicalAnswer({ optionKeys: ['a', 'b'] }))
})

test('matching rules are decided per field and never overwrite a boolean', () => {
   const left = ['l1', 'l2', 'l3']
   const full = [{ left: 'l1', right: 'r1' }, { left: 'l2', right: 'r2' }, { left: 'l3', right: 'r3' }]
   const both = planMatchingRules({ requireAllLeft: null, allowRightReuse: null }, left, full)
   assert.equal(both.requireAllLeft, 'REQUIRE_ALL_LEFT_SET')
   assert.equal(both.allowRightReuse, 'RIGHT_REUSE_SET_FALSE')
   assert.deepEqual(both.next, { requireAllLeft: true, allowRightReuse: false })
   assert.equal(both.changed, true)

   const partial = planMatchingRules({ requireAllLeft: null, allowRightReuse: null }, left, full.slice(0, 2))
   assert.equal(partial.requireAllLeft, 'REQUIRE_ALL_LEFT_SKIPPED_NOT_COVERED')
   assert.deepEqual(partial.next, { requireAllLeft: null, allowRightReuse: false })

   const reused = planMatchingRules({ requireAllLeft: null, allowRightReuse: null }, left, [
      { left: 'l1', right: 'r1' }, { left: 'l2', right: 'r1' }, { left: 'l3', right: 'r2' },
   ])
   assert.equal(reused.allowRightReuse, 'RIGHT_REUSE_SKIPPED_NOT_DISTINCT')
   assert.equal(reused.next.allowRightReuse, null)

   const set = planMatchingRules({ requireAllLeft: false, allowRightReuse: true }, left, full)
   assert.equal(set.requireAllLeft, 'REQUIRE_ALL_LEFT_SKIPPED_ALREADY_SET')
   assert.equal(set.allowRightReuse, 'RIGHT_REUSE_SKIPPED_ALREADY_SET')
   assert.deepEqual(set.next, { requireAllLeft: false, allowRightReuse: true })
   assert.equal(set.changed, false)

   // A missing key in stored settings counts as null.
   const missing = planMatchingRules({ requireAllLeft: true }, left, full)
   assert.equal(missing.requireAllLeft, 'REQUIRE_ALL_LEFT_SKIPPED_ALREADY_SET')
   assert.equal(missing.allowRightReuse, 'RIGHT_REUSE_SET_FALSE')
})
