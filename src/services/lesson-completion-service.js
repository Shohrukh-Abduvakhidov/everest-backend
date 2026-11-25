import * as learningActivityRepository from '../repositories/learning-activity-repository.js'
import * as learnerLessonRepository from '../repositories/learner-lesson-repository.js'
import * as attemptRepository from '../repositories/test-attempt-repository.js'
import { scorePercent, toHundredths } from '../utils/attempt-grading.js'
import { isFinished } from '../utils/attempt-policy.js'

function dependencies(overrides = {}) {
   return {
      learner: overrides.learner || learnerLessonRepository,
      attempts: overrides.attempts || attemptRepository,
      activity: overrides.activity || learningActivityRepository,
   }
}

// The owner's rule (2026-11-07). passPercent comes from the attempt's policy snapshot, so a
// later change of the test cannot change the outcome. An attempt closed by the timer without
// one saved answer never completes a lesson. The attempt limit plays no part.
function attemptCompletesLesson({ status, score, maxScore, passPercent, answered }) {
   if (!isFinished({ status })) return false
   if (status === 'expired' && !answered) return false
   if (passPercent === null || passPercent === undefined) return true
   if (score === null || score === undefined || toHundredths(maxScore ?? 0) === 0) return false
   return scorePercent(score, maxScore) >= passPercent
}

// Completes every lesson linked to the attempt's test, inside the caller's transaction. A
// lesson already completed keeps its completed_at; nothing is ever moved back.
async function completeTestLessonsService({ attempt, completedAt }, client, overrides) {
   if (!client) throw new TypeError('completeTestLessonsService requires a transaction client')
   const deps = dependencies(overrides)
   const answered = attempt.status === 'expired'
      ? await deps.attempts.hasSavedAnswer(attempt.id, client)
      : true
   const completes = attemptCompletesLesson({
      status: attempt.status,
      score: attempt.score,
      maxScore: attempt.max_score,
      passPercent: attempt.policy_snapshot?.passPercent ?? null,
      answered,
   })
   if (!completes) return []
   const lessonIds = await deps.learner.completeTestLessons({
      userId: attempt.user_id,
      testId: attempt.test_id,
      completedAt,
   }, client)
   for (const lessonId of lessonIds) {
      await deps.activity.recordActivityEvent({
         userId: attempt.user_id,
         lessonId,
         code: 'lesson_completed',
         sourceEventKey: `lesson_completed:${lessonId}`,
         occurredAt: completedAt,
         metadata: { by: 'test' },
      }, client)
   }
   return lessonIds
}

// The earliest attempt per (lesson, learner) that completes the lesson by attemptCompletesLesson,
// from rows of listMissedTestLessonCompletions (ordered earliest first). Pure.
function pickMissedCompletions(rows) {
   const picked = new Map()
   for (const row of rows) {
      const key = `${row.lesson_id}:${row.user_id}`
      if (picked.has(key)) continue
      const completes = attemptCompletesLesson({
         status: row.status,
         score: row.score,
         maxScore: row.max_score,
         passPercent: row.policy_snapshot?.passPercent ?? null,
         answered: row.answered,
      })
      if (!completes) continue
      picked.set(key, {
         lessonId: row.lesson_id,
         userId: row.user_id,
         testId: row.test_id,
         attemptId: row.attempt_id,
         completedAt: row.finished_at,
      })
   }
   return [...picked.values()]
}

// Completes the lessons that a finished attempt should have completed but did not: the lesson
// was linked to the test after the attempt finished, or the attempt finished before the
// completion rule existed. Same rule, same idempotent write; completed_at is the time the
// attempt finished, so history stays true. With apply false only the plan is returned (the
// recompute script's dry run). lessonId null covers every linked lesson.
async function completeMissedTestLessonsService({ lessonId = null, apply = true } = {}, client, overrides) {
   if (!client) throw new TypeError('completeMissedTestLessonsService requires a transaction client')
   const deps = dependencies(overrides)
   const planned = pickMissedCompletions(await deps.learner.listMissedTestLessonCompletions({ lessonId }, client))
   if (!apply) return planned
   const completed = []
   for (const item of planned) {
      if (!await deps.learner.completeLessonForUser(item, client)) continue
      await deps.activity.recordActivityEvent({
         userId: item.userId,
         lessonId: item.lessonId,
         code: 'lesson_completed',
         sourceEventKey: `lesson_completed:${item.lessonId}`,
         occurredAt: item.completedAt,
         metadata: { by: 'test', attemptId: item.attemptId, recomputed: true },
      }, client)
      completed.push(item)
   }
   return completed
}

export {
   attemptCompletesLesson,
   completeMissedTestLessonsService,
   completeTestLessonsService,
   pickMissedCompletions,
}
