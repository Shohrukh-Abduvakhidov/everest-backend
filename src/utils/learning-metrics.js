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

// NCT readiness of one subject (decision D3): points over possible points of its last trainings.
function subjectReadiness(rows) {
   const score = rows.reduce((sum, row) => sum + Number(row.score), 0)
   const maxScore = rows.reduce((sum, row) => sum + Number(row.max_score), 0)
   return round2((score * 100) / maxScore)
}

// Overall readiness: the mean of the subject values, every trained subject counting equally.
// rows: the last trainings of each subject (subject_id, score, max_score). null without any.
function overallReadiness(rows) {
   const bySubject = new Map()
   for (const row of rows) bySubject.set(row.subject_id, [...(bySubject.get(row.subject_id) ?? []), row])
   if (!bySubject.size) return null
   const values = [...bySubject.values()].map(subjectReadiness)
   return round2(values.reduce((sum, value) => sum + value, 0) / values.length)
}

function median(values) {
   if (!values.length) return null
   const sorted = [...values].sort((left, right) => left - right)
   const middle = Math.floor(sorted.length / 2)
   return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

// M12 decision D5 ("behind"). Each reason is set on its own; a student is behind when any is set.
const behindRules = Object.freeze({
   inactiveDays: 7,
   belowPassTests: 3,
   progressLagPoints: 25,
   progressLagMinStudents: 5,
})

// below_pass: the latest finished attempt of each of the last belowPassTests tests that have a
// passPercent; the mean percentage under the mean threshold. null when no such test exists.
function belowPass(rows) {
   if (!rows.length) return null
   const percent = rows.reduce((sum, row) => sum + scorePercent(row.score ?? 0, row.max_score), 0) / rows.length
   const threshold = rows.reduce((sum, row) => sum + Number(row.policy_snapshot.passPercent), 0) / rows.length
   return round2(percent) < round2(threshold)
}

// progress_lag per course: at least progressLagPoints under the median of the students with an
// active enrollment, counted only when at least progressLagMinStudents of them are compared.
function laggingCourses(students, rules = behindRules) {
   const byCourse = new Map()
   for (const student of students) {
      for (const course of student.courses) {
         if (!course.enrollmentActive) continue
         byCourse.set(course.courseId, [...(byCourse.get(course.courseId) ?? []), course.percent])
      }
   }
   const medians = new Map()
   for (const [courseId, values] of byCourse) {
      if (values.length >= rules.progressLagMinStudents) medians.set(courseId, median(values))
   }
   return (course) => course.enrollmentActive && medians.has(course.courseId)
      && course.percent <= medians.get(course.courseId) - rules.progressLagPoints
}

function behindReasons({ lastActivityAt, now, missedAssignments, belowPassThreshold, lagging }, rules = behindRules) {
   const reasons = []
   const inactiveSince = now.getTime() - rules.inactiveDays * 86400000
   if (lastActivityAt === null || new Date(lastActivityAt).getTime() < inactiveSince) reasons.push('no_activity_7d')
   if (missedAssignments > 0) reasons.push('missed_deadline')
   if (belowPassThreshold === true) reasons.push('below_pass')
   if (lagging) reasons.push('progress_lag')
   return reasons
}

export {
   behindReasons,
   behindRules,
   belowPass,
   classifyTopics,
   firstAttemptStats,
   laggingCourses,
   median,
   overallReadiness,
   subjectReadiness,
   topicRules,
}
