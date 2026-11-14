import { scorePercent } from './attempt-grading.js'
import { attemptPassed } from './attempt-policy.js'

// M12 decision D4: a topic counts once it has at least minQuestions questions in finished
// attempts of the window; weak below weakBelowPercent, strong from strongFromPercent, both on
// the percentage rounded to hundredths. Unanswered questions count 0 points (done in SQL).
const topicRules = Object.freeze({ minQuestions: 5, weakBelowPercent: 60, strongFromPercent: 85, limit: 5 })

function topicItem(row) {
   return {
      topicId: row.topic_id,
      topicCode: row.code,
      subjectId: row.subject_id,
      subjectCode: row.subject_code,
      titles: row.titles,
      questions: row.questions,
      points: row.points,
      maxPoints: row.max_points,
      percent: scorePercent(row.points, row.max_points),
   }
}

// Weak: lowest share first, then the most questions. Strong: highest share first, then the most
// questions. The topic id breaks remaining ties so the order is stable.
function classifyTopics(rows, rules = topicRules) {
   const counted = rows
      .filter((row) => row.questions >= rules.minQuestions && Number(row.max_points) > 0)
      .map(topicItem)
   const byId = (left, right) => (BigInt(left.topicId) < BigInt(right.topicId) ? -1 : 1)
   const weak = counted
      .filter((topic) => topic.percent < rules.weakBelowPercent)
      .sort((left, right) => left.percent - right.percent || right.questions - left.questions || byId(left, right))
   const strong = counted
      .filter((topic) => topic.percent >= rules.strongFromPercent)
      .sort((left, right) => right.percent - left.percent || right.questions - left.questions || byId(left, right))
   return { weak: weak.slice(0, rules.limit), strong: strong.slice(0, rules.limit) }
}

function round2(value) {
   return Math.round(value * 100) / 100
}

// First attempts of course tests. averagePercent is the mean of the attempt percentages; passRate
// counts only attempts whose test had a passPercent and is null when there is none.
function firstAttemptStats(rows) {
   const percents = rows.map((row) => scorePercent(row.score ?? 0, row.max_score))
   const judged = rows.map(attemptPassed).filter((value) => value !== null)
   const passed = judged.filter(Boolean).length
   return {
      count: rows.length,
      averagePercent: rows.length ? round2(percents.reduce((sum, value) => sum + value, 0) / rows.length) : null,
      withPassPercent: judged.length,
      passed,
      passRate: judged.length ? round2((passed * 100) / judged.length) : null,
   }
}

export { classifyTopics, firstAttemptStats, topicRules }
