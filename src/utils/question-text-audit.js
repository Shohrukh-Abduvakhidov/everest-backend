// Pure checks for damaged question text (import defects). No database access: the audit and
// fix scripts load rows and pass plain content JSON here, and the package adapter uses
// repairColumnHeaders while importing.

// Single-letter words that are real words, so a lone letter is not by itself a defect.
// Tajik: ё (or), у and ӯ (he/she). Russian: prepositions and conjunctions. An unknown language
// uses both lists. Latin letters are labels or variables (A, B, X, Y) and are not checked.
const singleLetterWordsByLanguage = {
   tg: new Set(['ё', 'у', 'ӯ']),
   ru: new Set(['в', 'к', 'с', 'о', 'а', 'и', 'я', 'у']),
}
const allSingleLetterWords = new Set([...singleLetterWordsByLanguage.tg, ...singleLetterWordsByLanguage.ru])

function isSingleLetterWord(letter, language) {
   return (singleLetterWordsByLanguage[language] ?? allSingleLetterWords).has(letter.toLowerCase())
}

const controlPattern = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u
const invisibleInWordPattern = /\p{L}[\u00A0\u00AD\u200B-\u200D\u2060\uFEFF]\p{L}/u
const doubleSpacePattern = /\S {2,}\S/u
// A space before punctuation; an ellipsis (a blank to fill in) is not punctuation here.
const spaceBeforePunctuationPattern = /\p{L} +(?:[,;:!?)]|\.(?!\.))/u
const hyphenWrapPattern = /\p{Ll}-(?:\s+\p{Ll}|$)/u
// A lone Cyrillic letter followed by a lowercase word: "З анбӯруғҳо", "муайян н амоед".
const isolatedLetterPattern = /(?<![\p{L}\p{N}\-/·.…])(\p{Script=Cyrillic})(?![\p{L}\p{N}])\s+(\p{Ll}{2,})/gu
// Words after which a lone letter is the subject of the sentence: "ҳарфи у", "садоноки а".
const letterNamePattern = /(?:ҳарф|садонок|ҳамсадо|овоз|буква|звук)\p{L}*\s+$/iu
// Enumerated labels: "а, б ва в", "а) ... б) ...".
const enumerationWords = new Set(['ва', 'ё', 'ва/ё'])

// Lone letters that most likely belong to the next word. Units after numbers ("100 г"), letter
// names, enumerations and quoted letters are skipped.
function isolatedLetters(text, language) {
   const found = []
   for (const match of text.matchAll(isolatedLetterPattern)) {
      const [, letter, nextWord] = match
      const before = text.slice(0, match.index)
      if (isSingleLetterWord(letter, language)) continue
      // After a number it is a unit ("100 г"); after a blank ("... е") it is a suffix to fill.
      if (/\p{N}\s*$/u.test(before) || /(?:[,(«"“'‘]|\.\.\.|…)\s*$/u.test(before)) continue
      if (letterNamePattern.test(before) || enumerationWords.has(nextWord)) continue
      // Mid-sentence capitals are labels or variables ("элементи Х", "лампаи Л"); a capital
      // only counts at the start of the text or of a sentence ("З анбӯруғҳо").
      if (/^\p{Lu}$/u.test(letter) && !/(?:^|[.!?])$/u.test(before.trimEnd())) continue
      found.push({ index: match.index, letter, nextWord })
   }
   return found
}

function isLowercaseStart(text) {
   return /^\p{Ll}/u.test(text)
}

function lastToken(text) {
   const match = /(?:^|\s)(\S+)$/u.exec(text)
   return match ? match[1] : ''
}

// Matching column headers come from PDF extraction as { left, right }. When the column boundary
// fell inside a word, `left` ends with the first letter(s) of the right header's first word.
// Returns { status: 'ok' | 'fixed' | 'review', left, right, reason }.
// 'fixed' only when exactly one letter is stranded and the result is a normal header pair:
//    left:  "Мамнуъгоҳи Тоҷикистон С", right: "оли ташкилшавӣ"
//    ->     "Мамнуъгоҳи Тоҷикистон",   "Соли ташкилшавӣ"
// 'review' when the pair looks damaged but the repair is not certain: stem text that leaked
// into the headers ("муайян н | амоед:"), a word cut after several letters ("куне | д"), an
// empty side. A right header that simply starts with a lowercase word stays 'ok'.
function repairColumnHeaders(left, right, { previousText = '', language } = {}) {
   const l = typeof left === 'string' ? left : ''
   const r = typeof right === 'string' ? right : ''
   const result = (status, reason, newLeft = l, newRight = r) => ({ status, reason, left: newLeft, right: newRight })
   if (!l.trim() || !r.trim()) return result('review', 'empty_header')
   const leftTrimmed = l.trimEnd()
   const rightTrimmed = r.trimStart()
   const fragment = lastToken(leftTrimmed)
   const continues = isLowercaseStart(rightTrimmed) && /^\p{L}+$/u.test(fragment)
   const strandedLetter = continues && fragment.length === 1 && fragment !== leftTrimmed
      && !isSingleLetterWord(fragment, language)
   const shortTail = continues && /^\p{L}{1,2}(?![\p{L}])/u.test(rightTrimmed)
   const stemLeak = isLowercaseStart(l.trimStart())
      || /\p{L}-$/u.test(previousText.trimEnd())
      || /:$/u.test(r.trimEnd())
   if (stemLeak && (strandedLetter || shortTail || continues)) return result('review', 'stem_text_in_headers')
   if (stemLeak) return result('review', 'header_looks_like_stem')
   if (strandedLetter) {
      return result('fixed', 'stranded_letter', leftTrimmed.slice(0, -1).trimEnd(), `${fragment}${rightTrimmed}`)
   }
   if (shortTail) return result('review', 'word_split_ambiguous')
   return result('ok', null)
}

// A short item whose first capital letter was cut off its word: "З анбӯруғҳо" -> "Занбӯруғҳо".
// Only a whole text of one Cyrillic capital followed by lowercase words and nothing else
// (no digits, punctuation or other capitals), so stems such as "Х кадом элемент аст?" stay.
// Returns the repaired text or null.
function repairStrandedInitial(text, language) {
   if (typeof text !== 'string') return null
   const match = /^(\p{Script=Cyrillic})\s+(\p{Ll}{2,}(?:\s+\p{Ll}+)*)$/u.exec(text.trim())
   if (!match || !/^\p{Lu}$/u.test(match[1]) || isSingleLetterWord(match[1], language)) return null
   return `${match[1]}${match[2]}`
}

// --- Text units --------------------------------------------------------------------------

// Every editable string inside a content document, with a stable path for reports and fixes.
function textUnits(content, prefix) {
   const units = []
   const blocks = Array.isArray(content?.blocks) ? content.blocks : []
   blocks.forEach((block, index) => {
      const base = `${prefix}.blocks[${index}]`
      if (block?.type === 'text' && typeof block.text === 'string') {
         units.push({ path: `${base}.text`, text: block.text, kind: 'text' })
      } else if (block?.type === 'verse' && Array.isArray(block.lines)) {
         block.lines.forEach((line, lineIndex) => {
            if (typeof line === 'string') units.push({ path: `${base}.lines[${lineIndex}]`, text: line, kind: 'text' })
         })
      } else if (block?.type === 'table' && Array.isArray(block.rows)) {
         block.rows.forEach((row, rowIndex) => {
            (Array.isArray(row) ? row : []).forEach((cell, cellIndex) => {
               if (typeof cell === 'string') {
                  units.push({ path: `${base}.rows[${rowIndex}][${cellIndex}]`, text: cell, kind: 'cell' })
               }
            })
         })
      }
   })
   return units
}

// Comparable text of a content document (for duplicate options): text, formulas and images.
// Case is kept: options that differ only in capitals (spelling questions, genotypes) differ.
function contentSignature(content) {
   const blocks = Array.isArray(content?.blocks) ? content.blocks : []
   return blocks.map((block) => {
      if (block?.type === 'text') return `t:${block.text ?? ''}`
      if (block?.type === 'verse') return `v:${(block.lines || []).join('\n')}`
      if (block?.type === 'formula') return `f:${block.latex ?? ''}`
      if (block?.type === 'chemistry') return `c:${block.formula ?? ''}`
      if (block?.type === 'image') return `i:${block.assetId ?? block.asset ?? ''}`
      if (block?.type === 'table') return `tb:${JSON.stringify(block.rows ?? [])}`
      return `x:${JSON.stringify(block)}`
   }).join('\u0001').normalize('NFC').replace(/\s+/gu, ' ').trim()
}

function textChecks(unit, language) {
   const found = []
   const { text } = unit
   if (text.includes('\uFFFD')) found.push('replacement_char')
   if (controlPattern.test(text)) found.push('control_char')
   if (invisibleInWordPattern.test(text)) found.push('invisible_char_in_word')
   if (doubleSpacePattern.test(text)) found.push('double_space')
   if (spaceBeforePunctuationPattern.test(text)) found.push('space_before_punctuation')
   if (text.includes('|')) found.push('separator_in_text')
   if (hyphenWrapPattern.test(text)) found.push('hyphen_line_wrap')
   if (isolatedLetters(text, language).length) found.push('isolated_letter')
   return found
}

function tableChecks(content, prefix, language) {
   const previousTextOf = previousTextLookup(content)
   const findings = []
   const blocks = Array.isArray(content?.blocks) ? content.blocks : []
   blocks.forEach((block, index) => {
      if (block?.type !== 'table') return
      const path = `${prefix}.blocks[${index}]`
      const rows = Array.isArray(block.rows) ? block.rows : []
      const widths = new Set(rows.map((row) => (Array.isArray(row) ? row.length : 0)))
      if (widths.size > 1) findings.push({ type: 'table_column_mismatch', path, sample: JSON.stringify(rows).slice(0, 200) })
      rows.forEach((row, rowIndex) => {
         const cells = Array.isArray(row) ? row : []
         cells.forEach((cell, cellIndex) => {
            if (typeof cell !== 'string' || !cell.trim()) {
               findings.push({ type: 'table_empty_cell', path: `${path}.rows[${rowIndex}][${cellIndex}]`, sample: JSON.stringify(cells) })
            }
         })
         for (let cellIndex = 0; cellIndex + 1 < cells.length; cellIndex += 1) {
            const previousText = rowIndex === 0 && cellIndex === 0 ? previousTextOf(index) : ''
            const repair = repairColumnHeaders(cells[cellIndex], cells[cellIndex + 1], { previousText, language })
            if (repair.status === 'ok') continue
            findings.push({
               type: 'table_split_word',
               path: `${path}.rows[${rowIndex}]`,
               cells: [cellIndex, cellIndex + 1],
               sample: `${cells[cellIndex]} | ${cells[cellIndex + 1]}`,
               fix: repair.status === 'fixed' ? { left: repair.left, right: repair.right } : null,
               reason: repair.reason,
            })
         }
      })
   })
   return findings
}

function previousTextLookup(content) {
   const blocks = Array.isArray(content?.blocks) ? content.blocks : []
   return (index) => {
      for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
         if (blocks[cursor]?.type === 'text') return blocks[cursor].text ?? ''
      }
      return ''
   }
}

function contentFindings(content, prefix, language) {
   const findings = []
   for (const unit of textUnits(content, prefix)) {
      for (const type of textChecks(unit, language)) {
         // Table headers have their own, stricter check; skip the generic isolated letter there.
         if (unit.kind === 'cell' && type === 'isolated_letter') continue
         const finding = { type, path: unit.path, sample: unit.text.slice(0, 200) }
         if (type === 'isolated_letter') {
            const repaired = repairStrandedInitial(unit.text, language)
            finding.fix = repaired === null ? null : { text: repaired }
            finding.reason = repaired === null ? 'letter_owner_unclear' : 'stranded_initial'
         }
         findings.push(finding)
      }
   }
   findings.push(...tableChecks(content, prefix, language))
   return findings
}

function answerKeyFindings(question) {
   const findings = []
   const key = question.answerKey
   if (!key || key.status === 'unknown' || key.answerData === null || key.answerData === undefined) {
      findings.push({ type: 'missing_answer_key', path: 'answerKey', sample: key ? `status ${key.status}` : 'no key row' })
      return findings
   }
   const data = key.answerData
   const optionKeys = new Set(question.options.map((option) => option.key))
   if (question.type === 'single_choice' || question.type === 'multiple_choice') {
      const chosen = data.optionKey !== undefined ? [data.optionKey] : (Array.isArray(data.optionKeys) ? data.optionKeys : [])
      if (!chosen.length) findings.push({ type: 'missing_answer_key', path: 'answerKey', sample: JSON.stringify(data).slice(0, 200) })
      const unknown = chosen.filter((value) => !optionKeys.has(value))
      if (unknown.length) findings.push({ type: 'answer_key_unknown_reference', path: 'answerKey', sample: unknown.join(', ') })
   } else if (question.type === 'matching') {
      const left = new Set(question.matching.filter((item) => item.side === 'left').map((item) => item.key))
      const right = new Set(question.matching.filter((item) => item.side === 'right').map((item) => item.key))
      const pairs = Array.isArray(data.pairs) ? data.pairs : []
      if (!pairs.length) findings.push({ type: 'missing_answer_key', path: 'answerKey', sample: JSON.stringify(data).slice(0, 200) })
      const unknown = pairs.filter((pair) => !left.has(pair?.left) || !right.has(pair?.right))
      if (unknown.length) findings.push({ type: 'answer_key_unknown_reference', path: 'answerKey', sample: JSON.stringify(unknown).slice(0, 200) })
   }
   return findings
}

function duplicateFindings(items, label) {
   const findings = []
   const seen = new Map()
   for (const item of items) {
      const signature = contentSignature(item.content)
      if (!signature) {
         findings.push({ type: 'empty_option', path: `${label}:${item.key}`, sample: '' })
         continue
      }
      if (seen.has(signature)) {
         findings.push({
            type: 'duplicate_options',
            path: `${label}:${seen.get(signature)}=${item.key}`,
            sample: signature.slice(0, 200),
         })
      } else seen.set(signature, item.key)
   }
   return findings
}

// question: { id, type, language, content, options: [{ key, content }],
//    matching: [{ side, key, content }], answerKey: { status, answerData, explanation } | null }
function auditQuestion(question) {
   const { language } = question
   const findings = [...contentFindings(question.content, 'content', language)]
   for (const option of question.options) {
      findings.push(...contentFindings(option.content, `option:${option.key}`, language))
   }
   for (const item of question.matching) {
      findings.push(...contentFindings(item.content, `matching:${item.side}:${item.key}`, language))
   }
   if (question.answerKey?.explanation) {
      findings.push(...contentFindings(question.answerKey.explanation, 'explanation', language))
   }
   findings.push(...duplicateFindings(question.options, 'option'))
   findings.push(...duplicateFindings(question.matching.filter((item) => item.side === 'left'), 'matching:left'))
   findings.push(...duplicateFindings(question.matching.filter((item) => item.side === 'right'), 'matching:right'))
   findings.push(...answerKeyFindings(question))
   return findings
}

// Returns a corrected copy of a content document ({ blocks }) plus the list of changes, or
// null when nothing is certain to fix. Only the two unambiguous repairs run: a stranded letter
// between table header cells and a stranded capital at the start of a short text. Every other
// finding is left for manual review.
function fixContent(content, { language } = {}) {
   const blocks = Array.isArray(content?.blocks) ? content.blocks : []
   const previousTextOf = previousTextLookup(content)
   const changes = []
   const nextBlocks = blocks.map((block, index) => {
      if (block?.type === 'text' && typeof block.text === 'string') {
         const repaired = repairStrandedInitial(block.text, language)
         if (repaired === null) return block
         changes.push({ path: `blocks[${index}].text`, before: block.text, after: repaired })
         return { ...block, text: repaired }
      }
      if (block?.type !== 'table' || !Array.isArray(block.rows)) return block
      let tableChanged = false
      const rows = block.rows.map((row, rowIndex) => {
         if (!Array.isArray(row)) return row
         const cells = [...row]
         for (let cellIndex = 0; cellIndex + 1 < cells.length; cellIndex += 1) {
            const previousText = rowIndex === 0 && cellIndex === 0 ? previousTextOf(index) : ''
            const repair = repairColumnHeaders(cells[cellIndex], cells[cellIndex + 1], { previousText, language })
            if (repair.status !== 'fixed') continue
            changes.push({
               path: `blocks[${index}].rows[${rowIndex}]`,
               before: [cells[cellIndex], cells[cellIndex + 1]],
               after: [repair.left, repair.right],
            })
            cells[cellIndex] = repair.left
            cells[cellIndex + 1] = repair.right
            tableChanged = true
         }
         return cells
      })
      return tableChanged ? { ...block, rows } : block
   })
   return changes.length ? { content: { ...content, blocks: nextBlocks }, changes } : null
}

export { auditQuestion, contentSignature, fixContent, repairColumnHeaders, repairStrandedInitial, textUnits }
