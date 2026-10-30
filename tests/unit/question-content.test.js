import assert from 'node:assert/strict'
import test from 'node:test'

import {
   isValidAnswerData,
   parseAnswerData,
   parseContent,
   parseInteractionSettings,
   parseOptions,
   parseSourceMetadata,
} from '../../src/utils/question-content.js'

const choice = {
   questionType: 'multiple_choice',
   interactionSettings: {},
   options: [{ key: 'a' }, { key: 'b' }, { key: 'c' }],
}
const matching = {
   questionType: 'matching',
   interactionSettings: { requireAllLeft: false, allowRightReuse: true },
   matching: { left: [{ key: '1' }, { key: '2' }], right: [{ key: 'x' }] },
}

test('content blocks are rebuilt from an allowlist and collect image assets', () => {
   const assetIds = new Set()
   const content = parseContent({
      blocks: [
         { type: 'text', text: 'H2O', marks: ['bold'] },
         { type: 'chemistry', formula: 'H_2O' },
         { type: 'formula', latex: 'x^2', display: true },
         { type: 'verse', lines: ['line one', ''] },
         { type: 'table', rows: [['a', 'b'], ['1', '2']] },
         { type: 'image', assetId: '42', alt: '' },
      ],
   }, 'content', assetIds)
   assert.equal(content.blocks.length, 6)
   assert.deepEqual([...assetIds], ['42'])
   assert.throws(() => parseContent({ blocks: [] }, 'content', new Set()), { code: 'VALIDATION_ERROR' })
   assert.deepEqual(parseContent({ blocks: [] }, 'explanation', new Set(), { allowEmpty: true }), { blocks: [] })
   assert.throws(() => parseContent({ blocks: [{ type: 'text', text: 'x', html: '<b>' }] }, 'content', new Set()))
   assert.throws(() => parseContent({ blocks: [{ type: 'text', text: 'x', marks: ['bold', 'bold'] }] }, 'content', new Set()))
   assert.throws(() => parseContent({ blocks: [{ type: 'image', assetId: '0' }] }, 'content', new Set()))
   assert.throws(() => parseContent({ blocks: [{ type: 'text', text: 'x'.repeat(10001) }] }, 'content', new Set()))
   assert.throws(() => parseContent({ blocks: [], extra: 1 }, 'content', new Set()))
})

test('options require distinct safe keys and no correctness flag', () => {
   const options = parseOptions([
      { key: 'a', content: { blocks: [{ type: 'text', text: '1' }] } },
      { key: 'b', sourceLabel: 'B)', content: { blocks: [{ type: 'text', text: '2' }] } },
   ], new Set())
   assert.deepEqual(options.map((option) => option.position), [1, 2])
   const option = (key, extra = {}) => ({ key, content: { blocks: [{ type: 'text', text: key }] }, ...extra })
   assert.throws(() => parseOptions([option('a'), option('a')], new Set()))
   assert.throws(() => parseOptions([option('a b'), option('c')], new Set()))
   assert.throws(() => parseOptions([option('a', { isCorrect: true }), option('b')], new Set()))
})

test('interaction settings exist only for matching questions', () => {
   assert.deepEqual(parseInteractionSettings({}, 'numeric'), {})
   assert.throws(() => parseInteractionSettings({ shuffle: true }, 'single_choice'))
   assert.throws(() => parseInteractionSettings({ requireAllLeft: true }, 'matching'))
   assert.deepEqual(
      parseInteractionSettings({ requireAllLeft: true, allowRightReuse: false }, 'matching'),
      { requireAllLeft: true, allowRightReuse: false },
   )
})

test('source metadata accepts only known fields', () => {
   assert.deepEqual(parseSourceMetadata({ book: ' Book ', page: 3 }), { book: 'Book', page: 3 })
   assert.throws(() => parseSourceMetadata({ page: 0 }))
   assert.throws(() => parseSourceMetadata({ url: 'x' }))
})

test('answer data references existing keys for every question type', () => {
   assert.deepEqual(parseAnswerData({ optionKeys: ['a', 'c'] }, choice), { optionKeys: ['a', 'c'] })
   assert.throws(() => parseAnswerData({ optionKeys: [] }, choice), { code: 'ANSWER_KEY_INVALID' })
   assert.throws(() => parseAnswerData({ optionKeys: ['a', 'a'] }, choice), { code: 'ANSWER_KEY_INVALID' })
   assert.throws(() => parseAnswerData({ optionKeys: ['d'] }, choice), { code: 'ANSWER_KEY_INVALID' })
   assert.throws(() => parseAnswerData({ optionKey: 'a' }, choice), { code: 'ANSWER_KEY_INVALID' })
   assert.equal(isValidAnswerData({ optionKey: 'a' }, { ...choice, questionType: 'single_choice' }), true)

   assert.deepEqual(
      parseAnswerData({ pairs: [{ left: '1', right: 'x' }, { left: '2', right: 'x' }] }, matching),
      { pairs: [{ left: '1', right: 'x' }, { left: '2', right: 'x' }] },
   )
   assert.equal(isValidAnswerData({ pairs: [{ left: '1', right: 'x' }] }, matching), true)
   assert.equal(isValidAnswerData({ pairs: [{ left: '1', right: 'x' }, { left: '1', right: 'x' }] }, matching), false)
   assert.equal(isValidAnswerData({ pairs: [{ left: '1', right: 'y' }] }, matching), false)
   assert.equal(isValidAnswerData({
      pairs: [{ left: '1', right: 'x' }],
   }, { ...matching, interactionSettings: { requireAllLeft: true, allowRightReuse: true } }), false)
   assert.equal(isValidAnswerData({
      pairs: [{ left: '1', right: 'x' }, { left: '2', right: 'x' }],
   }, { ...matching, interactionSettings: { requireAllLeft: false, allowRightReuse: false } }), false)

   const numeric = { questionType: 'numeric', interactionSettings: {} }
   assert.deepEqual(parseAnswerData({ value: -1.5 }, numeric), { value: -1.5 })
   assert.equal(isValidAnswerData({ value: Number.NaN }, numeric), false)
   assert.equal(isValidAnswerData({ value: 1, tolerance: 0.1 }, numeric), false)

   const shortText = { questionType: 'short_text', interactionSettings: {} }
   assert.equal(isValidAnswerData({ acceptedAnswers: ['a', 'b'] }, shortText), true)
   assert.equal(isValidAnswerData({ acceptedAnswers: [' '] }, shortText), false)
   assert.equal(isValidAnswerData({ acceptedAnswers: ['a', 'a'] }, shortText), false)
})
