import assert from 'node:assert/strict'
import test from 'node:test'

import { canonicalDigits, gradeAnswer, parseStudentAnswer } from '../../src/utils/attempt-grading.js'

const cells = { questionType: 'numeric', answerFormat: 'digits', maxDigits: 4, acceptedDigits: ['120'] }
const matching = {
   questionType: 'matching',
   leftKeys: ['l1', 'l2', 'l3', 'l4'],
   rightKeys: ['r1', 'r2', 'r3', 'r4', 'r5'],
   interactionSettings: { allowRightReuse: false },
   answerData: { pairs: [{ left: 'l1', right: 'r1' }, { left: 'l2', right: 'r2' }, { left: 'l3', right: 'r3' }, { left: 'l4', right: 'r4' }] },
}

test('cells take only 1-4 digits', () => {
   assert.deepEqual(parseStudentAnswer({ digits: '0120' }, cells), { digits: '0120' })
   assert.equal(parseStudentAnswer(null, cells), null)
   for (const answer of [{ digits: '12345' }, { digits: '' }, { digits: '1.2' }, { digits: '-1' }, { digits: '１２' }, { digits: 12 }, { value: 120 }, { digits: '1', extra: 1 }]) {
      assert.throws(() => parseStudentAnswer(answer, cells), { code: 'VALIDATION_ERROR' }, JSON.stringify(answer))
   }
})

test('cells give 2 points for the right digits and 0 otherwise; leading zeros do not count', () => {
   assert.equal(canonicalDigits('0000'), '0')
   assert.equal(canonicalDigits('0120'), '120')
   assert.equal(gradeAnswer({ digits: '120' }, cells, '2.00'), '2.00')
   assert.equal(gradeAnswer({ digits: '0120' }, cells, '2.00'), '2.00')
   assert.equal(gradeAnswer({ digits: '121' }, cells, '2.00'), '0.00')
   assert.equal(gradeAnswer(null, cells, '2.00'), '0.00')
})

test('matching 4x5 at 4 points gives 1 point per right pair', () => {
   const answer = (correct) => ({
      pairs: matching.answerData.pairs.map((pair, index) => (index < correct ? pair : { left: pair.left, right: index === 3 ? 'r5' : `r${index + 2}` })),
   })
   const expected = ['0.00', '1.00', '2.00', '3.00', '4.00']
   for (let correct = 0; correct <= 4; correct += 1) {
      const parsed = parseStudentAnswer(answer(correct), matching)
      assert.equal(gradeAnswer(parsed, matching, '4.00'), expected[correct], `${correct} right pairs`)
   }
   assert.equal(gradeAnswer({ pairs: [{ left: 'l1', right: 'r1' }] }, matching, '4.00'), '1.00')
})
