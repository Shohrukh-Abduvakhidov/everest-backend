import AppError from './app-error.js'
import { isPlainObject } from './question-content.js'

const maximumTextAnswerLength = 500

function invalidAnswer(message) {
   return new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [
      { field: 'answer', message },
   ])
}

// Points are NUMERIC(10,2); whole hundredths avoid binary rounding.
function toHundredths(value) {
   return Math.round(Number(value) * 100)
}

function fromHundredths(value) {
   return (value / 100).toFixed(2)
}

function normalizeText(value) {
   return value.normalize('NFC').trim().toLowerCase()
}

function parseMatchingAnswer(value, snapshot) {
   const left = new Set(snapshot.leftKeys)
   const right = new Set(snapshot.rightKeys)
   if (Object.keys(value).join() !== 'pairs' || !Array.isArray(value.pairs)) {
      throw invalidAnswer('pairs must be an array')
   }
   const usedLeft = new Set()
   const usedRight = new Set()
   const pairs = value.pairs.map((pair) => {
      if (!isPlainObject(pair) || Object.keys(pair).sort().join() !== 'left,right'
         || !left.has(pair.left) || !right.has(pair.right) || usedLeft.has(pair.left)) {
         throw invalidAnswer('pairs must reference items of this question, each left item once')
      }
      if (snapshot.interactionSettings?.allowRightReuse !== true && usedRight.has(pair.right)) {
         throw invalidAnswer('right items cannot be reused')
      }
      usedLeft.add(pair.left)
      usedRight.add(pair.right)
      return { left: pair.left, right: pair.right }
   })
   return { pairs }
}

// A saved answer may be incomplete. `null` clears it. References are checked against the
// structure of this attempt.
function parseStudentAnswer(value, snapshot) {
   if (value === null) return null
   if (!isPlainObject(value)) throw invalidAnswer('answer must be an object or null')
   const keys = Object.keys(value)
   const optionKeys = new Set(snapshot.optionKeys)
   switch (snapshot.questionType) {
      case 'single_choice':
         if (keys.join() !== 'optionKey' || !optionKeys.has(value.optionKey)) {
            throw invalidAnswer('optionKey must reference an option of this question')
         }
         return { optionKey: value.optionKey }
      case 'multiple_choice':
         if (keys.join() !== 'optionKeys' || !Array.isArray(value.optionKeys)
            || new Set(value.optionKeys).size !== value.optionKeys.length
            || value.optionKeys.some((key) => !optionKeys.has(key))) {
            throw invalidAnswer('optionKeys must reference distinct options of this question')
         }
         return { optionKeys: [...value.optionKeys] }
      case 'matching':
         return parseMatchingAnswer(value, snapshot)
      case 'numeric':
         if (keys.join() !== 'value' || typeof value.value !== 'number' || !Number.isFinite(value.value)) {
            throw invalidAnswer('value must be a finite number')
         }
         return { value: value.value }
      case 'short_text':
         if (keys.join() !== 'text' || typeof value.text !== 'string'
            || value.text.length > maximumTextAnswerLength) {
            throw invalidAnswer(`text must be a string of at most ${maximumTextAnswerLength} characters`)
         }
         return { text: value.text }
      default:
         throw invalidAnswer('question type is not supported')
   }
}

// Extra pairs raise the total, so pairing everything cannot earn full points.
function matchingShare(answer, key) {
   const expected = new Map(key.pairs.map((pair) => [pair.left, pair.right]))
   const correct = answer.pairs.filter((pair) => expected.get(pair.left) === pair.right).length
   return [correct, Math.max(key.pairs.length, answer.pairs.length)]
}

function sameSet(left, right) {
   const expected = new Set(right)
   return left.length === expected.size && left.every((value) => expected.has(value))
}

function gradeShare(answer, snapshot) {
   const key = snapshot.answerData
   if (answer === null || answer === undefined) return [0, 1]
   switch (snapshot.questionType) {
      case 'single_choice':
         return [answer.optionKey === key.optionKey ? 1 : 0, 1]
      case 'multiple_choice':
         return [sameSet(answer.optionKeys, key.optionKeys) ? 1 : 0, 1]
      case 'matching':
         return matchingShare(answer, key)
      case 'numeric':
         return [answer.value === key.value ? 1 : 0, 1]
      case 'short_text':
         return [key.acceptedAnswers.map(normalizeText).includes(normalizeText(answer.text)) ? 1 : 0, 1]
      default:
         return [0, 1]
   }
}

// Partial matching points round down to a hundredth.
function gradeAnswer(answer, snapshot, maxPoints) {
   const [correct, total] = gradeShare(answer, snapshot)
   return fromHundredths(Math.floor((toHundredths(maxPoints) * correct) / total))
}

function sumPoints(values) {
   return fromHundredths(values.reduce((sum, value) => sum + toHundredths(value), 0))
}

function scorePercent(score, maxScore) {
   return Number(((toHundredths(score) / toHundredths(maxScore)) * 100).toFixed(2))
}

export { gradeAnswer, parseStudentAnswer, scorePercent, sumPoints, toHundredths }
