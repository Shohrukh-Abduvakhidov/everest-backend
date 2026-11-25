// The one progress rule for a set of lessons, used for a module, a course card and the staff
// views alike: completed lessons (lesson_progress.status = 'completed', also written by the
// server when a test completes its lesson) over the lessons counted, rounded down so that 100
// means every counted lesson is completed. An empty set is 0 percent.
function lessonPercent(completed, total) {
   return total === 0 ? 0 : Math.floor((completed * 100) / total)
}

function lessonProgress({ completedLessons = 0, totalLessons = 0 } = {}) {
   return {
      completedLessons,
      totalLessons,
      percent: lessonPercent(completedLessons, totalLessons),
   }
}

// A course is the sum of its modules: the same counts, the same rounding.
function sumLessonProgress(parts) {
   let completedLessons = 0
   let totalLessons = 0
   for (const part of parts) {
      if (!part) continue
      completedLessons += part.completedLessons
      totalLessons += part.totalLessons
   }
   return lessonProgress({ completedLessons, totalLessons })
}

export { lessonPercent, lessonProgress, sumLessonProgress }
