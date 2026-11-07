import * as learnerLessonRepository from '../repositories/learner-lesson-repository.js'
import * as attemptRepository from '../repositories/test-attempt-repository.js'
import { scorePercent, toHundredths } from '../utils/attempt-grading.js'
import { isFinished } from '../utils/attempt-policy.js'

function dependencies(overrides = {}) {
   return {
      learner: overrides.learner || learnerLessonRepository,
      attempts: overrides.attempts || attemptRepository,
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
   return deps.learner.completeTestLessons({
      userId: attempt.user_id,
      testId: attempt.test_id,
      completedAt,
   }, client)
}

export { attemptCompletesLesson, completeTestLessonsService }
