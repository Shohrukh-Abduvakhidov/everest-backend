import { toHundredths } from './attempt-grading.js'

const finishedStatuses = ['graded', 'expired']

function isFinished(attempt) {
   return finishedStatuses.includes(attempt.status)
}

function personalWindowEnd(firstStartedAt, minutes) {
   if (!minutes || !firstStartedAt) return null
   return new Date(new Date(firstStartedAt).getTime() + minutes * 60000)
}

// The earliest limit wins. All values are instants, so the zone they were sent in cannot matter.
function computeDeadline({ startedAt, durationSeconds, closesAt, personalWindowEndsAt }) {
   const limits = [
      durationSeconds ? new Date(startedAt).getTime() + durationSeconds * 1000 : null,
      closesAt ? new Date(closesAt).getTime() : null,
      personalWindowEndsAt ? new Date(personalWindowEndsAt).getTime() : null,
   ].filter((value) => value !== null)
   return limits.length ? new Date(Math.min(...limits)) : null
}

function assignmentState(assignment, now) {
   if (new Date(assignment.opens_at) > now) return 'upcoming'
   if (assignment.closes_at && new Date(assignment.closes_at) <= now) return 'closed'
   return 'open'
}

// The earliest attempt wins a tie for best.
function selectResultAttempt(policy, attempts) {
   const finished = attempts
      .filter(isFinished)
      .sort((left, right) => left.attempt_number - right.attempt_number)
   if (!finished.length) return null
   if (policy === 'last') return finished.at(-1)
   if (policy === 'best') {
      return finished.reduce((best, attempt) => (
         toHundredths(attempt.score) > toHundredths(best.score) ? attempt : best
      ))
   }
   return finished[0]
}

function answersRevealed(policy, closesAt, now) {
   if (policy === 'after_submission') return true
   if (policy === 'after_window') return Boolean(closesAt) && new Date(closesAt) <= now
   return false
}

function attemptsUsed(attempts) {
   return attempts.filter((attempt) => attempt.status !== 'cancelled').length
}

function remainingAttempts(maxAttempts, attempts) {
   return maxAttempts === null ? null : Math.max(0, maxAttempts - attemptsUsed(attempts))
}

export {
   answersRevealed,
   assignmentState,
   attemptsUsed,
   computeDeadline,
   isFinished,
   personalWindowEnd,
   remainingAttempts,
   selectResultAttempt,
}
