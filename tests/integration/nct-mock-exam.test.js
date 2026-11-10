import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import pg from 'pg'

import env from '../../src/configs/env.js'
import {
   createMockExamService,
   getMockExamResultService,
   getMockExamService,
   listMockExamBlueprintsService,
   listMockExamHistoryService,
   saveMockExamAnswerService,
   setMockExamFlagService,
   submitMockExamService,
} from '../../src/services/mock-exam-service.js'
import {
   createQuestionBankService,
   createQuestionService,
   publishQuestionService,
   replaceAnswerKeyService,
   verifyAnswerKeyService,
} from '../../src/services/question-bank-service.js'
import { createSubjectService } from '../../src/services/taxonomy-service.js'
import { finalizeNextExpiredAttemptService, getAttemptResultService } from '../../src/services/test-attempt-service.js'
import { listTestAttemptsService } from '../../src/services/test-results-service.js'
import { listTestsService } from '../../src/services/test-service.js'
import {
   getTrainerCatalogService,
   getTrainerOverviewService,
   listTrainerHistoryService,
} from '../../src/services/trainer-service.js'
import { createMemoryStorageProvider } from '../helpers/memory-storage-provider.js'

const { Client } = pg
const suffix = randomUUID().slice(0, 8)
const text = (value) => ({ blocks: [{ type: 'text', text: value }] })
const subjectBase = ['zaboni-tochiki', 'biologiya', 'khimiya', 'fizika']

// The official A.5 layout: per subject [kind, first, last, points].
const layout = {
   'zaboni-tochiki': [['single', 1, 20, '1.00'], ['matching', 21, 25, '4.00']],
   biologiya: [['single', 1, 20, '1.00'], ['matching', 21, 24, '4.00'], ['cells', 25, 26, '2.00']],
   khimiya: [['single', 1, 18, '1.00'], ['matching', 19, 20, '4.00'], ['cells', 21, 27, '2.00']],
   fizika: [['single', 1, 18, '1.00'], ['matching', 19, 20, '4.00'], ['cells', 21, 27, '2.00']],
}

test('NCT mock exam integration', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   t.after(() => client.end())
   const storage = createMemoryStorageProvider()
   const deps = { storage }
   const later = (minutes) => ({ storage, clock: () => new Date(Date.now() + minutes * 60000) })

   async function createUser(role, status = 'active') {
      const { rows } = await client.query(
         `INSERT INTO users (status, onboarding_completed_at) VALUES ($1, CURRENT_TIMESTAMP) RETURNING id`,
         [status],
      )
      await client.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2', [rows[0].id, role])
      return String(rows[0].id)
   }

   const adminId = await createUser('admin')
   const studentId = await createUser('student')
   const otherId = await createUser('student')
   const lateId = await createUser('student')
   const sweptId = await createUser('student')
   const teacherId = await createUser('teacher')
   const pendingId = await createUser('student', 'pending')

   // A private copy of the seeded nct-a5 blueprint: private subject codes and bank prefix, so
   // other suites' subjects and banks cannot change what is picked.
   const prefix = `mx-${suffix}-`
   const blueprintCode = `mx-${suffix}`
   const subjectCode = (base) => `${base}-${suffix}`
   async function copyBlueprint(code, { language = 'en', codeOf = subjectCode } = {}) {
      const { rows: [copy] } = await client.query(
         `INSERT INTO exam_blueprints (code, titles, language_code, bank_code_prefix, duration_minutes)
          SELECT $1, titles, $2, $3, duration_minutes FROM exam_blueprints WHERE code = 'nct-a5'
          RETURNING id`,
         [code, language, prefix],
      )
      const sections = await client.query(
         `SELECT section.id, section.position, section.subject_code FROM exam_blueprint_sections AS section
          JOIN exam_blueprints AS blueprint ON blueprint.id = section.blueprint_id
          WHERE blueprint.code = 'nct-a5' ORDER BY section.position`,
      )
      for (const section of sections.rows) {
         const { rows: [created] } = await client.query(
            `INSERT INTO exam_blueprint_sections (blueprint_id, position, subject_code) VALUES ($1, $2, $3) RETURNING id`,
            [copy.id, section.position, codeOf(section.subject_code)],
         )
         await client.query(
            `INSERT INTO exam_blueprint_items (section_id, first_position, last_position, item_kind, points, scoring,
               option_count, left_count, right_count, max_digits, difficulty_min, difficulty_max, difficulty_order)
             SELECT $1, first_position, last_position, item_kind, points, scoring, option_count, left_count,
               right_count, max_digits, difficulty_min, difficulty_max, difficulty_order
             FROM exam_blueprint_items WHERE section_id = $2`,
            [created.id, section.id],
         )
      }
      return String(copy.id)
   }
   await copyBlueprint(blueprintCode)

   const subjects = {}
   const banks = {}
   for (const base of subjectBase) {
      subjects[base] = await createSubjectService(adminId, {
         code: subjectCode(base), primaryLanguage: 'en', translations: { en: { title: base } },
      })
      banks[base] = await createQuestionBankService(adminId, {
         code: `${prefix}${base}`, title: base, subjectId: subjects[base].id, visibility: 'staff',
      })
   }

   async function addQuestion(base, type, extra, answerData, difficulty = 3) {
      const created = await createQuestionService(adminId, banks[base].id, {
         questionType: type,
         languageCode: 'en',
         difficulty,
         difficultySource: 'expert',
         content: text(`${base} ${type}`),
         ...extra,
      })
      await replaceAnswerKeyService(adminId, created.id, {
         answerData, source: 'expert_review', explanation: text(`Because ${type}`),
      })
      await verifyAnswerKeyService(adminId, created.id, { source: 'expert_review' })
      await publishQuestionService(adminId, created.id)
      return String(created.id)
   }

   const options = (count) => ({
      options: Array.from({ length: count }, (_, index) => ({ key: `o${index + 1}`, content: text(`Option ${index + 1}`) })),
   })
   const matching = (left, right) => ({
      matching: {
         left: Array.from({ length: left }, (_, index) => ({ key: `l${index + 1}`, content: text(`L${index + 1}`) })),
         right: Array.from({ length: right }, (_, index) => ({ key: `r${index + 1}`, content: text(`R${index + 1}`) })),
      },
      interactionSettings: { requireAllLeft: true, allowRightReuse: false },
   })
   const pairs = (left) => ({ pairs: Array.from({ length: left }, (_, index) => ({ left: `l${index + 1}`, right: `r${((index + 1) % 5) + 1}` })) })

   // Exactly one exam's worth of eligible questions, half the cells numeric and half short_text
   // with spaces, plus decoys that must never be picked.
   const decoys = new Set()
   for (const [base, items] of Object.entries(layout)) {
      for (const [kind, first, last] of items) {
         for (let index = 0; index <= last - first; index += 1) {
            const difficulty = 1 + ((index * 7) % 5)
            if (kind === 'single') await addQuestion(base, 'single_choice', options(4), { optionKey: 'o2' }, difficulty)
            if (kind === 'matching') await addQuestion(base, 'matching', matching(4, 5), pairs(4), difficulty)
            if (kind === 'cells') {
               if (index % 2) await addQuestion(base, 'short_text', {}, { acceptedAnswers: [' 1 2 '] }, difficulty)
               else await addQuestion(base, 'numeric', {}, { value: 7 + index }, difficulty)
            }
         }
      }
      decoys.add(await addQuestion(base, 'single_choice', options(3), { optionKey: 'o1' }))
      decoys.add(await addQuestion(base, 'matching', matching(3, 5), pairs(3)))
      decoys.add(await addQuestion(base, 'matching', matching(4, 4), { pairs: [{ left: 'l1', right: 'r1' }, { left: 'l2', right: 'r2' }, { left: 'l3', right: 'r3' }, { left: 'l4', right: 'r4' }] }))
      decoys.add(await addQuestion(base, 'numeric', {}, { value: 12.5 }))
      decoys.add(await addQuestion(base, 'numeric', {}, { value: 12345 }))
      decoys.add(await addQuestion(base, 'numeric', {}, { value: -3 }))
      decoys.add(await addQuestion(base, 'short_text', {}, { acceptedAnswers: ['12 cm'] }))
      decoys.add(await addQuestion(base, 'short_text', {}, { acceptedAnswers: ['12', 'twelve'] }))
   }

   async function snapshots(attemptId) {
      const { rows } = await client.query(
         'SELECT id, question_id, grading_snapshot FROM attempt_questions WHERE attempt_id = $1',
         [attemptId],
      )
      return new Map(rows.map((row) => [String(row.id), row]))
   }

   const findSection = (view, base) => view.sections.find((section) => section.subjectCode === subjectCode(base))

   await t.test('the seeded nct-a5 blueprint: 105 questions, 220 minutes, 40 per subject, 160 in total', async () => {
      const { blueprints } = await listMockExamBlueprintsService(studentId, deps)
      const seeded = blueprints.find((entry) => entry.code === 'nct-a5')
      assert.equal(seeded.durationMinutes, 220)
      assert.equal(seeded.questionCount, 105)
      assert.equal(seeded.maxScore, '160.00')
      assert.equal(seeded.language, 'tg')
      assert.deepEqual(seeded.sections.map((section) => section.subjectCode), subjectBase)
      for (const section of seeded.sections) {
         assert.equal(section.maxScore, '40.00')
         assert.deepEqual(
            section.items.map((item) => [item.kind, item.firstPosition, item.lastPosition, item.points]),
            layout[section.subjectCode],
         )
         for (const item of section.items) {
            if (item.kind === 'single') assert.deepEqual(item.requirements, { optionCount: 4 })
            if (item.kind === 'matching') assert.deepEqual(item.requirements, { leftCount: 4, rightCount: 5 })
            if (item.kind === 'cells') assert.deepEqual(item.requirements, { maxDigits: 4, wholeNumber: true })
         }
      }
      const copy = blueprints.find((entry) => entry.code === blueprintCode)
      assert.equal(copy.canAssemble, true)
      assert.equal(copy.distinctVariants, 1)
      assert.deepEqual(copy.shortages, [])
      const bio = copy.sections.find((section) => section.subjectCode === subjectCode('biologiya'))
      assert.deepEqual(bio.items.map((item) => item.available), [20, 4, 2])
   })

   await t.test('teachers and inactive accounts have no access', async () => {
      await assert.rejects(listMockExamBlueprintsService(teacherId, deps), { code: 'TRAINER_STUDENT_ROLE_REQUIRED' })
      await assert.rejects(createMockExamService(teacherId, { blueprint: blueprintCode }, deps), { code: 'TRAINER_STUDENT_ROLE_REQUIRED' })
      await assert.rejects(listMockExamBlueprintsService(pendingId, deps), { code: 'ACCOUNT_NOT_ACTIVE' })
      await assert.rejects(createMockExamService(studentId, { blueprint: 'Bad Code' }, deps), { code: 'VALIDATION_ERROR' })
      await assert.rejects(createMockExamService(studentId, { blueprint: 'no-such-blueprint' }, deps), { code: 'MOCK_EXAM_BLUEPRINT_NOT_FOUND' })
   })

   await t.test('a missing kind is a clear error naming subject and kind', async () => {
      const shortCode = `mx-${suffix}-short`
      await copyBlueprint(shortCode, {
         codeOf: (code) => (code === 'khimiya' ? `missing-${suffix}` : subjectCode(code)),
      })
      await client.query(
         `UPDATE exam_blueprint_items SET difficulty_min = 5 FROM exam_blueprint_sections AS section
          JOIN exam_blueprints AS blueprint ON blueprint.id = section.blueprint_id
          WHERE exam_blueprint_items.section_id = section.id AND blueprint.code = $1
            AND section.subject_code = $2 AND exam_blueprint_items.item_kind = 'cells'`,
         [shortCode, subjectCode('biologiya')],
      )
      const error = await createMockExamService(studentId, { blueprint: shortCode }, deps).catch((caught) => caught)
      assert.equal(error.code, 'MOCK_EXAM_NOT_ENOUGH_QUESTIONS')
      const fields = error.details.map((detail) => detail.field)
      assert.ok(fields.includes(`${subjectCode('biologiya')}.cells`))
      assert.ok(fields.includes(`missing-${suffix}.single`))
      assert.ok(fields.includes(`missing-${suffix}.cells`))
      assert.match(error.details.find((detail) => detail.field === `missing-${suffix}.single`).message, /needed 18, available 0/)
      const { blueprints } = await listMockExamBlueprintsService(studentId, deps)
      const entry = blueprints.find((row) => row.code === shortCode)
      assert.equal(entry.canAssemble, false)
      assert.equal(entry.distinctVariants, 0)
      // Nothing was created by the failed attempt.
      assert.equal((await listMockExamHistoryService(studentId, {}, deps)).openAttemptId, null)
   })

   let exam
   await t.test('assembly follows the blueprint: kinds, sheet numbers, no repeats, keys hidden', async () => {
      exam = await createMockExamService(studentId, { blueprint: blueprintCode, idempotencyKey: `exam-${suffix}` }, deps)
      assert.equal(exam.resumed, false)
      assert.equal(exam.exam.status, 'in_progress')
      assert.equal(exam.exam.maxScore, '160.00')
      assert.equal(exam.exam.questionCount, 105)
      const remaining = exam.exam.remainingSeconds
      assert.ok(remaining > 220 * 60 - 30 && remaining <= 220 * 60)
      assert.equal(new Date(exam.exam.deadlineAt) - new Date(exam.exam.startedAt), 220 * 60000)
      assert.ok(exam.serverNow)
      assert.deepEqual(exam.sections.map((section) => section.subjectCode), subjectBase.map(subjectCode))
      const snapshot = await snapshots(exam.exam.attemptId)
      const seen = new Set()
      for (const section of exam.sections) {
         const base = subjectBase.find((entry) => subjectCode(entry) === section.subjectCode)
         assert.equal(section.maxScore, '40.00')
         assert.deepEqual(section.questions.map((question) => question.number), section.questions.map((_, index) => index + 1))
         for (const [kind, first, last, points] of layout[base]) {
            const range = section.questions.slice(first - 1, last)
            assert.ok(range.every((question) => question.kind === kind && question.points === points), `${base} ${kind}`)
            const questionIds = range.map((question) => snapshot.get(question.attemptQuestionId).question_id)
            const difficulties = (await client.query(
               'SELECT id, difficulty FROM questions WHERE id = ANY($1::bigint[])', [questionIds],
            )).rows
            const byId = new Map(difficulties.map((row) => [String(row.id), row.difficulty]))
            const ordered = questionIds.map((id) => byId.get(String(id)))
            assert.deepEqual(ordered, [...ordered].sort((a, b) => a - b), `${base} ${kind} is easy to hard`)
         }
         for (const question of section.questions) {
            const row = snapshot.get(question.attemptQuestionId)
            assert.ok(!seen.has(String(row.question_id)), 'no question twice')
            assert.ok(!decoys.has(String(row.question_id)), 'no ineligible question')
            seen.add(String(row.question_id))
            if (question.kind === 'single') assert.equal(question.options.length, 4)
            if (question.kind === 'matching') {
               assert.equal(question.matching.left.length, 4)
               assert.equal(question.matching.right.length, 5)
            }
            if (question.kind === 'cells') {
               assert.equal(row.grading_snapshot.answerFormat, 'digits')
               assert.ok(row.grading_snapshot.acceptedDigits.every((value) => /^[0-9]{1,4}$/.test(value)))
            }
         }
      }
      assert.equal(seen.size, 105)
      const serialized = JSON.stringify(exam)
      assert.ok(!/acceptedAnswers|acceptedDigits|answerData|correctAnswer|explanation|Because|"pairs"/.test(serialized))
      // The short_text key ' 1 2 ' is stored as the digits 12.
      const textCell = [...snapshot.values()].find((row) => row.grading_snapshot.questionType === 'short_text')
      assert.deepEqual(textCell.grading_snapshot.acceptedDigits, ['12'])
   })

   await t.test('one running exam per user; idempotencyKey resumes, reuse for another blueprint is rejected', async () => {
      const busy = await createMockExamService(studentId, { blueprint: blueprintCode }, deps).catch((error) => error)
      assert.equal(busy.code, 'MOCK_EXAM_IN_PROGRESS')
      assert.deepEqual(busy.details, [{ field: 'attemptId', message: String(exam.exam.attemptId) }])
      const again = await createMockExamService(studentId, { blueprint: blueprintCode, idempotencyKey: `exam-${suffix}` }, deps)
      assert.equal(again.resumed, true)
      assert.equal(again.exam.attemptId, exam.exam.attemptId)
      await assert.rejects(
         createMockExamService(studentId, { blueprint: 'nct-a5', idempotencyKey: `exam-${suffix}` }, deps),
         { code: 'IDEMPOTENCY_KEY_REUSED' },
      )
   })

   await t.test('another user cannot read or answer the exam; keys stay hidden before finishing', async () => {
      const id = exam.exam.attemptId
      const question = exam.sections[0].questions[0]
      await assert.rejects(getMockExamService(otherId, id, deps), { code: 'MOCK_EXAM_NOT_FOUND' })
      await assert.rejects(
         saveMockExamAnswerService(otherId, id, question.attemptQuestionId, { answer: { optionKey: 'o2' }, revision: 1 }, deps),
         { code: 'MOCK_EXAM_NOT_FOUND' },
      )
      await assert.rejects(
         setMockExamFlagService(otherId, id, question.attemptQuestionId, { flagged: true }, deps),
         { code: 'MOCK_EXAM_NOT_FOUND' },
      )
      await assert.rejects(getMockExamResultService(otherId, id, deps), { code: 'MOCK_EXAM_NOT_FOUND' })
      await assert.rejects(getMockExamResultService(studentId, id, deps), { code: 'RESULT_NOT_READY' })
      await assert.rejects(getAttemptResultService(studentId, id, deps), { code: 'RESULT_NOT_READY' })
   })

   await t.test('cells accept only 1-4 digits', async () => {
      const cell = findSection(exam, 'biologiya').questions.find((question) => question.kind === 'cells')
      for (const answer of [{ digits: '12a' }, { digits: '12345' }, { digits: '' }, { digits: '-1' }, { digits: '1,5' }, { digits: 12 }, { value: 12 }, { text: '12' }]) {
         await assert.rejects(
            saveMockExamAnswerService(studentId, exam.exam.attemptId, cell.attemptQuestionId, { answer, revision: 1 }, deps),
            { code: 'VALIDATION_ERROR' },
            JSON.stringify(answer),
         )
      }
   })

   await t.test('a question can be flagged to review later and unflagged', async () => {
      const question = findSection(exam, 'fizika').questions[2]
      const flagged = await setMockExamFlagService(studentId, exam.exam.attemptId, question.attemptQuestionId, { flagged: true }, deps)
      assert.equal(flagged.flagged, true)
      assert.ok(flagged.flaggedAt)
      const view = await getMockExamService(studentId, exam.exam.attemptId, deps)
      assert.equal(findSection(view, 'fizika').flagged, 1)
      assert.equal(findSection(view, 'fizika').questions[2].flagged, true)
      await assert.rejects(
         setMockExamFlagService(studentId, exam.exam.attemptId, question.attemptQuestionId, { flagged: 'yes' }, deps),
         { code: 'VALIDATION_ERROR' },
      )
      const cleared = await setMockExamFlagService(studentId, exam.exam.attemptId, question.attemptQuestionId, { flagged: false }, deps)
      assert.equal(cleared.flaggedAt, null)
      await setMockExamFlagService(studentId, exam.exam.attemptId, question.attemptQuestionId, { flagged: true }, deps)
   })

   // Answers from the stored keys: matching with a chosen number of correct pairs (wrong rows
   // take other unused right items), cells right or wrong.
   function matchingAnswer(key, rights, correctCount) {
      const used = new Set(key.pairs.slice(0, correctCount).map((pair) => pair.right))
      return {
         pairs: key.pairs.map((pair, index) => {
            if (index < correctCount) return { left: pair.left, right: pair.right }
            const right = rights.find((candidate) => candidate !== pair.right && !used.has(candidate))
            used.add(right)
            return { left: pair.left, right }
         }),
      }
   }

   const plan = {
      'zaboni-tochiki': { single: 'all', matching: [4, 4, 4, 4, 4], cells: [] },
      biologiya: { single: 'all', matching: [4, 3, 2, 1], cells: ['padded', 'wrong'] },
      khimiya: { single: 'none', matching: [0, null], cells: ['right', 'right', 'right', 'right', 'right', 'right', 'right'] },
      fizika: { single: 'all', matching: [4, 4], cells: ['right', 'right', 'right', 'right', 'right', 'right', 'right'] },
   }
   const expectedScores = { 'zaboni-tochiki': '40.00', biologiya: '32.00', khimiya: '14.00', fizika: '40.00' }

   await t.test('answers in any order, changed before finishing', async () => {
      const snapshot = await snapshots(exam.exam.attemptId)
      const writes = []
      for (const base of subjectBase) {
         const section = findSection(exam, base)
         const matchingQuestions = section.questions.filter((question) => question.kind === 'matching')
         const cellQuestions = section.questions.filter((question) => question.kind === 'cells')
         for (const question of section.questions.filter((entry) => entry.kind === 'single')) {
            if (plan[base].single === 'all') writes.push([question, { optionKey: snapshot.get(question.attemptQuestionId).grading_snapshot.answerData.optionKey }])
         }
         matchingQuestions.forEach((question, index) => {
            const correct = plan[base].matching[index]
            if (correct === null) return
            const key = snapshot.get(question.attemptQuestionId).grading_snapshot.answerData
            writes.push([question, matchingAnswer(key, question.matching.right.map((item) => item.key), correct)])
         })
         cellQuestions.forEach((question, index) => {
            const accepted = snapshot.get(question.attemptQuestionId).grading_snapshot.acceptedDigits[0]
            const mode = plan[base].cells[index]
            const digits = mode === 'padded' ? accepted.padStart(4, '0') : mode === 'wrong' ? String((Number(accepted) + 1) % 10000) : accepted
            writes.push([question, { digits }])
         })
      }
      // Last question first; one single choice is first answered wrong, then corrected.
      const changed = findSection(exam, 'fizika').questions[0]
      const wrongKey = changed.options.map((option) => option.key)
         .find((key) => key !== snapshot.get(changed.attemptQuestionId).grading_snapshot.answerData.optionKey)
      await saveMockExamAnswerService(studentId, exam.exam.attemptId, changed.attemptQuestionId, { answer: { optionKey: wrongKey }, revision: 1 }, deps)
      for (const [question, answer] of writes.reverse()) {
         const revision = question.attemptQuestionId === changed.attemptQuestionId ? 2 : 1
         const saved = await saveMockExamAnswerService(studentId, exam.exam.attemptId, question.attemptQuestionId, { answer, revision }, deps)
         assert.equal(saved.revision, revision)
      }
      const view = await getMockExamService(studentId, exam.exam.attemptId, deps)
      assert.equal(findSection(view, 'khimiya').answered, 8)
      assert.equal(findSection(view, 'zaboni-tochiki').answered, 25)
   })

   let result
   await t.test('finishing scores by the blueprint: matching per pair, cells 2 or 0, 40 per subject', async () => {
      result = await submitMockExamService(studentId, exam.exam.attemptId, deps)
      assert.equal(result.exam.status, 'graded')
      assert.equal(result.exam.score, '126.00')
      assert.equal(result.exam.maxScore, '160.00')
      assert.equal(result.exam.percent, 78.75)
      for (const base of subjectBase) {
         const section = findSection(result, base)
         assert.equal(section.score, expectedScores[base], base)
         assert.equal(section.maxScore, '40.00')
         assert.equal(section.questions.reduce((sum, question) => sum + Number(question.points), 0), 40)
      }
      const fullMarks = ['zaboni-tochiki', 'fizika'].map((base) => findSection(result, base))
      assert.ok(fullMarks.every((section) => section.percent === 100 && section.correct === section.questionCount))

      const bio = findSection(result, 'biologiya')
      const bioMatching = bio.questions.filter((question) => question.kind === 'matching')
      assert.deepEqual(bioMatching.map((question) => question.awardedPoints), ['4.00', '3.00', '2.00', '1.00'])
      assert.deepEqual(bioMatching.map((question) => question.sheet.correctPairs), [4, 3, 2, 1])
      const row = bioMatching[1].sheet.rows
      assert.deepEqual(row.map((entry) => entry.row), ['A', 'B', 'C', 'D'])
      assert.deepEqual(row.map((entry) => entry.correct), [true, true, true, false])
      assert.ok(row.every((entry) => entry.correctColumn >= 1 && entry.correctColumn <= 5 && entry.selectedColumn >= 1))
      const bioCells = bio.questions.filter((question) => question.kind === 'cells')
      assert.deepEqual(bioCells.map((question) => question.awardedPoints), ['2.00', '0.00'])
      assert.equal(bioCells[0].sheet.digits.length, 4)
      assert.equal(bioCells[0].sheet.digits.replace(/^0+(?=[0-9])/, ''), bioCells[0].sheet.correctDigits)
      assert.notEqual(bioCells[1].sheet.digits, bioCells[1].sheet.correctDigits)
      assert.equal(bio.answered, 26)
      assert.equal(bio.correct, 20 + 1 + 1)

      const khimiya = findSection(result, 'khimiya')
      const khMatching = khimiya.questions.filter((question) => question.kind === 'matching')
      assert.deepEqual(khMatching.map((question) => question.awardedPoints), ['0.00', '0.00'])
      assert.equal(khMatching[1].answered, false)
      assert.ok(khMatching[1].sheet.rows.every((entry) => entry.selectedColumn === null && entry.correctColumn !== null))
      const single = khimiya.questions[0]
      assert.equal(single.answered, false)
      assert.equal(single.sheet.selectedOptionNumber, null)
      assert.ok(single.sheet.correctOptionNumber >= 1 && single.sheet.correctOptionNumber <= 4)
      assert.equal(khimiya.answered, 8)

      const fiz = findSection(result, 'fizika')
      assert.equal(fiz.questions[0].sheet.selectedOptionKey, fiz.questions[0].sheet.correctOptionKey)
      assert.equal(fiz.questions[2].flagged, true)
      assert.ok(fiz.questions[0].explanation)
      assert.ok(fiz.questions[0].correctAnswer)
   })

   await t.test('finishing again returns the same result; a finished exam takes no answers', async () => {
      const again = await submitMockExamService(studentId, exam.exam.attemptId, deps)
      assert.equal(again.exam.score, result.exam.score)
      assert.equal(again.exam.submittedAt, result.exam.submittedAt)
      const read = await getMockExamResultService(studentId, exam.exam.attemptId, deps)
      assert.deepEqual(read.sections.map((section) => section.score), result.sections.map((section) => section.score))
      const question = exam.sections[0].questions[0]
      await assert.rejects(
         saveMockExamAnswerService(studentId, exam.exam.attemptId, question.attemptQuestionId, { answer: null, revision: 9 }, deps),
         { code: 'ATTEMPT_NOT_IN_PROGRESS' },
      )
      await assert.rejects(
         setMockExamFlagService(studentId, exam.exam.attemptId, question.attemptQuestionId, { flagged: false }, deps),
         { code: 'ATTEMPT_NOT_IN_PROGRESS' },
      )
      const view = await getMockExamService(studentId, exam.exam.attemptId, deps)
      assert.equal(view.exam.finished, true)
      assert.ok(view.sections.every((section) => section.questions.length === 0))
   })

   await t.test('an answer after the deadline is rejected and the exam is finished automatically', async () => {
      const late = await createMockExamService(lateId, { blueprint: blueprintCode }, deps)
      const first = late.sections[0].questions[0]
      await saveMockExamAnswerService(lateId, late.exam.attemptId, first.attemptQuestionId, { answer: { optionKey: first.options[0].key }, revision: 1 }, deps)
      await assert.rejects(
         saveMockExamAnswerService(lateId, late.exam.attemptId, late.sections[1].questions[0].attemptQuestionId, { answer: { optionKey: 'o1' }, revision: 1 }, later(221)),
         { code: 'ATTEMPT_DEADLINE_PASSED' },
      )
      const view = await getMockExamService(lateId, late.exam.attemptId, deps)
      assert.equal(view.exam.status, 'expired')
      assert.equal(view.exam.autoSubmitted, true)
      assert.equal(view.exam.remainingSeconds, 0)
      assert.equal(view.exam.submittedAt, late.exam.deadlineAt)
      const graded = await getMockExamResultService(lateId, late.exam.attemptId, deps)
      assert.ok(['0.00', '1.00'].includes(graded.exam.score))
      // Before the deadline a GET reports the remaining time from the server clock.
      const next = await createMockExamService(lateId, { blueprint: blueprintCode }, deps)
      const soon = await getMockExamService(lateId, next.exam.attemptId, later(200))
      assert.ok(soon.exam.remainingSeconds > 19 * 60 && soon.exam.remainingSeconds <= 20 * 60 + 1)
      await assert.rejects(
         setMockExamFlagService(lateId, next.exam.attemptId, next.sections[0].questions[0].attemptQuestionId, { flagged: true }, later(221)),
         { code: 'ATTEMPT_DEADLINE_PASSED' },
      )
      assert.equal((await getMockExamService(lateId, next.exam.attemptId, deps)).exam.status, 'expired')
   })

   await t.test('the background sweep finishes an exam nobody opens again', async () => {
      const swept = await createMockExamService(sweptId, { blueprint: blueprintCode }, deps)
      while (await finalizeNextExpiredAttemptService({}, later(221)));
      const { rows } = await client.query('SELECT status, score FROM test_attempts WHERE id = $1', [swept.exam.attemptId])
      assert.equal(rows[0].status, 'expired')
      assert.equal(rows[0].score, '0.00')
   })

   await t.test('history lists finished exams with points per subject', async () => {
      const history = await listMockExamHistoryService(studentId, {}, deps)
      assert.equal(history.openAttemptId, null)
      assert.equal(history.exams.length, 1)
      const [entry] = history.exams
      assert.equal(entry.attemptId, exam.exam.attemptId)
      assert.equal(entry.blueprintCode, blueprintCode)
      assert.equal(entry.score, '126.00')
      assert.equal(entry.maxScore, '160.00')
      assert.deepEqual(entry.subjects.map((subject) => [subject.subjectCode, subject.score, subject.maxScore]),
         subjectBase.map((base) => [subjectCode(base), expectedScores[base], '40.00']))
      const lateHistory = await listMockExamHistoryService(lateId, { limit: '1' }, deps)
      assert.equal(lateHistory.exams.length, 1)
      assert.equal(lateHistory.pagination.hasMore, true)
      assert.ok(lateHistory.exams.every((row) => row.autoSubmitted))
      await assert.rejects(listMockExamHistoryService(studentId, { limit: '0' }, deps), { code: 'VALIDATION_ERROR' })
   })

   await t.test('mock exams stay out of the trainer, admin test lists and staff results', async () => {
      const overview = await getTrainerOverviewService(studentId, deps)
      assert.equal(overview.empty, true)
      assert.equal(overview.completedTrainings, 0)
      const trainings = await listTrainerHistoryService(studentId, {}, deps)
      assert.deepEqual(trainings.attempts, [])
      assert.deepEqual(trainings.stats, [])
      // The trainer only reads nct- banks, so this exam's private banks are not in its catalog.
      const catalog = await getTrainerCatalogService(studentId, deps)
      assert.ok(!catalog.subjects.some((subject) => subject.code === subjectCode('biologiya')))
      const testId = (await client.query('SELECT test_id FROM test_attempts WHERE id = $1', [exam.exam.attemptId])).rows[0].test_id
      const listed = (await listTestsService(adminId, { limit: '100' })).tests.map((row) => String(row.id))
      assert.ok(!listed.includes(String(testId)))
      await assert.rejects(listTestAttemptsService(adminId, testId, {}), { code: 'TEST_NOT_FOUND' })
      const { rows } = await client.query('SELECT origin, course_id, mode, duration_seconds FROM tests WHERE id = $1', [testId])
      assert.deepEqual(rows[0], { origin: 'mock_exam', course_id: null, mode: 'nct', duration_seconds: 220 * 60 })
   })
})
