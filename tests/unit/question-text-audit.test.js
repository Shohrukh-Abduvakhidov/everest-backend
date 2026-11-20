import assert from 'node:assert/strict'
import test from 'node:test'

import { adaptEntityPackage } from '../../src/utils/question-package-adapter.js'
import {
   auditQuestion,
   fixContent,
   repairColumnHeaders,
   repairStrandedInitial,
} from '../../src/utils/question-text-audit.js'
import { createPng, entityPackage } from '../helpers/import-fixtures.js'

// Real fragments from the biology book package (nct-bio-tg-2026, A2-5_Biology_tj.pdf).
const reserveStem = 'Мувофиқатро муайян кунед:'
const reserveHeaders = { left: 'Мамнуъгоҳи Тоҷикистон С', right: 'оли ташкилшавӣ' } // matching-0042
const vitaminStem = 'Мувофиқати витамин ва бемориро, ки бо сабаби норасоии ин вита-'
const vitaminHeaders = { left: 'мин пайдо мешавад, муайян н', right: 'амоед:' } // matching-0097
const vitaminHeadersSecond = { left: 'мин зуҳур кардааст, муайян куне', right: 'д:' } // matching-0107

test('a letter stranded between column headers is moved back to its word', () => {
   const repair = repairColumnHeaders(reserveHeaders.left, reserveHeaders.right, {
      previousText: reserveStem,
      language: 'tg',
   })
   assert.equal(repair.status, 'fixed')
   assert.equal(repair.left, 'Мамнуъгоҳи Тоҷикистон')
   assert.equal(repair.right, 'Соли ташкилшавӣ')
})

test('stem text that leaked into the headers is reported, never rewritten', () => {
   for (const headers of [vitaminHeaders, vitaminHeadersSecond]) {
      const repair = repairColumnHeaders(headers.left, headers.right, { previousText: vitaminStem, language: 'tg' })
      assert.equal(repair.status, 'review')
      assert.equal(repair.left, headers.left)
      assert.equal(repair.right, headers.right)
   }
   // A word cut after several letters has no certain split point.
   assert.equal(repairColumnHeaders('Модда ва хосия', 'т', { language: 'tg' }).status, 'review')
   assert.equal(repairColumnHeaders('', 'Мавқеи ҷойгиршавӣ', { language: 'tg' }).status, 'review')
})

test('normal header pairs and single-letter words stay untouched', () => {
   assert.equal(repairColumnHeaders('Мамнуъгоҳ', 'Мавқеи ҷойгиршавӣ', { language: 'tg' }).status, 'ok')
   assert.equal(repairColumnHeaders('Модда', 'формулаи он', { language: 'tg' }).status, 'ok')
   // Russian "и" is a word: "Вещество и | свойства" is not a cut word.
   assert.equal(repairColumnHeaders('Вещество и', 'свойства', { language: 'ru' }).status, 'ok')
   // Tajik "ё" (or) is a word too.
   assert.equal(repairColumnHeaders('Ҳайвон ё', 'растанӣ', { language: 'tg' }).status, 'ok')
})

test('a capital cut off a short item is joined back only when unambiguous', () => {
   assert.equal(repairStrandedInitial('З анбӯруғҳо', 'tg'), 'Занбӯруғҳо')
   assert.equal(repairStrandedInitial('Гулсангҳо', 'tg'), null)
   // A variable in a sentence, a pronoun, a split inside a verse: left for review.
   assert.equal(repairStrandedInitial('Х кадом элемент аст?', 'tg'), null)
   assert.equal(repairStrandedInitial('Ӯ дар мактаб мехонад', 'tg'), null)
   assert.equal(repairStrandedInitial('К и дар пирӣ бидонӣ қадри пирӣ. Носири Хусрав', 'tg'), null)
   assert.equal(repairStrandedInitial('В городе', 'ru'), null)
})

test('the audit finds the split header and the fix keeps keys and order', () => {
   const question = {
      id: '1852',
      type: 'matching',
      language: 'tg',
      content: {
         blocks: [
            { type: 'text', text: reserveStem, marks: ['bold'] },
            { type: 'table', rows: [[reserveHeaders.left, reserveHeaders.right]] },
         ],
      },
      options: [],
      matching: [
         { side: 'left', key: 'l1', content: { blocks: [{ type: 'text', text: 'Ромит' }] } },
         { side: 'left', key: 'l2', content: { blocks: [{ type: 'text', text: 'З анбӯруғҳо' }] } },
         { side: 'right', key: 'r1', content: { blocks: [{ type: 'text', text: '1959' }] } },
         { side: 'right', key: 'r2', content: { blocks: [{ type: 'text', text: '1972' }] } },
      ],
      answerKey: { status: 'verified', answerData: { pairs: [{ left: 'l1', right: 'r2' }, { left: 'l2', right: 'r1' }] } },
   }
   const findings = auditQuestion(question)
   const split = findings.find((finding) => finding.type === 'table_split_word')
   assert.deepEqual(split.fix, { left: 'Мамнуъгоҳи Тоҷикистон', right: 'Соли ташкилшавӣ' })
   assert.equal(split.sample, 'Мамнуъгоҳи Тоҷикистон С | оли ташкилшавӣ')
   const letter = findings.find((finding) => finding.type === 'isolated_letter')
   assert.equal(letter.path, 'matching:left:l2.blocks[0].text')
   assert.deepEqual(letter.fix, { text: 'Занбӯруғҳо' })
   assert.equal(findings.some((finding) => finding.type === 'missing_answer_key'), false)

   const fixed = fixContent(question.content, { language: 'tg' })
   assert.deepEqual(fixed.content.blocks[1], { type: 'table', rows: [['Мамнуъгоҳи Тоҷикистон', 'Соли ташкилшавӣ']] })
   assert.deepEqual(fixed.content.blocks[0], question.content.blocks[0])
   assert.deepEqual(fixed.changes, [{
      path: 'blocks[1].rows[0]',
      rules: ['stranded_letter'],
      before: [reserveHeaders.left, reserveHeaders.right],
      after: ['Мамнуъгоҳи Тоҷикистон', 'Соли ташкилшавӣ'],
   }])
   // Fixing again changes nothing.
   assert.equal(fixContent(fixed.content, { language: 'tg' }), null)
   // The leaked stem is never rewritten.
   assert.equal(fixContent({
      blocks: [
         { type: 'text', text: vitaminStem },
         { type: 'table', rows: [[vitaminHeaders.left, vitaminHeaders.right]] },
      ],
   }, { language: 'tg' }), null)
})

test('the audit reports duplicates, missing keys and damaged characters', () => {
   const text = (value) => ({ blocks: [{ type: 'text', text: value }] })
   const findings = auditQuestion({
      id: '1',
      type: 'single_choice',
      language: 'tg',
      content: text('Савол  бо ду фосила , ва аломати \uFFFD'),
      options: [
         { key: 'a', content: text('АВ, ав') },
         { key: 'b', content: text('АВ, Ав') },
         { key: 'c', content: text('АВ, ав') },
      ],
      matching: [],
      answerKey: null,
   })
   const types = new Set(findings.map((finding) => finding.type))
   for (const type of ['double_space', 'space_before_punctuation', 'replacement_char', 'duplicate_options', 'missing_answer_key']) {
      assert.ok(types.has(type), `${type} missing`)
   }
   // Options that differ only in capitals are different answers.
   const duplicates = findings.filter((finding) => finding.type === 'duplicate_options')
   assert.deepEqual(duplicates.map((finding) => finding.path), ['option:a=c'])
})

test('the package adapter repairs a split column header and flags a leaked stem', () => {
   const { manifest, files } = entityPackage({
      subjectCode: 'unit-subject',
      bankCode: 'unit-bank',
      namespace: 'unit-ns',
      png: createPng(3, 2, 5),
   })
   const questionsFile = 'data/questions.part002.json'
   const document = JSON.parse(files[questionsFile].toString('utf8'))
   const matching = document.records[0]
   const stem = (value) => ({ type: 'paragraph', children: [{ type: 'text', text: value, marks: ['bold'] }] })
   matching.content.blocks = [stem(reserveStem), { type: 'columnHeaders', ...reserveHeaders }]
   const leaked = structuredClone(matching)
   leaked.externalId = 'unit-bank-matching-0002'
   leaked.content.blocks = [stem(vitaminStem), { type: 'columnHeaders', ...vitaminHeaders }]
   document.records.push(leaked)
   const itemsFile = 'data/question_matching_items.json'
   const items = JSON.parse(files[itemsFile].toString('utf8'))
   items.records[0].content.blocks[0].children[0].text = 'З анбӯруғҳо'
   const pkg = {
      manifest: { ...manifest, files: undefined },
      files: new Map(Object.entries({
         ...files,
         [questionsFile]: Buffer.from(JSON.stringify(document)),
         [itemsFile]: Buffer.from(JSON.stringify(items)),
      })),
      sha256: 'x'.repeat(64),
   }
   const { manifest: adapted, issues } = adaptEntityPackage(pkg)
   assert.deepEqual(issues.filter((issue) => issue.severity === 'error'), [])
   const byId = new Map(adapted.questions.map((question) => [question.externalId, question]))
   assert.deepEqual(byId.get('unit-bank-matching-0001').content.blocks[1], {
      type: 'table',
      rows: [['Мамнуъгоҳи Тоҷикистон', 'Соли ташкилшавӣ']],
   })
   assert.equal(byId.get('unit-bank-matching-0001').matching.left[0].content.blocks[0].text, 'Занбӯруғҳо')
   assert.deepEqual(byId.get('unit-bank-matching-0002').content.blocks[1], {
      type: 'table',
      rows: [[vitaminHeaders.left, vitaminHeaders.right]],
   })
   const warnings = (externalId) => issues
      .filter((issue) => issue.externalId === externalId)
      .map((issue) => issue.code)
   assert.ok(warnings('unit-bank-matching-0001').includes('CONTENT_SPLIT_WORD_REPAIRED'))
   assert.ok(warnings('unit-bank-matching-0002').includes('CONTENT_SPLIT_WORD_SUSPECTED'))
   assert.equal(warnings('unit-bank-matching-0002').includes('CONTENT_SPLIT_WORD_REPAIRED'), false)
})
