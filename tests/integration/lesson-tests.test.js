import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import pg from 'pg'

import env from '../../src/configs/env.js'
import {
   grantCourseEnrollmentService,
   grantModuleAccessService,
} from '../../src/services/course-access-service.js'
import { copyCourseService, deleteCourseModuleService } from '../../src/services/course-module-service.js'
import { getLearnerLessonService } from '../../src/services/learner-lesson-service.js'
import {
   archiveLessonService,
   createLessonService,
   getLessonService,
   publishLessonService,
   restoreLessonService,
   updateLessonService,
} from '../../src/services/lesson-service.js'
import {
   createQuestionBankService,
   createQuestionService,
   publishQuestionService,
   replaceAnswerKeyService,
   verifyAnswerKeyService,
} from '../../src/services/question-bank-service.js'
import { createSubjectService } from '../../src/services/taxonomy-service.js'
import {
   addTestQuestionsService,
   archiveTestService,
   copyTestService,
   createAssignmentService,
   createTestService,
   deleteTestService,
   getTestService,
   publishTestService,
   updateTestService,
} from '../../src/services/test-service.js'

const { Client } = pg
const suffix = randomUUID().slice(0, 8)
const text = (value) => ({ blocks: [{ type: 'text', text: value }] })
const day = 86400000
const iso = (days) => new Date(Date.now() + days * day).toISOString()

test('lesson and test links integration', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   t.after(() => client.end())

   async function createUser(role) {
      const { rows } = await client.query(
         `INSERT INTO users (status, onboarding_completed_at)
          VALUES ('active', CURRENT_TIMESTAMP) RETURNING id`,
      )
      await client.query(
         'INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2',
         [rows[0].id, role],
      )
      return rows[0].id
   }

   const adminId = await createUser('admin')
   const studentId = await createUser('student')
   const subject = await createSubjectService(adminId, {
      code: `link-${suffix}`,
      primaryLanguage: 'en',
      translations: { en: { title: 'Links' } },
   })

   async function createCourse(title) {
      const course = await client.query(
         `INSERT INTO courses (title, subject_id, status, created_by)
          VALUES ($1, $2, 'published', $3) RETURNING id`,
         [title, subject.id, adminId],
      )
      const module = await client.query(
         `INSERT INTO course_modules (course_id, title, position, status)
          VALUES ($1, 'Module', 1, 'published') RETURNING id`,
         [course.rows[0].id],
      )
      return { id: course.rows[0].id, moduleId: module.rows[0].id }
   }

   const course = await createCourse(`Links ${suffix}`)
   const otherCourse = await createCourse(`Other ${suffix}`)
   const bank = await createQuestionBankService(adminId, { code: `link-bank-${suffix}`, title: 'Links', subjectId: subject.id, visibility: 'staff' })
   const question = await createQuestionService(adminId, bank.id, {
      questionType: 'single_choice',
      languageCode: 'en',
      content: text('Secret question text'),
      options: [{ key: 'A', content: text('Right') }, { key: 'B', content: text('Wrong') }],
   })
   await replaceAnswerKeyService(adminId, question.id, { answerData: { optionKey: 'A' }, source: 'expert_review' })
   await verifyAnswerKeyService(adminId, question.id, { source: 'expert_review' })
   await publishQuestionService(adminId, question.id)

   async function draftTest(courseId, title, extra = {}) {
      const created = await createTestService(adminId, { courseId, title, timeLimitMinutes: 20, maxAttempts: 2, ...extra })
      await addTestQuestionsService(adminId, created.id, { questions: [{ questionId: question.id }] })
      return created
   }

   async function publishedTest(courseId, title, extra) {
      const created = await draftTest(courseId, title, extra)
      await publishTestService(adminId, created.id)
      return created
   }

   const lesson = (courseRef, body) => createLessonService(adminId, courseRef.id, courseRef.moduleId, {
      title: `Lesson ${randomUUID().slice(0, 6)}`,
      ...body,
   })

   await t.test('testId is validated on create and patch', async () => {
      const foreign = await publishedTest(otherCourse.id, 'Foreign')
      await assert.rejects(
         lesson(course, { lessonType: 'test', testId: foreign.id }),
         (error) => error.code === 'VALIDATION_ERROR' && error.details[0].field === 'testId',
      )
      const own = await publishedTest(course.id, 'Own')
      await assert.rejects(lesson(course, { lessonType: 'text', testId: own.id }), { code: 'VALIDATION_ERROR' })
      const textLesson = await lesson(course, { lessonType: 'text' })
      await assert.rejects(updateLessonService(adminId, course.id, textLesson.id, { testId: own.id }), { code: 'VALIDATION_ERROR' })

      const archived = await publishedTest(course.id, 'Archived')
      await archiveTestService(adminId, archived.id)
      await assert.rejects(lesson(course, { lessonType: 'test', testId: archived.id }), { code: 'TEST_ARCHIVED' })

      const quiz = await lesson(course, { lessonType: 'test' })
      await assert.rejects(
         updateLessonService(adminId, course.id, quiz.id, { testId: foreign.id }),
         (error) => error.details[0].field === 'testId',
      )
      const linked = await updateLessonService(adminId, course.id, quiz.id, { testId: own.id })
      assert.equal(linked.testId, own.id)
      assert.equal((await getLessonService(adminId, course.id, quiz.id)).testId, own.id)
      await assert.rejects(
         updateLessonService(adminId, course.id, quiz.id, { lessonType: 'text' }),
         { code: 'VALIDATION_ERROR' },
      )
   })

   await t.test('the database refuses a cross-course link and a link on a text lesson', async () => {
      const foreign = await publishedTest(otherCourse.id, 'Foreign database')
      const quiz = await lesson(course, { lessonType: 'test' })
      await assert.rejects(client.query('UPDATE lessons SET test_id = $1 WHERE id = $2', [foreign.id, quiz.id]), { code: '23503' })
      const own = await publishedTest(course.id, 'Own database')
      const textLesson = await lesson(course, { lessonType: 'text' })
      await assert.rejects(client.query('UPDATE lessons SET test_id = $1 WHERE id = $2', [own.id, textLesson.id]), { code: '23514' })
   })

   await t.test('publication needs a published test, and test publication is not blocked', async () => {
      const empty = await lesson(course, { lessonType: 'test' })
      await assert.rejects(publishLessonService(adminId, course.id, empty.id), { code: 'LESSON_TEST_REQUIRED' })

      const draft = await draftTest(course.id, 'Draft for lesson')
      const quiz = await lesson(course, { lessonType: 'test', testId: draft.id })
      await assert.rejects(publishLessonService(adminId, course.id, quiz.id), { code: 'TEST_NOT_PUBLISHED' })
      const mixed = await lesson(course, { lessonType: 'mixed', testId: draft.id })
      await assert.rejects(publishLessonService(adminId, course.id, mixed.id), { code: 'TEST_NOT_PUBLISHED' })

      assert.equal((await publishTestService(adminId, draft.id)).status, 'published')
      assert.equal((await publishLessonService(adminId, course.id, quiz.id)).status, 'published')
      assert.equal((await publishLessonService(adminId, course.id, mixed.id)).status, 'published')

      const plainMixed = await lesson(course, { lessonType: 'mixed' })
      assert.equal((await publishLessonService(adminId, course.id, plainMixed.id)).status, 'published')
   })

   await t.test('a published lesson stays publishable', async () => {
      const published = await publishedTest(course.id, 'Keep')
      const quiz = await lesson(course, { lessonType: 'test', testId: published.id })
      await publishLessonService(adminId, course.id, quiz.id)
      await assert.rejects(updateLessonService(adminId, course.id, quiz.id, { testId: null }), { code: 'LESSON_TEST_REQUIRED' })
      const draft = await draftTest(course.id, 'Not ready')
      await assert.rejects(updateLessonService(adminId, course.id, quiz.id, { testId: draft.id }), { code: 'TEST_NOT_PUBLISHED' })
      const other = await publishedTest(course.id, 'Swap')
      assert.equal((await updateLessonService(adminId, course.id, quiz.id, { testId: other.id })).testId, other.id)

      const textLesson = await lesson(course, { lessonType: 'text' })
      await publishLessonService(adminId, course.id, textLesson.id)
      await assert.rejects(updateLessonService(adminId, course.id, textLesson.id, { lessonType: 'test' }), { code: 'LESSON_TEST_REQUIRED' })
      const converted = await updateLessonService(adminId, course.id, textLesson.id, { lessonType: 'test', testId: other.id })
      assert.equal(converted.lessonType, 'test')
   })

   await t.test('archive and delete of a linked test return a clear conflict; copy changes nothing', async () => {
      const linked = await publishedTest(course.id, 'Linked')
      const quiz = await lesson(course, { lessonType: 'test', testId: linked.id })
      await publishLessonService(adminId, course.id, quiz.id)
      await assert.rejects(archiveTestService(adminId, linked.id), (error) => {
         assert.equal(error.code, 'TEST_LINKED_TO_LESSON')
         assert.equal(error.details[0].message, quiz.id)
         return true
      })
      const copy = await copyTestService(adminId, linked.id)
      assert.equal(copy.status, 'draft')
      assert.equal((await getLessonService(adminId, course.id, quiz.id)).testId, linked.id)

      await archiveLessonService(adminId, course.id, quiz.id)
      assert.equal((await archiveTestService(adminId, linked.id)).status, 'archived')
      await restoreLessonService(adminId, course.id, quiz.id)
      await assert.rejects(publishLessonService(adminId, course.id, quiz.id), { code: 'TEST_NOT_PUBLISHED' })

      const draft = await draftTest(course.id, 'Draft linked')
      await lesson(course, { lessonType: 'test', testId: draft.id })
      await assert.rejects(deleteTestService(adminId, draft.id), { code: 'TEST_LINKED_TO_LESSON' })
   })

   await t.test('tests.module_id belongs to the test course and survives a copy', async () => {
      const created = await draftTest(course.id, 'In module', { moduleId: course.moduleId })
      assert.equal(created.moduleId, course.moduleId)
      await assert.rejects(
         createTestService(adminId, { courseId: course.id, title: 'Wrong', moduleId: otherCourse.moduleId }),
         (error) => error.details[0].field === 'moduleId',
      )
      await assert.rejects(updateTestService(adminId, created.id, { moduleId: otherCourse.moduleId }), { code: 'VALIDATION_ERROR' })
      assert.equal((await updateTestService(adminId, created.id, { moduleId: null })).moduleId, null)
      assert.equal((await updateTestService(adminId, created.id, { moduleId: course.moduleId })).moduleId, course.moduleId)
      assert.equal((await copyTestService(adminId, created.id)).moduleId, course.moduleId)

      const draftModule = await client.query(
         `INSERT INTO course_modules (course_id, title, position) VALUES ($1, 'Empty', 50) RETURNING id`,
         [course.id],
      )
      await updateTestService(adminId, created.id, { moduleId: draftModule.rows[0].id })
      await assert.rejects(deleteCourseModuleService(adminId, course.id, draftModule.rows[0].id), { code: 'COURSE_MODULE_NOT_DELETABLE' })
   })

   await t.test('a course copy clears test links and reports them', async () => {
      const source = await createCourse(`Copy source ${suffix}`)
      const linked = await publishedTest(source.id, 'Source test')
      const quiz = await lesson(source, { lessonType: 'test', testId: linked.id })
      await lesson(source, { lessonType: 'text' })
      const { copied, course: target } = await copyCourseService(adminId, source.id, {})
      assert.equal(copied.lessons, 2)
      assert.equal(copied.clearedTestLinks, 1)
      const rows = await client.query('SELECT test_id, status FROM lessons WHERE course_id = $1', [target.id])
      assert.ok(rows.rows.every((row) => row.test_id === null && row.status === 'draft'))
      assert.equal((await getLessonService(adminId, source.id, quiz.id)).testId, linked.id)
   })

   await t.test('the learner gets a safe summary with the assignment window state', async () => {
      const source = await createCourse(`Learner ${suffix}`)
      await grantCourseEnrollmentService(adminId, source.id, { userId: studentId, expiresAt: null })
      await grantModuleAccessService(adminId, source.id, studentId, { moduleId: source.moduleId, expiresAt: null })
      const linked = await publishedTest(source.id, 'Learner test')
      const quiz = await lesson(source, { lessonType: 'test', testId: linked.id })
      await publishLessonService(adminId, source.id, quiz.id)

      const none = (await getLearnerLessonService(studentId, source.id, quiz.id)).lesson.test
      assert.deepEqual(none, {
         id: linked.id,
         title: 'Learner test',
         questionCount: 1,
         timeLimitMinutes: 20,
         maxAttempts: 2,
         assignment: { id: null, state: 'none', opensAt: null, closesAt: null },
         attempts: {
            status: 'not_started',
            attemptId: null,
            deadlineAt: null,
            score: null,
            maxScore: null,
            submittedAt: null,
            remainingAttempts: 2,
         },
      })

      const assignment = await createAssignmentService(adminId, linked.id, { userId: studentId, opensAt: iso(2), closesAt: iso(3) })
      const result = await getLearnerLessonService(studentId, source.id, quiz.id)
      assert.equal(result.lesson.test.assignment.state, 'upcoming')
      const serialized = JSON.stringify(result)
      assert.ok(!serialized.includes('Secret question text'))
      assert.ok(!serialized.includes('answer'))
      await client.query(
         `UPDATE test_assignments SET opens_at = CURRENT_TIMESTAMP - interval '2 days', closes_at = CURRENT_TIMESTAMP + interval '1 day' WHERE id = $1`,
         [assignment.id],
      )
      assert.equal((await getLearnerLessonService(studentId, source.id, quiz.id)).lesson.test.assignment.state, 'open')
      await client.query(
         `UPDATE test_assignments SET closes_at = CURRENT_TIMESTAMP - interval '1 day' WHERE id = $1`,
         [assignment.id],
      )
      assert.equal((await getLearnerLessonService(studentId, source.id, quiz.id)).lesson.test.assignment.state, 'closed')

      // No module grant: only the locked summary, no test facts.
      const outsider = await createUser('student')
      await grantCourseEnrollmentService(adminId, source.id, { userId: outsider, expiresAt: null })
      assert.equal((await getLearnerLessonService(outsider, source.id, quiz.id)).lesson.test, undefined)
   })

   await t.test('a test detail still lists its questions only for staff', async () => {
      const linked = await publishedTest(course.id, 'Staff detail')
      assert.equal((await getTestService(adminId, linked.id)).questions.length, 1)
      await assert.rejects(getTestService(studentId, linked.id), { code: 'TEST_NOT_FOUND' })
   })
})
