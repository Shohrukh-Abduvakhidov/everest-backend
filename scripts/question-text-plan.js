// Pure planning for scripts/fix-question-text.js: which content rows change and what is left for
// manual review. No database access, so tests import it directly.

import { auditQuestion, fixContent } from '../src/utils/question-text-audit.js'

// Questions are named by bank code and externalId, which stay the same in every database the
// banks were imported into; the local question id is given for reference only. A question with
// no externalId is named by its id within the bank.

// Words cut by a line-end hyphen that were checked by hand: "электро- магнитӣ", "мар- казаш",
// "хайру-" + "хуш" (1109, now excluded by the owner). Elsewhere the same shape is often a dash ("Фарзанд- меваи ширин").
const hyphenJoinQuestions = [
   { id: '1898', bankCode: 'nct-bio-tg-2026', externalId: 'nct-bio-tg-2026-matching-0088' },
   { id: '1906', bankCode: 'nct-bio-tg-2026', externalId: 'nct-bio-tg-2026-matching-0096' },
   { id: '2589', bankCode: 'nct-fiz-tg-2026', externalId: 'nct-fiz-tg-2026-matching-0081' },
   { id: '2600', bankCode: 'nct-fiz-tg-2026', externalId: 'nct-fiz-tg-2026-matching-0092' },
   { id: '2627', bankCode: 'nct-fiz-tg-2026', externalId: 'nct-fiz-tg-2026-matching-0119' },
]

// Never changed automatically, by any rule: stems that leaked into the headers (1907, 1917),
// dashes that look like wraps (904, 956), and questions kept for a person to decide.
const excludedQuestions = [
   { id: '1907', bankCode: 'nct-bio-tg-2026', externalId: 'nct-bio-tg-2026-matching-0097' },
   { id: '1917', bankCode: 'nct-bio-tg-2026', externalId: 'nct-bio-tg-2026-matching-0107' },
   { id: '1102', bankCode: 'nct-tg-2026', externalId: 'nct-tg-2026-matching-0034' },
   { id: '904', bankCode: 'nct-tg-2026', externalId: 'nct-tg-2026-single-0605' },
   { id: '956', bankCode: 'nct-tg-2026', externalId: 'nct-tg-2026-single-0657' },
   { id: '291', bankCode: 'biologiya', externalId: null },
   { id: '1109', bankCode: 'nct-tg-2026', externalId: 'nct-tg-2026-matching-0041' },
]

function matches(entry, question) {
   if (entry.bankCode !== question.bankCode) return false
   return entry.externalId === null
      ? String(entry.id) === String(question.id)
      : entry.externalId === question.externalId
}

const isListed = (list, question) => list.some((entry) => matches(entry, question))

const joinRules = new Set(['join_hyphen_wrap', 'join_hyphen_wrap_lines'])

function reviewItem(question, finding, extra = {}) {
   return {
      questionId: question.id,
      externalId: question.externalId,
      bankCode: question.bankCode,
      status: question.status,
      attemptUses: question.attemptUses,
      type: finding.type,
      path: finding.path,
      sample: finding.sample,
      ...(finding.reason ? { reason: finding.reason } : {}),
      ...extra,
   }
}

// questions: the shape of question-text-data.loadQuestions.
// Returns { changes, review, excluded, joinNotApplied }:
//    changes        one entry per changed content row, with the old and new content;
//    review         findings still present after the changes (and every finding of an excluded
//                   question), for a person;
//    excluded       excluded questions that were loaded;
//    joinNotApplied listed hyphen-join questions that were not loaded or where the join found
//                   nothing (a sign the list no longer matches the data).
function planChanges(questions, { bankCode = null, joinList = hyphenJoinQuestions, excludedList = excludedQuestions } = {}) {
   const changes = []
   const review = []
   const excluded = []
   const joined = new Set()
   for (const question of questions) {
      if (isListed(excludedList, question)) {
         excluded.push({ questionId: question.id, externalId: question.externalId, bankCode: question.bankCode })
         for (const finding of auditQuestion(question)) review.push(reviewItem(question, finding, { excluded: true }))
         continue
      }
      const joinHyphens = isListed(joinList, question)
      const language = question.language
      const fixedQuestion = { ...question }
      const fixRow = (kind, rowId, label, content) => {
         const fixed = fixContent(content, { language, joinHyphens })
         if (!fixed) return content
         if (fixed.changes.some((change) => change.rules.some((rule) => joinRules.has(rule)))) joined.add(question)
         changes.push({
            kind,
            rowId,
            questionId: question.id,
            externalId: question.externalId,
            bankCode: question.bankCode,
            status: question.status,
            attemptUses: question.attemptUses,
            label,
            edits: fixed.changes,
            before: content,
            after: fixed.content,
         })
         return fixed.content
      }
      fixedQuestion.content = fixRow('question', question.id, 'content', question.content)
      fixedQuestion.options = question.options.map((option) => ({
         ...option,
         content: fixRow('option', option.rowId, `option:${option.key}`, option.content),
      }))
      fixedQuestion.matching = question.matching.map((item) => ({
         ...item,
         content: fixRow('matching', item.rowId, `matching:${item.side}:${item.key}`, item.content),
      }))
      for (const finding of auditQuestion(fixedQuestion)) {
         if (!finding.fix) review.push(reviewItem(question, finding))
      }
   }
   const joinNotApplied = joinList
      .filter((entry) => bankCode === null || entry.bankCode === bankCode)
      .filter((entry) => ![...joined].some((question) => matches(entry, question)))
      .map((entry) => ({
         ...entry,
         loaded: questions.some((question) => matches(entry, question)),
      }))
   return { changes, review, excluded, joinNotApplied }
}

export { excludedQuestions, hyphenJoinQuestions, planChanges }
