import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import pg from 'pg'

import env from '../../src/configs/env.js'
import { runNotificationFanoutService } from '../../src/services/notification-service.js'
import {
   createQuestionBankService,
   createQuestionService,
   publishQuestionService,
   replaceAnswerKeyService,
   verifyAnswerKeyService,
} from '../../src/services/question-bank-service.js'
import { getStudentHomeService, listStudentAttemptsService } from '../../src/services/student-home-service.js'
import { createSectionService, createSubjectService, createTopicService } from '../../src/services/taxonomy-service.js'
import { getAttemptService, saveAnswerService, startAttemptService, submitAttemptService } from '../../src/services/test-attempt-service.js'
import { grantExtraAttemptsService, listTestAttemptsService, regradeAttemptService } from '../../src/services/test-results-service.js'
import {
   copyTestService,
   createAssignmentService,
   createTestService,
   generateTestQuestionsService,
   getGeneratorAvailabilityService,
   getTestService,
   listTestsService,
   publishTestService,
   removeTestQuestionService,
   updateTestService,
} from '../../src/services/test-service.js'
import { getStaffTrainerCatalogService, getTrainerCatalogService } from '../../src/services/trainer-service.js'
import { createMemoryStorageProvider } from '../helpers/memory-storage-provider.js'

const { Client } = pg
const suffix = randomUUID().slice(0, 8)
const text = (value) => ({ blocks: [{ type: 'text', text: value }] })
const future = (hours) => new Date(Date.now() + hours * 3600000).toISOString()

// M10 tail (decisions.md 2026-11-23): standalone tests, the question generator, the staff trainer
// catalog and availability, teacher publication and assignment scope.
test('standalone tests and the question generator', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   t.after(() => client.end())
   const trainerConfig = { ...env.trainer, bankCodePrefix: `nct-${suffix}-`, questionCounts: [5, 10] }
   const trainer = { trainerConfig }
   const deps = { trainer }
   const attemptDeps = { storage: createMemoryStorageProvider() }

   async function createUser(role) {
      const { rows } = await client.query(
         `INSERT INTO users (status, onboarding_completed_at) VALUES ('active', CURRENT_TIMESTAMP) RETURNING id`,
      )
      await client.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2', [rows[0].id, role])
      return String(rows[0].id)
   }
   async function createGroup(title) {
      const { rows } = await client.query(
         'INSERT INTO groups (code, title, created_by) VALUES ($1, $2, $3) RETURNING id',
         [`${title}-${suffix}`, title, adminId],
      )
      return String(rows[0].id)
   }
   const addMember = (groupId, userId) => client.query(
      'INSERT INTO group_members (group_id, user_id, added_by) VALUES ($1, $2, $3)', [groupId, userId, adminId],
   )
   const addTeacher = (groupId, userId, flags) => client.query(
      `INSERT INTO group_teachers (group_id, user_id, can_assign_tests, can_view_results, assigned_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [groupId, userId, flags.assign, flags.results, adminId],
   )

   const adminId = await createUser('admin')
   const teacherId = await createUser('teacher')
   const otherTeacherId = await createUser('teacher')
   const memberId = await createUser('student')
   const secondMemberId = await createUser('student')
   const outsiderId = await createUser('student')
   const group = await createGroup('alpha')
   const viewOnlyGroup = await createGroup('beta')
   await addMember(group, memberId)
   await addMember(group, secondMemberId)
   await addMember(viewOnlyGroup, outsiderId)
   await addTeacher(group, teacherId, { assign: true, results: true })
   await addTeacher(viewOnlyGroup, teacherId, { assign: false, results: true })

   const subject = await createSubjectService(adminId, {
      code: `standalone-${suffix}`, primaryLanguage: 'en', translations: { en: { title: 'Standalone subject' } },
   })
   const section = await createSectionService(adminId, subject.id, {
      code: 'part-a', primaryLanguage: 'en', translations: { en: { title: 'Part A' } },
   })
   const topicIds = {}
   for (const code of ['alpha', 'beta']) {
      topicIds[code] = (await createTopicService(adminId, subject.id, {
         code, primaryLanguage: 'en', translations: { en: { title: code } }, sectionId: section.id,
      })).id
   }
   const bank = await createQuestionBankService(adminId, {
      code: `nct-${suffix}-bank`, title: 'NCT', subjectId: subject.id, visibility: 'staff',
   })
   // Every key is B.
   const allIds = []
   for (const [topic, difficulty, count] of [['alpha', 1, 6], ['beta', 3, 4]]) {
      for (let index = 0; index < count; index += 1) {
         const question = await createQuestionService(adminId, bank.id, {
            questionType: 'single_choice', languageCode: 'en', difficulty, difficultySource: 'expert',
            topicIds: [topicIds[topic]], content: text(`${topic} ${index}`),
            options: [{ key: 'A', content: text('A') }, { key: 'B', content: text('B') }],
         })
         await replaceAnswerKeyService(adminId, question.id, { answerData: { optionKey: 'B' }, source: 'expert_review' })
         await verifyAnswerKeyService(adminId, question.id, { source: 'expert_review' })
         await publishQuestionService(adminId, question.id)
         allIds.push(String(question.id))
      }
   }
   const generate = (userId, testId, body) => generateTestQuestionsService(userId, testId, { subject: subject.code, ...body }, deps)
   const jobKeys = async (prefix) => (await client.query(
      'SELECT dedupe_key FROM background_jobs WHERE dedupe_key LIKE $1 ORDER BY id', [`${prefix}%`],
   )).rows.map((row) => row.dedupe_key)

   let testId
   let groupAssignmentId

   await t.test('a teacher creates a standalone test; only its author and administrators reach it', async () => {
      await assert.rejects(createTestService(teacherId, { title: 'No course key' }), { code: 'VALIDATION_ERROR' })
      await assert.rejects(createTestService(teacherId, { courseId: null, moduleId: '1', title: 'x' }), { code: 'VALIDATION_ERROR' })
      const created = await createTestService(teacherId, { courseId: null, title: 'Group quiz', maxAttempts: 2, passPercent: 50 })
      testId = String(created.id)
      assert.deepEqual([created.origin, created.courseId, created.moduleId, created.generation], ['standalone', null, null, null])
      await assert.rejects(updateTestService(teacherId, testId, { moduleId: '1' }), { code: 'VALIDATION_ERROR' })

      await assert.rejects(getTestService(otherTeacherId, testId), { code: 'TEST_NOT_FOUND' })
      assert.equal((await getTestService(adminId, testId)).origin, 'standalone')
      const own = await listTestsService(teacherId, { origin: 'standalone', limit: '100' })
      assert.deepEqual(own.tests.map((row) => String(row.id)), [testId])
      assert.equal((await listTestsService(otherTeacherId, { origin: 'standalone' })).tests.length, 0)
      await assert.rejects(listTestsService(teacherId, { origin: 'trainer' }), { code: 'VALIDATION_ERROR' })
   })

   await t.test('staff catalog and availability: no mistakes, exact counts without the questions already in the test', async () => {
      const catalog = await getStaffTrainerCatalogService(teacherId, trainer)
      const entry = catalog.subjects.find((row) => row.code === subject.code)
      assert.equal(Object.hasOwn(entry, 'mistakes'), false)
      assert.ok(entry.topics.every((topic) => !Object.hasOwn(topic, 'mistakes')))
      assert.deepEqual(entry.languages, [{ language: 'en', total: 10, difficulties: { easy: 6, medium: 4, hard: 0 } }])
      const check = (query) => getGeneratorAvailabilityService(teacherId, { subject: subject.code, difficulty: 'mixed', ...query }, deps)
      assert.equal((await check({ topicCodes: 'alpha,beta', testId })).available, 10)
      await assert.rejects(check({ mode: 'mistakes' }), { code: 'VALIDATION_ERROR' })
      await assert.rejects(getGeneratorAvailabilityService(otherTeacherId, { subject: subject.code, difficulty: 'mixed', testId }, deps), { code: 'TEST_NOT_FOUND' })
   })

   await t.test('generate fills the draft by parameters with the trainer rules; manual edits stay possible', async () => {
      await assert.rejects(generate(teacherId, testId, { difficulty: 'mixed', count: 7 }), { code: 'VALIDATION_ERROR' })
      await assert.rejects(generate(otherTeacherId, testId, { difficulty: 'mixed', count: 5 }), { code: 'TEST_NOT_FOUND' })
      const first = await generate(teacherId, testId, { difficulty: 'mixed', count: 5, topicCodes: ['beta', 'alpha'] })
      assert.equal(first.questions.length, 5)
      assert.equal(first.addedQuestionIds.length, 5)
      assert.ok(first.questions.every((question) => question.points === '1.00' && allIds.includes(String(question.questionId))))
      assert.deepEqual(
         [first.generation.subjectCode, first.generation.difficulty, first.generation.count, first.generation.topicCodes, first.generation.language, first.generation.generations],
         [subject.code, 'mixed', 5, ['alpha', 'beta'], 'en', 1],
      )
      // Five are left: "all" needs fewer than the smallest count (5), a number takes them.
      assert.equal((await getGeneratorAvailabilityService(teacherId, { subject: subject.code, difficulty: 'mixed', testId }, deps)).available, 5)
      await assert.rejects(
         generate(teacherId, testId, { difficulty: 'mixed', count: 'all' }),
         (error) => error.code === 'TRAINER_COUNT_ALL_NOT_ALLOWED' && error.details[0].message === '5',
      )
      const second = await generate(teacherId, testId, { difficulty: 'mixed', count: 5 })
      assert.equal(new Set(second.questions.map((question) => String(question.questionId))).size, 10)
      assert.equal(second.generation.generations, 2)
      await assert.rejects(
         generate(teacherId, testId, { difficulty: 'mixed', count: 5 }),
         (error) => error.code === 'TRAINER_NOT_ENOUGH_QUESTIONS' && error.details[0].message === '0',
      )
      // A removed question can come back through the generator ("all" with 1 left).
      const removed = await removeTestQuestionService(teacherId, testId, second.questions[0].questionId)
      assert.equal(removed.questions.length, 9)
      const back = await generate(teacherId, testId, { difficulty: 'mixed', count: 'all' })
      assert.equal(back.addedQuestionIds.length, 1)
      assert.equal(back.questions.length, 10)
   })

   await t.test('a teacher publishes their own test and assigns only their groups and members', async () => {
      const published = await publishTestService(teacherId, testId)
      assert.equal(published.status, 'published')
      await assert.rejects(generate(teacherId, testId, { difficulty: 'mixed', count: 5 }), { code: 'TEST_IMMUTABLE' })

      await assert.rejects(createAssignmentService(teacherId, testId, { groupId: viewOnlyGroup }), { code: 'GROUP_NOT_FOUND' })
      await assert.rejects(createAssignmentService(teacherId, testId, { userId: outsiderId }), { code: 'USER_NOT_FOUND' })
      const assignment = await createAssignmentService(teacherId, testId, { groupId: group, closesAt: future(48) })
      groupAssignmentId = String(assignment.id)
      const personal = await createAssignmentService(teacherId, testId, { userId: secondMemberId })
      assert.equal(personal.audienceType, 'user')
      // Owner/admin: anyone, no enrollment needed.
      const adminPersonal = await createAssignmentService(adminId, testId, { userId: outsiderId })
      assert.equal(adminPersonal.userId, outsiderId)

      assert.deepEqual(await jobKeys(`notify:test.assigned:${groupAssignmentId}:`), [`notify:test.assigned:${groupAssignmentId}:${new Date(assignment.opensAt).toISOString()}`])
      assert.equal((await jobKeys(`notify:test.closing_24h:${groupAssignmentId}:`)).length, 1)
      const fanout = await runNotificationFanoutService({ event: 'test.assigned', assignmentId: groupAssignmentId })
      assert.equal(fanout.created, 2)
      const { rows } = await client.query(
         `SELECT user_id::text, target_path FROM notifications WHERE dedupe_key = $1 ORDER BY user_id`,
         [`test.assigned:${groupAssignmentId}`],
      )
      // The link leads to the assignment itself, not home (2026-11-22).
      const assignmentPath = `/tests/assignments/${groupAssignmentId}`
      assert.deepEqual(rows.map((row) => [row.user_id, row.target_path]).sort(), [[memberId, assignmentPath], [secondMemberId, assignmentPath]].sort())

      // A copy stays standalone and belongs to whoever copied it.
      const copy = await copyTestService(teacherId, testId)
      assert.deepEqual([copy.origin, copy.courseId, copy.status], ['standalone', null, 'draft'])
   })

   await t.test('students see it on the home page and take it without any enrollment', async () => {
      const home = await getStudentHomeService(memberId)
      const item = home.tests.open.find((row) => String(row.id) === groupAssignmentId)
      assert.ok(item)
      assert.deepEqual([item.origin, item.courseId, item.courseTitle], ['standalone', null, null])
      assert.equal((await client.query('SELECT count(*)::integer AS total FROM course_enrollments WHERE user_id = $1', [memberId])).rows[0].total, 0)

      await assert.rejects(startAttemptService(outsiderId, groupAssignmentId, attemptDeps), { code: 'ASSIGNMENT_NOT_FOUND' })
      const view = await startAttemptService(memberId, groupAssignmentId, attemptDeps)
      assert.equal(view.questions.length, 10)
      // Half right: wrong answers here never become trainer mistakes.
      for (const [index, question] of view.questions.entries()) {
         await saveAnswerService(memberId, view.attempt.id, question.id, { answer: { optionKey: index % 2 ? 'A' : 'B' }, revision: 1 }, attemptDeps)
      }
      assert.equal((await getAttemptService(memberId, view.attempt.id, attemptDeps)).questions.length, 10)
      const result = await submitAttemptService(memberId, view.attempt.id, attemptDeps)
      assert.equal(Number(result.attempt.score), 5)

      const catalog = await getTrainerCatalogService(memberId, deps)
      assert.equal(catalog.subjects.find((row) => row.code === subject.code).mistakes, 0)

      const history = await listStudentAttemptsService(memberId, { origin: 'standalone' })
      assert.equal(history.attempts.length, 1)
      assert.deepEqual(
         [history.attempts[0].origin, history.attempts[0].title, history.attempts[0].courseId, String(history.attempts[0].subjectId)],
         ['standalone', 'Group quiz', null, String(subject.id)],
      )
   })

   await t.test('results by can_view_results, extra attempts and regrade events', async () => {
      const seen = await listTestAttemptsService(teacherId, testId, {})
      assert.equal(seen.attempts.length, 1)
      await assert.rejects(listTestAttemptsService(otherTeacherId, testId, {}), { code: 'TEST_NOT_FOUND' })

      // The outsider's personal assignment (made by an admin) is visible through the view-only group.
      const outsiderAssignment = (await client.query(
         'SELECT id::text FROM test_assignments WHERE test_id = $1 AND user_id = $2', [testId, outsiderId],
      )).rows[0].id
      const outsiderView = await startAttemptService(outsiderId, outsiderAssignment, attemptDeps)
      await submitAttemptService(outsiderId, outsiderView.attempt.id, attemptDeps)
      assert.equal((await listTestAttemptsService(teacherId, testId, {})).attempts.length, 2)

      const grant = await grantExtraAttemptsService(teacherId, testId, groupAssignmentId, memberId, {
         count: 1, reason: 'Retake', idempotencyKey: `grant-${suffix}`,
      })
      assert.ok(grant)
      assert.equal((await jobKeys('notify:test.extra_attempts:')).length >= 1, true)

      const attemptId = seen.attempts[0].id
      const items = (await client.query('SELECT id::text FROM attempt_questions WHERE attempt_id = $1 ORDER BY position LIMIT 1', [attemptId])).rows
      await regradeAttemptService(adminId, testId, attemptId, {
         reason: 'Key fix', idempotencyKey: `regrade-${suffix}`, overrides: [{ attemptQuestionId: items[0].id, points: '0' }],
      })
      assert.equal((await jobKeys(`notify:test.result_updated:${attemptId}:`)).length, 1)
   })
})
