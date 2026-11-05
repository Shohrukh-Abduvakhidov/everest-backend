// Compact builders for demo questions. Each returns the question definition the seed turns
// into createQuestionService / replaceAnswerKeyService / verifyAnswerKeyService calls.

const optionKeys = 'ABCDEFGHIJ'

export const text = (value) => ({ blocks: [{ type: 'text', text: value }] })
export const tx = (value) => ({ type: 'text', text: value })
export const formula = (latex, display = true) => ({ type: 'formula', latex, display })
export const chem = (value) => ({ type: 'chemistry', formula: value })

function body(question) {
   return Array.isArray(question) ? { blocks: question } : text(question)
}

function definition(questionType, topics, difficulty, question, language, why) {
   return {
      questionType,
      topics: [].concat(topics),
      difficulty,
      languageCode: language,
      content: body(question),
      explanation: text(why),
      status: 'published',
   }
}

export function single(topics, difficulty, question, options, answer, why, language = 'ru') {
   return {
      ...definition('single_choice', topics, difficulty, question, language, why),
      options: options.map((option, index) => ({ key: optionKeys[index], content: body(option) })),
      answerData: { optionKey: optionKeys[answer] },
   }
}

export function multiple(topics, difficulty, question, options, answers, why, language = 'ru') {
   return {
      ...definition('multiple_choice', topics, difficulty, question, language, why),
      options: options.map((option, index) => ({ key: optionKeys[index], content: body(option) })),
      answerData: { optionKeys: answers.map((index) => optionKeys[index]) },
   }
}

// pairs: [[left, right], ...]. The right column is rotated so it is not in answer order.
// reuse = true allows one right item to match several left items (classification tasks).
export function matching(topics, difficulty, question, pairs, why, language = 'ru', reuse = false) {
   const rights = reuse
      ? [...new Set(pairs.map(([, right]) => right))]
      : pairs.map(([, right]) => right)
   const shift = rights.length > 1 ? 1 : 0
   const ordered = [...rights.slice(shift), ...rights.slice(0, shift)]
   const rightKey = (value) => `R${ordered.indexOf(value) + 1}`
   return {
      ...definition('matching', topics, difficulty, question, language, why),
      interactionSettings: { requireAllLeft: true, allowRightReuse: reuse },
      matching: {
         left: pairs.map(([left], index) => ({ key: `L${index + 1}`, content: body(left) })),
         right: ordered.map((right, index) => ({ key: `R${index + 1}`, content: body(right) })),
      },
      answerData: {
         pairs: pairs.map(([, right], index) => ({ left: `L${index + 1}`, right: rightKey(right) })),
      },
   }
}

export function numeric(topics, difficulty, question, value, why, language = 'ru') {
   return {
      ...definition('numeric', topics, difficulty, question, language, why),
      answerData: { value },
   }
}

export function shortText(topics, difficulty, question, acceptedAnswers, why, language = 'ru') {
   return {
      ...definition('short_text', topics, difficulty, question, language, why),
      answerData: { acceptedAnswers },
   }
}

// A draft keeps its content but never receives an answer key.
export function draft(question) {
   const { answerData: _answerData, explanation: _explanation, ...rest } = question
   return { ...rest, status: 'draft' }
}

// Published first (with a verified key), then archived.
export function archived(question) {
   return { ...question, status: 'archived' }
}
