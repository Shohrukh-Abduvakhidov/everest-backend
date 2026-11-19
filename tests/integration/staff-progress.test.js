import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import pg from 'pg'

import { createApp } from '../../src/app.js'
import env from '../../src/configs/env.js'
import { withTransaction } from '../../src/repositories/transaction-repository.js'
import { grantCourseEnrollmentService } from '../../src/services/course-access-service.js'
import { addCourseTeacherService } from '../../src/services/course-service.js'
import {
   addGroupMemberService,
   addGroupTeacherService,
   createGroupService,
} from '../../src/services/group-service.js'
import { createLessonService, publishLessonService } from '../../src/services/lesson-service.js'
import {
   createQuestionBankService,
   createQuestionService,
   publishQuestionService,
   replaceAnswerKeyService,
   verifyAnswerKeyService,
} from '../../src/services/question-bank-service.js'
import {
   getAssignmentResultsService,
   getCourseProgressService,
   getGroupProgressService,
   getStaffStudentAnalyticsService,
   listStaffStudentAttemptsService,
} from '../../src/services/staff-progress-service.js'
import { createSubjectService } from '../../src/services/taxonomy-service.js'
import {
   addTestQuestionsService,
   createAssignmentService,
   createTestService,
   publishTestService,
} from '../../src/services/test-service.js'
import { createSessionTestService, createTelegramAuthTestService } from '../helpers/service-factories.js'

const { Client } = pg
const suffix = randomUUID().slice(0, 8)
const text = (value) => ({ blocks: [{ type: 'text', text: value }] })
const day = 86400000

test('staff progress: group, course, student and assignment views with D1 scope', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   t.after(() => client.end())
   // A little ahead of the database clock, so enrollments granted below have begun.
   const now = new Date(Date.now() + 5 * 60000)
   const clock = () => now
   const deps = { clock, readinessWindow: 5 }

   async function createUser(role, firstName = null) {
      const { rows } = await client.query(
         `INSERT INTO users (status, onboarding_completed_at) VALUES ('active', CURRENT_TIMESTAMP) RETURNING id`,
      )
      await client.query(
         'INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2',
         [rows[0].id, role],
      )
      if (firstName) {
         await client.query('INSERT INTO user_profiles (user_id, first_name, last_name) VALUES ($1, $2, $3)', [
            rows[0].id, firstName, suffix,
         ])
      }
      return rows[0].id
   }

   const adminId = await createUser('admin')
   const subject = await createSubjectService(adminId, {
      code: `sp-${suffix}`, primaryLanguage: 'en', translations: { en: { title: 'Staff progress' } },
   })

   async function course(title, modules) {
      const courseId = (await client.query(
         `INSERT INTO courses (title, subject_id, status, created_by) VALUES ($1, $2, 'published', $3) RETURNING id`,
         [`${title} ${suffix}`, subject.id, adminId],
      )).rows[0].id
      const lessons = []
      for (const [position, count] of modules.entries()) {
         const moduleId = (await client.query(
            `INSERT INTO course_modules (course_id, title, position, status) VALUES ($1, $2, $3, 'published') RETURNING id`,
            [courseId, `M${position + 1}`, position + 1],
         )).rows[0].id
         for (let index = 0; index < count; index += 1) {
            const lesson = await createLessonService(adminId, courseId, moduleId, {
               title: `L${position + 1}.${index + 1}`, lessonType: 'text',
            })
            await publishLessonService(adminId, courseId, lesson.id)
            lessons.push(lesson.id)
         }
         // A draft lesson never counts.
         await createLessonService(adminId, courseId, moduleId, { title: `Draft ${position}`, lessonType: 'text' })
      }
      return { courseId, lessons }
   }

   const courseA = await course('Course A', [2, 1])
   const courseB = await course('Course B', [1])

   // s1..s6 are enrolled in A, s7 is in the group without any course; s1 is also in B.
   const students = []
   for (let index = 1; index <= 7; index += 1) students.push(await createUser('student', `S${index}`))
   const [s1, s2, s3, s4, s5, s6, s7] = students
   for (const id of students.slice(0, 6)) {
      await grantCourseEnrollmentService(adminId, courseA.courseId, { userId: id, expiresAt: null })
   }
   await grantCourseEnrollmentService(adminId, courseB.courseId, { userId: s1, expiresAt: null })

   const group = await createGroupService(adminId, { name: `Group ${suffix}` })
   const emptyGroup = await createGroupService(adminId, { name: `Empty ${suffix}` })
   for (const id of students) await addGroupMemberService(adminId, group.id, { userId: id })
   await client.query('UPDATE group_members SET joined_at = $2 WHERE group_id = $1', [group.id, new Date(Date.now() - 5 * day)])

   const groupTeacher = await createUser('teacher', 'GroupTeacher')
   const blindTeacher = await createUser('teacher', 'BlindTeacher')
   const otherTeacher = await createUser('teacher', 'OtherTeacher')
   const courseTeacher = await createUser('teacher', 'CourseTeacher')
   await addGroupTeacherService(adminId, group.id, { userId: groupTeacher, canViewResults: true })
   await addGroupTeacherService(adminId, group.id, { userId: blindTeacher, canViewResults: false })
   await addGroupTeacherService(adminId, emptyGroup.id, { userId: otherTeacher, canViewResults: true })
   await addCourseTeacherService(adminId, courseB.courseId, { userId: courseTeacher, canViewResults: true })

   // Lesson progress in A (3 lessons): s1-s4 all done, s5 one, s6 two; s1 active now, the rest 10 days ago.
   async function progress(userId, lessonIds, status, updatedAt) {
      for (const lessonId of lessonIds) {
         await client.query(
            `INSERT INTO lesson_progress (user_id, lesson_id, status, completed_at, updated_at)
             VALUES ($1, $2, $3::varchar, CASE WHEN $3::varchar = 'completed' THEN $4::timestamptz END, $4)`,
            [userId, lessonId, status, updatedAt],
         )
      }
   }
   const old = new Date(now.getTime() - 10 * day)
   await progress(s1, courseA.lessons, 'completed', now)
   for (const id of [s2, s3, s4]) await progress(id, courseA.lessons, 'completed', old)
   await progress(s5, courseA.lessons.slice(0, 1), 'completed', old)
   await progress(s5, courseA.lessons.slice(1, 2), 'in_progress', old)
   await progress(s6, courseA.lessons.slice(0, 2), 'completed', old)

   // One authored test in A (pass 60 %, best result) assigned to the group; the window closed yesterday.
   const bank = await createQuestionBankService(adminId, {
      code: `sp-bank-${suffix}`, title: 'Staff progress', subjectId: subject.id, visibility: 'staff',
   })
   const question = await createQuestionService(adminId, bank.id, {
      questionType: 'single_choice', languageCode: 'en', content: text('Pick A'),
      options: [{ key: 'A', content: text('Right') }, { key: 'B', content: text('Wrong') }],
   })
   await replaceAnswerKeyService(adminId, question.id, { answerData: { optionKey: 'A' }, source: 'expert_review' })
   await verifyAnswerKeyService(adminId, question.id, { source: 'expert_review' })
   await publishQuestionService(adminId, question.id)
   const quiz = await createTestService(adminId, {
      courseId: courseA.courseId, title: `Quiz ${suffix}`, mode: 'practice', maxAttempts: 3,
      passPercent: 60, resultPolicy: 'best',
   })
   await addTestQuestionsService(adminId, quiz.id, { questions: [{ questionId: question.id, points: '10' }] })
   await publishTestService(adminId, quiz.id)
   const assignment = await createAssignmentService(adminId, quiz.id, { groupId: group.id })
   await client.query(
      'UPDATE test_assignments SET opens_at = $2, closes_at = $3 WHERE id = $1',
      [assignment.id, new Date(now.getTime() - 3 * day), new Date(now.getTime() - day)],
   )
   async function attempt(userId, number, status, score) {
      await client.query(
         `INSERT INTO test_attempts (test_id, assignment_id, user_id, attempt_number, status, started_at,
            submitted_at, graded_at, score, max_score, policy_snapshot)
          VALUES ($1, $2, $3, $4, $5::varchar, $6, CASE WHEN $5::varchar = 'graded' THEN $6::timestamptz END,
            CASE WHEN $5::varchar = 'graded' THEN $6::timestamptz END, $7, 10, '{"passPercent": 60}'::jsonb)`,
         [quiz.id, assignment.id, userId, number, status, new Date(now.getTime() - 2 * day + number * 1000), score],
      )
   }
   await attempt(s1, 1, 'graded', 4)
   await attempt(s1, 2, 'graded', 8)
   await attempt(s2, 1, 'graded', 5)
   await attempt(s3, 1, 'in_progress', null)

   // s1 trainings: subject X 3/4 and 1/4 (50 %), subject Y 4/4 (100 %) → readiness 75.
   async function training(userId, subjectId, score) {
      const generated = await client.query(
         `INSERT INTO tests (title, mode, status, origin, created_by, generation_filters)
          VALUES ('Generated', 'practice', 'draft', 'trainer', $1, $2::jsonb) RETURNING id`,
         [userId, JSON.stringify({ subjectId, subjectCode: 'x' })],
      )
      const own = await client.query(
         'INSERT INTO test_assignments (test_id, user_id, assigned_by) VALUES ($1, $2, $2) RETURNING id',
         [generated.rows[0].id, userId],
      )
      await client.query(
         `INSERT INTO test_attempts (test_id, assignment_id, user_id, attempt_number, status, submitted_at,
            graded_at, score, max_score, policy_snapshot)
          VALUES ($1, $2, $3, 1, 'graded', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $4, 4, '{}'::jsonb)`,
         [generated.rows[0].id, own.rows[0].id, userId, score],
      )
   }
   const otherSubject = await createSubjectService(adminId, {
      code: `sp2-${suffix}`, primaryLanguage: 'en', translations: { en: { title: 'Other' } },
   })
   await training(s1, subject.id, 3)
   await training(s1, subject.id, 1)
   await training(s1, otherSubject.id, 4)

   const byUser = (rows) => new Map(rows.map((row) => [row.userId, row]))

   await t.test('group summary: rows, readiness, progress, results, missed deadlines and D5 reasons', async () => {
      const summary = await getGroupProgressService(adminId, group.id, { limit: '100' }, deps)
      assert.equal(summary.group.id, group.id)
      assert.equal(summary.totals.students, 7)
      assert.equal(summary.pagination.total, 7)
      const rows = byUser(summary.students)
      const first = rows.get(s1)
      assert.equal(first.name, `S1 ${suffix}`)
      assert.deepEqual(first.readiness, { readinessPercent: 75, completedTrainings: 3 })
      const firstA = first.courses.find((entry) => entry.courseId === courseA.courseId)
      assert.deepEqual(
         [firstA.totalLessons, firstA.completedLessons, firstA.startedLessons, firstA.notStartedLessons, firstA.percent],
         [3, 3, 0, 0, 100],
      )
      assert.equal(first.courses.length, 2, 's1 is also in course B')
      assert.equal(first.lastActivityAt !== null && new Date(first.lastActivityAt) >= new Date(now.getTime() - 60000), true)
      assert.deepEqual(first.recentResults.map((row) => [row.percent, row.passed]), [[80, true], [40, false]])
      assert.equal(first.missedAssignments.count, 0)
      assert.deepEqual(first.behind, { isBehind: false, reasons: [] })

      // s2: failed the latest attempt of the only threshold test; its start two days ago is activity.
      assert.deepEqual(rows.get(s2).behind.reasons, ['below_pass'])
      // s3: running attempt only → the closed assignment is missed.
      assert.deepEqual(rows.get(s3).behind.reasons, ['missed_deadline'])
      assert.deepEqual(rows.get(s4).behind.reasons, ['no_activity_7d', 'missed_deadline'])
      assert.equal(rows.get(s3).missedAssignments.count, 1)
      assert.equal(rows.get(s3).missedAssignments.latest[0].assignmentId, assignment.id)
      // Median of [33, 66, 100, 100, 100, 100] is 100: 33 and 66 are at least 25 points under it.
      const fifth = rows.get(s5)
      assert.deepEqual(fifth.courses[0].percent, 33)
      assert.equal(fifth.courses[0].startedLessons, 1)
      assert.equal(fifth.courses[0].lagging, true)
      assert.deepEqual(fifth.behind.reasons, ['no_activity_7d', 'missed_deadline', 'progress_lag'])
      assert.equal(rows.get(s6).courses[0].lagging, true)
      assert.equal(rows.get(s4).courses[0].lagging, false)
      // s7: no course, no activity, not enrolled in A → the group assignment is not "missed".
      const seventh = rows.get(s7)
      assert.deepEqual(seventh.courses, [])
      assert.equal(seventh.lastActivityAt, null)
      assert.equal(seventh.progressPercent, null)
      assert.deepEqual(seventh.readiness, { readinessPercent: null, completedTrainings: 0 })
      assert.deepEqual(seventh.recentResults, [])
      assert.deepEqual(seventh.behind.reasons, ['no_activity_7d'])

      const overviewA = summary.courses.find((entry) => entry.courseId === courseA.courseId)
      assert.deepEqual([overviewA.students, overviewA.activeStudents], [6, 6])
      assert.equal(overviewA.averagePercent, 83.17)
      assert.equal(summary.totals.behind, 6)
      assert.equal(summary.totals.averageReadinessPercent, 75)
   })

   await t.test('group summary: sorting, paging and the behind filter', async () => {
      const sorted = await getGroupProgressService(adminId, group.id, { sort: 'progress', limit: '2' }, deps)
      assert.equal(sorted.pagination.total, 7)
      assert.equal(sorted.pagination.hasMore, true)
      assert.deepEqual(sorted.students.map((row) => row.progressPercent), [100, 100])
      const last = await getGroupProgressService(adminId, group.id, { sort: 'progress', limit: '2', offset: '6' }, deps)
      assert.equal(last.students[0].userId, s7, 'null progress sorts last')
      const behind = await getGroupProgressService(adminId, group.id, { behind: 'false' }, deps)
      assert.deepEqual(behind.students.map((row) => row.userId), [s1])
      for (const query of [{ sort: 'phone' }, { order: 'up' }, { behind: 'yes' }, { limit: '0' }]) {
         await assert.rejects(getGroupProgressService(adminId, group.id, query, deps), { code: 'VALIDATION_ERROR' })
      }
   })

   await t.test('group scope: teacher with the flag, without it, of another group; empty group', async () => {
      assert.equal((await getGroupProgressService(groupTeacher, group.id, {}, deps)).totals.students, 7)
      await assert.rejects(getGroupProgressService(blindTeacher, group.id, {}, deps), { code: 'GROUP_NOT_FOUND' })
      await assert.rejects(getGroupProgressService(otherTeacher, group.id, {}, deps), { code: 'GROUP_NOT_FOUND' })
      await assert.rejects(getGroupProgressService(courseTeacher, group.id, {}, deps), { code: 'GROUP_NOT_FOUND' })
      await assert.rejects(getGroupProgressService(adminId, '999999999', {}, deps), { code: 'GROUP_NOT_FOUND' })
      await assert.rejects(getGroupProgressService(adminId, 'x', {}, deps), { code: 'INVALID_GROUP_ID' })
      const empty = await getGroupProgressService(otherTeacher, emptyGroup.id, {}, deps)
      assert.deepEqual(empty.students, [])
      assert.deepEqual(empty.courses, [])
      assert.deepEqual(empty.totals, {
         students: 0, behind: 0, withoutActivity7d: 0, averageReadinessPercent: null, averageProgressPercent: null,
      })
   })

   await t.test('course summary: modules, lessons, averages and who is behind', async () => {
      const summary = await getCourseProgressService(adminId, courseA.courseId, { limit: '100' }, deps)
      assert.equal(summary.totals.students, 6)
      assert.equal(summary.totals.lessons, 3)
      assert.equal(summary.totals.completedCourse, 4)
      assert.equal(summary.totals.averagePercent, 83.17)
      assert.deepEqual(summary.modules.map((module) => [module.position, module.lessonCount]), [[1, 2], [2, 1]])
      const [first, second] = summary.modules[0].lessons
      assert.deepEqual([first.completed, first.started, first.notStarted, first.completedPercent], [6, 0, 0, 100])
      assert.deepEqual([second.completed, second.started, second.notStarted], [5, 1, 0])
      assert.deepEqual([summary.modules[1].lessons[0].completed, summary.modules[1].lessons[0].notStarted], [4, 2])
      const rows = byUser(summary.students)
      assert.equal(rows.has(s7), false)
      const fifth = rows.get(s5)
      assert.deepEqual(fifth.progress, {
         totalLessons: 3, completedLessons: 1, startedLessons: 1, notStartedLessons: 1, percent: 33, lagging: true,
      })
      assert.deepEqual(fifth.modules.map((module) => [module.completedLessons, module.startedLessons, module.percent]), [
         [1, 1, 50], [0, 0, 0],
      ])
      assert.equal('readiness' in fifth, false, 'the course view has no trainer readiness')
      assert.equal(summary.totals.behind, 5)
      const sorted = await getCourseProgressService(adminId, courseA.courseId, { sort: 'progress', order: 'asc' }, deps)
      assert.deepEqual(sorted.students.slice(0, 2).map((row) => row.userId), [s5, s6])
   })

   await t.test('course scope: course teacher only for their course', async () => {
      const own = await getCourseProgressService(courseTeacher, courseB.courseId, {}, deps)
      assert.deepEqual(own.students.map((row) => row.userId), [s1])
      assert.equal(own.students[0].progress.percent, 0)
      for (const actor of [courseTeacher, groupTeacher, s1]) {
         await assert.rejects(getCourseProgressService(actor, courseA.courseId, {}, deps), { code: 'COURSE_NOT_FOUND' })
      }
   })

   await t.test('student analytics: full scope, course scope and no scope', async () => {
      const full = await getStaffStudentAnalyticsService(groupTeacher, s1, deps)
      assert.equal(full.scope.kind, 'full')
      assert.equal(full.student.name, `S1 ${suffix}`)
      assert.equal(full.home.readiness.readinessPercent, 75)
      assert.equal(full.home.courses.length, 2)
      assert.ok(full.home.week)
      assert.equal(full.analytics.totals.lessonsCompleted, 3)
      assert.equal(full.analytics.totals.attemptsFinished, 5)
      assert.equal(full.attempts.pagination.total, 5)
      assert.equal((await listStaffStudentAttemptsService(groupTeacher, s1, { origin: 'trainer' }, deps)).pagination.total, 3)

      const limited = await getStaffStudentAnalyticsService(courseTeacher, s1, deps)
      assert.deepEqual(limited.scope, { kind: 'courses', courseIds: [courseB.courseId] })
      assert.deepEqual(limited.home.courses.map((entry) => entry.id), [courseB.courseId])
      assert.equal(limited.home.readiness, null)
      assert.equal(limited.home.week, null)
      assert.equal(limited.analytics, null)
      assert.deepEqual(limited.home.recentResults, [])
      assert.equal(limited.attempts.pagination.total, 0, 'no trainer or course A attempts leak')
      assert.equal((await listStaffStudentAttemptsService(courseTeacher, s1, { origin: 'trainer' }, deps)).pagination.total, 0)

      // A student without any activity.
      const quiet = await getStaffStudentAnalyticsService(adminId, s7, deps)
      assert.equal(quiet.scope.kind, 'full')
      assert.deepEqual(quiet.home.courses, [])
      assert.equal(quiet.analytics.totals.attemptsFinished, 0)
      assert.deepEqual(quiet.attempts.attempts, [])

      for (const [actor, studentId] of [[blindTeacher, s1], [otherTeacher, s1], [courseTeacher, s2], [s2, s1], [adminId, '999999999']]) {
         await assert.rejects(getStaffStudentAnalyticsService(actor, studentId, deps), { code: 'USER_NOT_FOUND' })
         await assert.rejects(listStaffStudentAttemptsService(actor, studentId, {}, deps), { code: 'USER_NOT_FOUND' })
      }
   })

   await t.test('assignment results: who passed, attempts and averages', async () => {
      const results = await getAssignmentResultsService(groupTeacher, quiz.id, assignment.id, { limit: '100' }, deps)
      assert.deepEqual(results.test, {
         id: quiz.id, title: `Quiz ${suffix}`, maxAttempts: 3, resultPolicy: 'best', passPercent: 60,
      })
      assert.deepEqual(results.assignment.audience, { type: 'group', id: group.id })
      assert.deepEqual(results.totals, {
         students: 7, notStarted: 4, inProgress: 1, finished: 2, passed: 1, failed: 1,
         attempts: 4, averagePercent: 65, averageScore: 6.5,
      })
      const rows = byUser(results.students)
      assert.equal(rows.get(s1).status, 'passed')
      assert.equal(rows.get(s1).attemptsUsed, 2)
      assert.equal(rows.get(s1).result.attemptNumber, 2, 'best result policy')
      assert.equal(rows.get(s1).bestPercent, 80)
      assert.equal(rows.get(s2).status, 'failed')
      assert.equal(rows.get(s3).status, 'in_progress')
      assert.equal(rows.get(s3).result, null)
      assert.equal(rows.get(s7).status, 'not_started')
      const passed = await getAssignmentResultsService(adminId, quiz.id, assignment.id, { status: 'passed' }, deps)
      assert.deepEqual(passed.students.map((row) => row.userId), [s1])
      const byPercent = await getAssignmentResultsService(adminId, quiz.id, assignment.id, { sort: 'percent' }, deps)
      assert.deepEqual(byPercent.students.slice(0, 2).map((row) => row.userId), [s1, s2])
      for (const actor of [blindTeacher, otherTeacher, courseTeacher, s1]) {
         await assert.rejects(
            getAssignmentResultsService(actor, quiz.id, assignment.id, {}, deps),
            { code: 'ASSIGNMENT_NOT_FOUND' },
         )
      }
      await assert.rejects(getAssignmentResultsService(adminId, quiz.id, assignment.id, { status: 'x' }, deps), {
         code: 'VALIDATION_ERROR',
      })
   })

   await t.test('HTTP: permission, scope without disclosure and safe fields', async () => {
      const config = { ...env, jwtAccessSecret: 'staff-progress-integration-secret-longer-than-32-characters' }
      const sessions = createSessionTestService({ config })
      const app = createApp({
         telegramAuth: createTelegramAuthTestService({ config }).dependencies,
         authProtection: { config },
      })
      const server = await new Promise((resolve) => {
         const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
      })
      t.after(() => new Promise((resolve) => server.close(resolve)))
      const token = async (userId) => (await withTransaction((transactionClient) => sessions.issueSession({
         userId, requestContext: { userAgent: 'test', ipAddress: '127.0.0.1' }, client: transactionClient,
      }))).accessToken
      const get = async (userId, path) => {
         const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/admin${path}`, {
            headers: { authorization: `Bearer ${await token(userId)}` },
         })
         return { status: response.status, body: await response.json() }
      }
      const student = await get(s1, `/groups/${group.id}/progress`)
      assert.equal(student.status, 403)
      const foreign = await get(otherTeacher, `/groups/${group.id}/progress`)
      assert.equal(foreign.status, 404)
      assert.equal(foreign.body.error.code, 'GROUP_NOT_FOUND')
      const missing = await get(otherTeacher, '/groups/999999999/progress')
      assert.deepEqual(missing.body, foreign.body, 'a foreign group looks like a missing one')
      const own = await get(groupTeacher, `/groups/${group.id}/progress`)
      assert.equal(own.status, 200)
      const serialized = JSON.stringify(own.body)
      for (const field of ['phone', 'password', 'token', 'telegram', 'answer']) assert.equal(serialized.includes(field), false)
      assert.equal((await get(adminId, `/courses/${courseA.courseId}/progress`)).status, 200)
      assert.equal((await get(groupTeacher, `/users/${s1}/analytics`)).status, 200)
      assert.equal((await get(groupTeacher, `/users/${s1}/attempts?origin=trainer`)).body.data.pagination.total, 3)
      assert.equal((await get(groupTeacher, `/tests/${quiz.id}/assignments/${assignment.id}/results`)).status, 200)
      assert.equal((await get(blindTeacher, `/users/${s1}/analytics`)).status, 404)
   })
})
