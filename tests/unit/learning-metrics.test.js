import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyTopics, firstAttemptStats, topicRules } from '../../src/utils/learning-metrics.js'

let nextId = 0
function topic(points, maxPoints, questions = 5, extra = {}) {
   nextId += 1
   return {
      topic_id: String(nextId), code: `t${nextId}`, subject_id: '1', subject_code: 's', titles: {},
      questions, points, max_points: maxPoints, ...extra,
   }
}

const percents = (list) => list.map((item) => item.percent)

test('topic rules are the approved D4 values', () => {
   assert.deepEqual({ ...topicRules }, { minQuestions: 5, weakBelowPercent: 60, strongFromPercent: 85, limit: 5 })
})

test('a topic needs five questions', () => {
   const result = classifyTopics([topic('0.00', '4.00', 4), topic('0.00', '5.00', 5)])
   assert.equal(result.weak.length, 1)
   assert.equal(result.weak[0].questions, 5)
   assert.deepEqual(classifyTopics([topic('4.00', '4.00', 4)]).strong, [])
})

test('weak and strong limits on the rounded percentage', () => {
   const { weak, strong } = classifyTopics([
      topic('60.00', '100.00'), // exactly 60: not weak
      topic('59.99', '100.00'), // weak
      topic('85.00', '100.00'), // exactly 85: strong
      topic('84.99', '100.00'), // neither
      topic('2.00', '3.00', 6), // 66.67: neither
   ])
   assert.deepEqual(percents(weak), [59.99])
   assert.deepEqual(percents(strong), [85])
})

test('unanswered questions are already 0 points and a topic without points possible is skipped', () => {
   const { weak, strong } = classifyTopics([topic('0.00', '5.00'), topic('0.00', '0.00')])
   assert.deepEqual(percents(weak), [0])
   assert.deepEqual(strong, [])
})

test('order: weakest first, more questions first, then topic id; five per list', () => {
   const rows = [
      topic('10.00', '100.00', 5),
      topic('10.00', '100.00', 9),
      topic('0.00', '10.00', 5),
      topic('50.00', '100.00', 5),
      topic('20.00', '100.00', 5),
      topic('30.00', '100.00', 5),
      topic('40.00', '100.00', 5),
   ]
   const { weak } = classifyTopics(rows)
   assert.equal(weak.length, 5)
   assert.deepEqual(percents(weak), [0, 10, 10, 20, 30])
   assert.equal(weak[1].questions, 9, 'more questions wins a tie')
   const tie = classifyTopics([topic('1.00', '5.00', 5, { topic_id: '20' }), topic('1.00', '5.00', 5, { topic_id: '3' })])
   assert.deepEqual(tie.weak.map((item) => item.topicId), ['3', '20'], 'numeric id order, not string order')
})

test('strong: highest first, then more questions', () => {
   const { strong } = classifyTopics([topic('9.00', '10.00', 5), topic('10.00', '10.00', 5), topic('9.00', '10.00', 8)])
   assert.deepEqual(percents(strong), [100, 90, 90])
   assert.equal(strong[1].questions, 8)
})

test('topic item shape', () => {
   const [item] = classifyTopics([topic('1.50', '6.00', 6, { topic_id: '7', code: 'alg', subject_id: '2', subject_code: 'math', titles: { en: 'Algebra' } })]).weak
   assert.deepEqual(item, {
      topicId: '7', topicCode: 'alg', subjectId: '2', subjectCode: 'math', titles: { en: 'Algebra' },
      questions: 6, points: '1.50', maxPoints: '6.00', percent: 25,
   })
})

const attempt = (score, maxScore, passPercent, status = 'graded') => ({
   status, score, max_score: maxScore, policy_snapshot: passPercent === undefined ? {} : { passPercent },
})

test('first attempt statistics', () => {
   assert.deepEqual(firstAttemptStats([]), {
      count: 0, averagePercent: null, withPassPercent: 0, passed: 0, passRate: null,
   })
   assert.deepEqual(firstAttemptStats([
      attempt('5.00', '10.00', 50), // exactly at the threshold: passed
      attempt('4.99', '10.00', 50), // failed
      attempt('0.00', '10.00'), // no threshold: average only
      attempt(null, '10.00', 50, 'expired'), // timer, nothing answered: 0 and failed
   ]), {
      count: 4, averagePercent: 24.98, withPassPercent: 3, passed: 1, passRate: 33.33,
   })
   assert.equal(firstAttemptStats([attempt('3.00', '4.00')]).passRate, null, 'no threshold anywhere')
})
