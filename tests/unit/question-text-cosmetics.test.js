import assert from 'node:assert/strict'
import test from 'node:test'

import { excludedQuestions, hyphenJoinQuestions, planChanges } from '../../scripts/question-text-plan.js'
import {
   collapseDoubleSpaces,
   fixContent,
   joinHyphenWraps,
   joinHyphenWrapsAcrossLines,
   removeSpaceBeforePunctuation,
} from '../../src/utils/question-text-audit.js'

// Fragments from the local banks (nct-*-tg-2026), as printed by the audit.

test('cosmetic: a space before , . ; : ! ? ) is removed after a letter only', () => {
   assert.equal(removeSpaceBeforePunctuation('гуфта буд . Сотим'), 'гуфта буд. Сотим')
   assert.equal(removeSpaceBeforePunctuation('Сухан , к-аз дил'), 'Сухан, к-аз дил')
   assert.equal(removeSpaceBeforePunctuation('як ; ду'), 'як; ду')
   assert.equal(removeSpaceBeforePunctuation('Мисол : ин'), 'Мисол: ин')
   assert.equal(removeSpaceBeforePunctuation('надравӣ !'), 'надравӣ!')
   assert.equal(removeSpaceBeforePunctuation('чӣ гуна ?'), 'чӣ гуна?')
   assert.equal(removeSpaceBeforePunctuation('ҳертс (Ҳс )'), 'ҳертс (Ҳс)')
   assert.equal(removeSpaceBeforePunctuation('3-юм  , гурӯҳи'), '3-юм, гурӯҳи')
   // Blanks, ellipses, ratios, digits and symbols keep their spaces.
   assert.equal(removeSpaceBeforePunctuation('бувад ... .'), 'бувад ... .')
   assert.equal(removeSpaceBeforePunctuation('бувад ...'), 'бувад ...')
   assert.equal(removeSpaceBeforePunctuation('нисбати 2 : 3'), 'нисбати 2 : 3')
   assert.equal(removeSpaceBeforePunctuation('ҳертс (Ҳс)'), 'ҳертс (Ҳс)')
   assert.equal(removeSpaceBeforePunctuation('Na+ ?'), 'Na+ ?')
})

test('cosmetic: runs of spaces inside a text collapse to one', () => {
   assert.equal(collapseDoubleSpaces('¹¹₅B  → ⁴₂He'), '¹¹₅B → ⁴₂He')
   assert.equal(collapseDoubleSpaces('a    b  c'), 'a b c')
   // Leading and trailing spaces, tabs, line breaks and no-break spaces stay.
   assert.equal(collapseDoubleSpaces('  a b  '), '  a b  ')
   assert.equal(collapseDoubleSpaces('a\t\tb'), 'a\t\tb')
   assert.equal(collapseDoubleSpaces('a\n\nb'), 'a\n\nb')
   assert.equal(collapseDoubleSpaces('a  b'), 'a  b')
})

test('hyphen join: inside a text and across verse lines', () => {
   assert.equal(joinHyphenWraps('майдони электро- магнитӣ'), 'майдони электромагнитӣ')
   assert.equal(joinHyphenWraps('аз мар- казаш ғафстаранд'), 'аз марказаш ғафстаранд')
   // A capital after the hyphen, a hyphen without a space and a dash between spaces stay.
   assert.equal(joinHyphenWraps('Ҳамадон- Самарқанд'), 'Ҳамадон- Самарқанд')
   assert.equal(joinHyphenWraps('к-аз дил'), 'к-аз дил')
   assert.equal(joinHyphenWraps('Фарзанд - меваи ширин'), 'Фарзанд - меваи ширин')
   assert.deepEqual(
      joinHyphenWrapsAcrossLines(['меҳмонон бархоста хайру-', 'хуш карданд. Сотим Улуғзода']),
      ['меҳмонон бархоста хайрухуш', 'карданд. Сотим Улуғзода'],
   )
   assert.deepEqual(joinHyphenWrapsAcrossLines(['электро-', 'магнитӣ']), ['электромагнитӣ'])
   assert.deepEqual(joinHyphenWrapsAcrossLines(['Ҳамадон-', 'Самарқанд']), ['Ҳамадон-', 'Самарқанд'])
   assert.deepEqual(joinHyphenWrapsAcrossLines(['бустон,', 'бо баргу']), ['бустон,', 'бо баргу'])
})

test('fixContent: cosmetic rules by default, hyphen join only when asked, formulas untouched', () => {
   const content = {
      blocks: [
         { type: 'text', text: 'Агар  ду резисторро ҷудо кунем , чӣ мешавад ?' },
         { type: 'formula', latex: 'a  +  b , c' },
         { type: 'verse', lines: ['Ки гар хор корӣ, суман надравӣ !', 'бархоста хайру-', 'хуш карданд'] },
         { type: 'table', rows: [['Модда  ва хосият', 'Формула )']] },
      ],
   }
   const fixed = fixContent(content, { language: 'tg' })
   assert.equal(fixed.content.blocks[0].text, 'Агар ду резисторро ҷудо кунем, чӣ мешавад?')
   assert.deepEqual(fixed.content.blocks[1], content.blocks[1])
   assert.deepEqual(fixed.content.blocks[2].lines, ['Ки гар хор корӣ, суман надравӣ!', 'бархоста хайру-', 'хуш карданд'])
   assert.deepEqual(fixed.content.blocks[3].rows, [['Модда ва хосият', 'Формула)']])
   assert.deepEqual(fixed.changes.map((change) => [change.path, change.rules]), [
      ['blocks[0].text', ['collapse_double_space', 'space_before_punctuation']],
      ['blocks[2].lines', ['space_before_punctuation']],
      ['blocks[3].rows[0][0]', ['collapse_double_space']],
      ['blocks[3].rows[0][1]', ['space_before_punctuation']],
   ])
   // The source document is not modified.
   assert.equal(content.blocks[0].text, 'Агар  ду резисторро ҷудо кунем , чӣ мешавад ?')

   const joined = fixContent(content, { language: 'tg', joinHyphens: true })
   assert.deepEqual(joined.content.blocks[2].lines, ['Ки гар хор корӣ, суман надравӣ!', 'бархоста хайрухуш', 'карданд'])
   assert.deepEqual(joined.changes[1].rules, ['space_before_punctuation', 'join_hyphen_wrap_lines'])
   assert.equal(fixContent(joined.content, { language: 'tg', joinHyphens: true }), null, 'fixing twice changes nothing')
   assert.equal(fixContent({ blocks: [{ type: 'text', text: 'электро- магнитӣ' }] }, { language: 'tg' }), null)
   assert.equal(fixContent(content, { language: 'tg', cosmetic: false }), null)
})

function textContent(value) {
   return { blocks: [{ type: 'text', text: value }] }
}

function question(id, bankCode, externalId, stem, items = []) {
   return {
      id,
      externalId,
      bankCode,
      type: 'matching',
      language: 'tg',
      status: 'published',
      attemptUses: 0,
      content: textContent(stem),
      options: [],
      matching: items.map((value, index) => ({
         rowId: `${id}0${index}`,
         side: 'left',
         key: `l${index + 1}`,
         content: textContent(value),
      })).concat(items.length ? [{ rowId: `${id}99`, side: 'right', key: 'r1', content: textContent('1959') }] : []),
      answerKey: { status: 'verified', answerData: { pairs: items.map((_, index) => ({ left: `l${index + 1}`, right: 'r1' })) } },
   }
}

test('plan: listed questions get the hyphen join, excluded questions are never changed', () => {
   const joinList = [
      { id: '1', bankCode: 'bank', externalId: 'bank-1' },
      { id: '9', bankCode: 'bank', externalId: 'bank-9' },
   ]
   const excludedList = [
      { id: '2', bankCode: 'bank', externalId: 'bank-2' },
      { id: '3', bankCode: 'demo', externalId: null },
   ]
   const questions = [
      question('1', 'bank', 'bank-1', 'Мувофиқатро муайян кунед :', ['майдони электро- магнитӣ']),
      question('2', 'bank', 'bank-2', 'Фарзанд- меваи ширин  ва  ғайра .'),
      question('3', 'demo', null, 'Салом , дӯст'),
      question('4', 'bank', 'bank-4', 'Фарзанд- меваи ширин .'),
      // The externalId of a listed question in another bank is not listed.
      question('5', 'other', 'bank-1', 'электро- магнитӣ'),
   ]
   const plan = planChanges(questions, { joinList, excludedList })
   const changed = (id) => plan.changes.filter((change) => change.questionId === id)
   assert.deepEqual(changed('1').map((change) => change.label), ['content', 'matching:left:l1'])
   assert.equal(changed('1')[1].after.blocks[0].text, 'майдони электромагнитӣ')
   assert.equal(changed('1')[0].after.blocks[0].text, 'Мувофиқатро муайян кунед:')
   assert.deepEqual(changed('2'), [])
   assert.deepEqual(changed('3'), [])
   const fourth = changed('4')
   assert.equal(fourth.length, 1)
   assert.equal(fourth[0].after.blocks[0].text, 'Фарзанд- меваи ширин.', 'no join outside the list')
   assert.deepEqual(changed('5'), [])
   assert.deepEqual(plan.excluded.map((item) => item.questionId), ['2', '3'])

   // Review lists what is left after the changes, and every finding of an excluded question.
   // (Questions without matching items also report missing_answer_key; not relevant here.)
   const review = (id) => plan.review
      .filter((item) => item.questionId === id && item.type !== 'missing_answer_key')
      .map((item) => item.type)
   assert.deepEqual(review('1'), [])
   assert.ok(review('2').includes('double_space'))
   assert.ok(review('2').includes('hyphen_line_wrap'))
   assert.ok(plan.review.filter((item) => item.questionId === '2').every((item) => item.excluded === true))
   assert.deepEqual(review('4'), ['hyphen_line_wrap'])
   assert.deepEqual(review('5'), ['hyphen_line_wrap'])

   // A listed question that is missing (or has nothing to join) is reported.
   assert.deepEqual(plan.joinNotApplied, [{ id: '9', bankCode: 'bank', externalId: 'bank-9', loaded: false }])
   assert.deepEqual(planChanges(questions, { bankCode: 'demo', joinList, excludedList }).joinNotApplied, [])
})

test('plan: the shipped lists name the agreed questions', () => {
   assert.deepEqual(hyphenJoinQuestions.map((entry) => entry.id), ['1898', '1906', '2589', '2600', '2627'])
   assert.deepEqual(excludedQuestions.map((entry) => entry.id), ['1907', '1917', '1102', '904', '956', '291', '1109'])
   const joinIds = new Set(hyphenJoinQuestions.map((entry) => entry.externalId))
   assert.equal(excludedQuestions.some((entry) => entry.externalId && joinIds.has(entry.externalId)), false)
})
