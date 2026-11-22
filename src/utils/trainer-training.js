// The request part of a stored trainer training (tests.generation_filters), shared by the trainer
// history and overview and by the attempt result, so both read it the same way.

// Trainings stored before topicCodes existed keep only topicCode.
function storedTopicCodes(stored) {
   if (Array.isArray(stored.topicCodes)) return stored.topicCodes
   return stored.topicCode ? [stored.topicCode] : []
}

function trainingFilters(filters) {
   const topicCodes = storedTopicCodes(filters)
   return {
      mode: filters.mode ?? 'standard',
      difficulty: filters.difficulty,
      language: filters.language ?? null,
      sectionCode: filters.sectionCode ?? null,
      topicCode: topicCodes.length === 1 ? topicCodes[0] : null,
      topicCodes,
      timeLimitMinutes: filters.timeLimitMinutes ?? null,
      sourceAttemptId: filters.sourceAttemptId ?? null,
   }
}

// The subject (id, code, titles) and the filters of a training, as the attempt result and the
// trainer history return them (2026-11-22).
function trainingSummary(filters, subjectTitles) {
   return {
      subject: { id: filters.subjectId, code: filters.subjectCode, titles: subjectTitles ?? {} },
      ...trainingFilters(filters),
   }
}

export { storedTopicCodes, trainingFilters, trainingSummary }
