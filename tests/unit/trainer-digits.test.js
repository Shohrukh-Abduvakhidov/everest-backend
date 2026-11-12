import assert from 'node:assert/strict'
import test from 'node:test'

import { digitsSheet, digitsSnapshot, gradeAnswer, parseStudentAnswer } from '../../src/utils/attempt-grading.js'

const trainerCells = {
   questionType: 'numeric',
   answerData: { value: 1434 },
   ...digitsSnapshot('numeric', { value: 1434 }, 4, { acceptsValue: true }),
}
const examCells = { questionType: 'numeric', answerData: { value: 1434 }, ...digitsSnapshot('numeric', { value: 1434 }, 4) }
const legacyNumeric = { questionType: 'numeric', answerData: { value: 1434 } }

test('digitsSnapshot keeps the mock exam fields; short_text spaces and leading zeros are dropped', () => {
   assert.deepEqual(digitsSnapshot('numeric', { value: 1434 }, 4), {
      answerFormat: 'digits', maxDigits: 4, acceptedDigits: ['1434'],
   })
   assert.deepEqual(digitsSnapshot('short_text', { acceptedAnswers: [' 0 7 ', '7'] }, 4).acceptedDigits, ['7'])
})

test('trainer cells take { digits } with the mock exam rules', () => {
   assert.deepEqual(parseStudentAnswer({ digits: '1434' }, trainerCells), { digits: '1434' })
   assert.deepEqual(parseStudentAnswer({ digits: '0143' }, trainerCells), { digits: '0143' })
   for (const answer of [{ digits: '12345' }, { digits: '' }, { digits: '1.5' }, { digits: 12 }, { text: '12' }]) {
      assert.throws(() => parseStudentAnswer(answer, trainerCells), { code: 'VALIDATION_ERROR' }, JSON.stringify(answer))
   }
   assert.equal(gradeAnswer({ digits: '1434' }, trainerCells, '2.00'), '2.00')
   assert.equal(gradeAnswer({ digits: '0434' }, trainerCells, '2.00'), '0.00')
   assert.equal(gradeAnswer({ digits: '1435' }, trainerCells, '2.00'), '0.00')
})

test('trainer cells still take { value } as a whole number, stored as digits', () => {
   assert.deepEqual(parseStudentAnswer({ value: 1434 }, trainerCells), { digits: '1434' })
   for (const answer of [{ value: 12.5 }, { value: -1 }, { value: 12345 }, { value: '1434' }]) {
      assert.throws(() => parseStudentAnswer(answer, trainerCells), { code: 'VALIDATION_ERROR' }, JSON.stringify(answer))
   }
})

test('the mock exam still rejects { value } on cells', () => {
   assert.throws(() => parseStudentAnswer({ value: 1434 }, examCells), { code: 'VALIDATION_ERROR' })
})

test('attempts started before cells keep { value } grading unchanged', () => {
   assert.deepEqual(parseStudentAnswer({ value: 12.5 }, legacyNumeric), { value: 12.5 })
   assert.equal(gradeAnswer({ value: 1434 }, legacyNumeric, '1.00'), '1.00')
   assert.throws(() => parseStudentAnswer({ digits: '1434' }, legacyNumeric), { code: 'VALIDATION_ERROR' })
})

test('digitsSheet matches the mock exam result sheet', () => {
   assert.deepEqual(digitsSheet({ digits: '1434' }, trainerCells), {
      digits: '1434', correctDigits: '1434', acceptedDigits: ['1434'], maxDigits: 4,
   })
   assert.equal(digitsSheet(null, trainerCells).digits, null)
})
