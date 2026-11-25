import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import pg from 'pg'

import env from '../../src/configs/env.js'
import {
   addGroupMemberService,
   addGroupTeacherService,
   createGroupService,
   getGroupService,
   listGroupMembersService,
   listGroupsService,
   listGroupTeachersService,
} from '../../src/services/group-service.js'
import {
   getGroupRankingService,
   getRankingSettingsService,
   getStaffGroupRankingService,
   updateRankingSettingsService,
} from '../../src/services/group-ranking-service.js'
import { createLessonService } from '../../src/services/lesson-service.js'
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
   createAssignmentService,
   createTestService,
   publishTestService,
   updateAssignmentService,
} from '../../src/services/test-service.js'

const { Client } = pg
const suffix = randomUUID().slice(0, 8)
const text = (value) => ({ blocks: [{ type: 'text', text: value }] })
const at = (value) => new Date(value)

// A fixed Wednesday: the week is Mon 23 Nov 00:00 to Mon 30 Nov 00:00 in Asia/Dushanbe
// (2026-11-22T19:00Z to 2026-11-29T19:00Z).
const now = at('2026-11-25T10:00:00Z')
const deps = { clock: () => now }

test('M13 group ranking: assignments flag, both boards, periods, places, visibility and scope', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   t.after(() => client.end())

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
            rows[0].id, firstName, `R${suffix}`,
         ])
      }
      return rows[0].id
   }

   const adminId = await createUser('admin')
   const students = []
   for (let index = 1; index <= 6; index += 1) students.push(await createUser('student', `S${index}`))
   const [s1, s2, s3, s4, s5, s6] = students
   const outsider = await createUser('student', 'Outsider')
   const viewer = await createUser('teacher', 'Viewer')
   const blind = await createUser('teacher', 'Blind')
   const assigner = await createUser('teacher', 'Assigner')

   const group = await createGroupService(adminId, { name: `Ranking ${suffix}` })
   for (const id of students) await addGroupMemberService(adminId, group.id, { userId: id })
   await client.query('UPDATE group_members SET joined_at = $2 WHERE group_id = $1', [group.id, at('2026-11-01T00:00:00Z')])
   // s6 joined after the first assignment closed.
   await client.query('UPDATE group_members SET joined_at = $3 WHERE group_id = $1 AND user_id = $2', [
      group.id, s6, at('2026-11-25T05:00:00Z'),
   ])
   await addGroupTeacherService(adminId, group.id, { userId: viewer, canViewResults: true })
   await addGroupTeacherService(adminId, group.id, { userId: blind, canViewResults: false })
   await addGroupTeacherService(adminId, group.id, { userId: assigner, canAssignTests: true })

   const subject = await createSubjectService(adminId, {
      code: `rk-${suffix}`, primaryLanguage: 'en', translations: { en: { title: 'Ranking' } },
   })
   const bank = await createQuestionBankService(adminId, {
      code: `rk-bank-${suffix}`, title: 'Ranking', subjectId: subject.id, visibility: 'staff',
   })
   async function question(difficulty) {
      const created = await createQuestionService(adminId, bank.id, {
         questionType: 'single_choice', languageCode: 'en', content: text(`Pick A ${difficulty}`),
         options: [{ key: 'A', content: text('Right') }, { key: 'B', content: text('Wrong') }],
         difficulty, difficultySource: 'expert',
      })
      await replaceAnswerKeyService(adminId, created.id, { answerData: { optionKey: 'A' }, source: 'expert_review' })
      await verifyAnswerKeyService(adminId, created.id, { source: 'expert_review' })
      await publishQuestionService(adminId, created.id)
      return created.id
   }
   const qEasy = await question(1)
   const qMid = await question(3)
   const qHard = await question(5)

   // Standalone quizzes (no enrollment needed), best result, 10 points.
   async function quiz(actorId, title) {
      const created = await createTestService(actorId, {
         courseId: null, title: `${title} ${suffix}`, mode: 'practice', maxAttempts: 3, resultPolicy: 'best',
      })
      // A teacher may not pick from this staff bank; the question is attached directly.
      if (actorId === adminId) {
         await addTestQuestionsService(actorId, created.id, { questions: [{ questionId: qEasy, points: '10' }] })
      } else {
         await client.query(
            'INSERT INTO test_questions (test_id, question_id, position, points) VALUES ($1, $2, 1, 10)',
            [created.id, qEasy],
         )
      }
      await publishTestService(actorId, created.id)
      return created.id
   }
   async function assign(testId, closesAt, counts = true) {
      const assignment = await createAssignmentService(adminId, testId, { groupId: group.id, countsForGroupRanking: counts })
      await client.query('UPDATE test_assignments SET opens_at = $2, closes_at = $3 WHERE id = $1', [
         assignment.id, at('2026-11-01T00:00:00Z'), closesAt,
      ])
      return { ...assignment, testId }
   }
   async function attempt(assignment, userId, number, score, finishedAt) {
      await client.query(
         `INSERT INTO test_attempts (test_id, assignment_id, user_id, attempt_number, status, started_at,
            submitted_at, graded_at, score, max_score, policy_snapshot)
          VALUES ($1, $2, $3, $4, 'graded', $5::timestamptz - interval '10 minutes', $5, $5, $6, 10, '{}'::jsonb)`,
         [assignment.testId, assignment.id, userId, number, finishedAt, score],
      )
   }

   const closedThisWeek = await assign(await quiz(adminId, 'A1'), at('2026-11-24T12:00:00Z'))
   const openThisWeek = await assign(await quiz(adminId, 'A2'), at('2026-11-27T00:00:00Z'))
   const notCounted = await assign(await quiz(adminId, 'A3'), at('2026-11-24T12:00:00Z'), false)
   const earlierThisMonth = await assign(await quiz(adminId, 'A4'), at('2026-11-10T00:00:00Z'))

   await attempt(closedThisWeek, s1, 1, 6, at('2026-11-23T08:00:00Z'))
   await attempt(closedThisWeek, s1, 2, 9, at('2026-11-23T09:00:00Z'))
   await attempt(openThisWeek, s1, 1, 10, at('2026-11-25T08:00:00Z'))
   await attempt(closedThisWeek, s2, 1, 8, at('2026-11-23T10:00:00Z'))
   await attempt(openThisWeek, s3, 1, 10, at('2026-11-25T08:30:00Z'))
   await attempt(closedThisWeek, s4, 1, 8, at('2026-11-24T10:00:00Z'))
   await attempt(notCounted, s5, 1, 10, at('2026-11-24T10:00:00Z'))
   await attempt(earlierThisMonth, s5, 1, 10, at('2026-11-09T10:00:00Z'))

   // Activity facts.
   async function trainerAttempt(userId, finishedAt, seconds, items) {
      const testId = (await client.query(
         `INSERT INTO tests (title, mode, status, origin, created_by, generation_filters)
          VALUES ('Generated', 'practice', 'draft', 'trainer', $1, '{}'::jsonb) RETURNING id`,
         [userId],
      )).rows[0].id
      const assignmentId = (await client.query(
         'INSERT INTO test_assignments (test_id, user_id, assigned_by) VALUES ($1, $2, $2) RETURNING id',
         [testId, userId],
      )).rows[0].id
      const attemptId = (await client.query(
         `INSERT INTO test_attempts (test_id, assignment_id, user_id, attempt_number, status, started_at,
            submitted_at, graded_at, score, max_score, policy_snapshot)
          VALUES ($1, $2, $3, 1, 'graded', $4::timestamptz - make_interval(secs => $5), $4, $4, 0, $6, '{}'::jsonb)
          RETURNING id`,
         [testId, assignmentId, userId, finishedAt, seconds, items.length],
      )).rows[0].id
      for (const [index, item] of items.entries()) {
         const testQuestionId = (await client.query(
            'INSERT INTO test_questions (test_id, question_id, position, points) VALUES ($1, $2, $3, 1) RETURNING id',
            [testId, item.questionId, index + 1],
         )).rows[0].id
         const itemId = (await client.query(
            `INSERT INTO attempt_questions (attempt_id, test_id, test_question_id, question_id, position, max_points, grading_snapshot)
             VALUES ($1, $2, $3, $4, $5, 1, '{}'::jsonb) RETURNING id`,
            [attemptId, testId, testQuestionId, item.questionId, index + 1],
         )).rows[0].id
         if (item.answered === false) continue
         await client.query(
            `INSERT INTO student_answers (attempt_question_id, question_id, answer_data, awarded_points, grading_status)
             VALUES ($1, $2, '{"optionKey":"A"}'::jsonb, $3, 'auto')`,
            [itemId, item.questionId, item.full ? 1 : 0],
         )
      }
   }
   // s1: qMid solved already on 10 Nov, so this week only qHard is new (x2).
   await trainerAttempt(s1, at('2026-11-10T10:00:00Z'), 60, [{ questionId: qMid, full: true }])
   await trainerAttempt(s1, at('2026-11-24T10:00:00Z'), 60, [
      { questionId: qMid, full: true }, { questionId: qHard, full: true }, { questionId: qEasy, full: false },
   ])
   // s2: too fast (4 s for 2 answers) earns nothing; s4: fewer than half answered earns nothing.
   await trainerAttempt(s2, at('2026-11-24T10:00:00Z'), 4, [{ questionId: qEasy, full: true }, { questionId: qMid, full: true }])
   await trainerAttempt(s4, at('2026-11-24T10:00:00Z'), 600, [
      { questionId: qEasy, full: true }, { questionId: qMid, answered: false }, { questionId: qHard, answered: false },
   ])

   async function mockExam(userId, score, finishedAt) {
      const testId = (await client.query(
         `INSERT INTO tests (title, mode, status, origin, created_by, generation_filters)
          VALUES ('Mock', 'practice', 'draft', 'mock_exam', $1, '{}'::jsonb) RETURNING id`,
         [userId],
      )).rows[0].id
      const assignmentId = (await client.query(
         'INSERT INTO test_assignments (test_id, user_id, assigned_by) VALUES ($1, $2, $2) RETURNING id',
         [testId, userId],
      )).rows[0].id
      await client.query(
         `INSERT INTO test_attempts (test_id, assignment_id, user_id, attempt_number, status, started_at,
            submitted_at, graded_at, score, max_score, policy_snapshot)
          VALUES ($1, $2, $3, 1, 'graded', $4::timestamptz - interval '3 hours', $4, $4, $5, 160, '{}'::jsonb)`,
         [testId, assignmentId, userId, finishedAt, score],
      )
   }
   await mockExam(s2, 96, at('2026-11-24T10:00:00Z'))
   await mockExam(s2, 64, at('2026-11-25T08:00:00Z'))

   const courseId = (await client.query(
      `INSERT INTO courses (title, subject_id, status, created_by) VALUES ($1, $2, 'published', $3) RETURNING id`,
      [`Ranking course ${suffix}`, subject.id, adminId],
   )).rows[0].id
   const moduleId = (await client.query(
      `INSERT INTO course_modules (course_id, title, position, status) VALUES ($1, 'M1', 1, 'published') RETURNING id`,
      [courseId],
   )).rows[0].id
   const lessons = []
   for (let index = 0; index < 13; index += 1) {
      lessons.push((await createLessonService(adminId, courseId, moduleId, { title: `L${index}`, lessonType: 'text' })).id)
   }
   async function completed(userId, lessonId, completedAt) {
      await client.query(
         `INSERT INTO lesson_progress (user_id, lesson_id, status, completed_at, updated_at)
          VALUES ($1, $2, 'completed', $3, $3)`,
         [userId, lessonId, completedAt],
      )
   }
   // s3: 12 lessons on one local day (only 10 count); s2: one lesson.
   for (let index = 0; index < 12; index += 1) {
      await completed(s3, lessons[index], at(`2026-11-24T${String(5 + index).padStart(2, '0')}:00:00Z`))
   }
   await completed(s2, lessons[12], at('2026-11-24T06:00:00Z'))

   const order = (data) => data.items.map((item) => [item.user.id, item.rank, item.score])

   await t.test('assignments: countsForGroupRanking on create, update and in responses', async () => {
      assert.equal(closedThisWeek.countsForGroupRanking, true)
      assert.equal(notCounted.countsForGroupRanking, false)
      const personalTest = await quiz(adminId, 'Personal')
      await assert.rejects(
         createAssignmentService(adminId, personalTest, { userId: s1, countsForGroupRanking: true }),
         { code: 'VALIDATION_ERROR' },
      )
      await assert.rejects(
         createAssignmentService(adminId, personalTest, { groupId: group.id, countsForGroupRanking: 'yes' }),
         { code: 'VALIDATION_ERROR' },
      )
      const personal = await createAssignmentService(adminId, personalTest, { userId: s1 })
      assert.equal(personal.countsForGroupRanking, false)
      await assert.rejects(
         updateAssignmentService(adminId, personalTest, personal.id, { countsForGroupRanking: true }),
         { code: 'VALIDATION_ERROR' },
      )

      // A teacher with canAssignTests sets the flag on their own test; a teacher of the group
      // without it may not change it even on their own test.
      const ownTest = await quiz(assigner, 'Own')
      const own = await createAssignmentService(assigner, ownTest, { groupId: group.id, countsForGroupRanking: true })
      assert.equal(own.countsForGroupRanking, true)
      const switched = await updateAssignmentService(assigner, ownTest, own.id, { countsForGroupRanking: false })
      assert.equal(switched.countsForGroupRanking, false)
      await client.query('UPDATE test_assignments SET status = \'revoked\' WHERE id = $1', [own.id])

      const viewerTest = await quiz(viewer, 'Viewer')
      const byAdmin = await createAssignmentService(adminId, viewerTest, { groupId: group.id })
      await assert.rejects(
         updateAssignmentService(viewer, viewerTest, byAdmin.id, { countsForGroupRanking: true }),
         { code: 'GROUP_NOT_FOUND' },
      )
      const flagged = await updateAssignmentService(adminId, viewerTest, byAdmin.id, { countsForGroupRanking: true })
      assert.equal(flagged.countsForGroupRanking, true)
      // Revoked: it never counts, so the numbers below are not affected.
      await client.query('UPDATE test_assignments SET status = \'revoked\' WHERE id = $1', [byAdmin.id])
      const { rows } = await client.query(
         `SELECT metadata FROM audit_events WHERE event_code = 'test.assignment_created' AND entity_id = $1`,
         [closedThisWeek.id],
      )
      assert.equal(rows[0].metadata.countsForGroupRanking, true)
   })

   await t.test('performance this week: average percent, 1-2-2-4 places, tie order, late joiner', async () => {
      const data = await getStaffGroupRankingService(adminId, group.id, {}, deps)
      assert.equal(data.board, 'performance')
      assert.equal(data.period, 'week')
      assert.equal(data.periodStart, '2026-11-22T19:00:00.000Z')
      assert.equal(data.periodEnd, '2026-11-29T19:00:00.000Z')
      assert.equal(data.formulaVersion, 1)
      assert.equal(data.computedAt, now.toISOString())
      assert.equal(data.participantsCount, 6)
      // s1: best 90 and 100; s2 and s4: 80 (s2 finished earlier); s3: missed 0 and 100;
      // s5: missed 0 (the not-counted assignment plays no part); s6: joined after A1, A2 still open.
      assert.deepEqual(order(data), [
         [s1, 1, 95], [s2, 2, 80], [s4, 2, 80], [s3, 4, 50], [s5, 5, 0], [s6, null, null],
      ])
      const first = data.items[0]
      assert.deepEqual(first.breakdown, { assignments: 2, submitted: 2, missed: 0 })
      assert.equal(first.assignmentsOnTime, 2)
      assert.equal(first.lastCountedAt, '2026-11-25T08:00:00.000Z')
      assert.deepEqual(data.items[4].breakdown, { assignments: 1, submitted: 0, missed: 1 })
      assert.deepEqual(first.user, { id: s1, firstName: 'S1', lastName: `R${suffix}`, avatarUrl: null })
      assert.equal(data.me, null)
   })

   await t.test('performance this month and all time', async () => {
      const month = await getStaffGroupRankingService(adminId, group.id, { period: 'month' }, deps)
      assert.equal(month.periodStart, '2026-10-31T19:00:00.000Z')
      const scores = new Map(month.items.map((item) => [item.user.id, item.score]))
      // A4 closed on 10 Nov: missed by s1 (0), solved by s5 (100).
      assert.equal(scores.get(s1), 63.33)
      assert.equal(scores.get(s5), 50)
      const all = await getStaffGroupRankingService(adminId, group.id, { period: 'all' }, deps)
      assert.equal(all.periodStart, null)
      assert.equal(all.periodEnd, null)
      assert.equal(new Map(all.items.map((item) => [item.user.id, item.score])).get(s1), 63.33)
   })

   await t.test('activity this week: trainer firsts, anti-cheat, mock exam best of week, lesson cap', async () => {
      const data = await getStaffGroupRankingService(adminId, group.id, { board: 'activity' }, deps)
      assert.deepEqual(order(data), [
         [s3, 1, 50], [s2, 2, 35], [s1, 3, 2], [s4, 4, 0], [s5, 4, 0], [s6, 4, 0],
      ])
      const byUser = new Map(data.items.map((item) => [item.user.id, item]))
      assert.deepEqual(byUser.get(s2).breakdown, {
         trainerPoints: 0, mockExamPoints: 30, mockExamsCounted: 1, lessonPoints: 5, lessonsCounted: 1, assignmentsOnTime: 1,
      })
      assert.equal(byUser.get(s3).breakdown.lessonsCounted, 10)
      assert.equal(byUser.get(s1).breakdown.trainerPoints, 2)
      assert.equal(byUser.get(s4).breakdown.trainerPoints, 0)
   })

   await t.test('students: own group only, default top10_self, full, staff_only', async () => {
      const own = await getGroupRankingService(s1, group.id, {}, deps)
      assert.equal(own.visibility, 'top10_self')
      assert.equal(own.participantsCount, 6)
      assert.deepEqual(own.items.map((item) => [item.user.id, item.rank, item.isMe]), [
         [s1, 1, true], [s2, 2, false], [s4, 2, false], [s3, 4, false], [s5, 5, false],
      ])
      assert.deepEqual(own.me, { rank: 1, score: 95 })
      assert.equal('breakdown' in own.items[0], false)
      const late = await getGroupRankingService(s6, group.id, {}, deps)
      assert.deepEqual(late.me, { rank: null, score: null })
      assert.equal(late.items.some((item) => item.isMe), false)

      assert.equal(own.viewerRole, 'student')
      assert.equal(own.studentVisibility, 'top10_self')
      await assert.rejects(getGroupRankingService(outsider, group.id, {}, deps), { code: 'GROUP_NOT_FOUND' })
      await assert.rejects(getGroupRankingService(s1, '999999999', {}, deps), { code: 'GROUP_NOT_FOUND' })
      await assert.rejects(getGroupRankingService(s1, 'x', {}, deps), { code: 'INVALID_GROUP_ID' })
      for (const query of [{ board: 'speed' }, { period: 'year' }]) {
         await assert.rejects(getGroupRankingService(s1, group.id, query, deps), { code: 'VALIDATION_ERROR' })
      }

      await updateRankingSettingsService(adminId, group.id, { visibility: 'full' })
      const full = await getGroupRankingService(s2, group.id, {}, deps)
      assert.equal(full.items.length, 6)
      assert.deepEqual(full.me, { rank: 2, score: 80 })

      await updateRankingSettingsService(viewer, group.id, { visibility: 'staff_only' })
      const hidden = await getGroupRankingService(s2, group.id, { board: 'activity' }, deps)
      assert.deepEqual([hidden.items, hidden.me, hidden.participantsCount, hidden.visibility], [[], null, 0, 'staff_only'])
      // Staff still see everyone.
      assert.equal((await getStaffGroupRankingService(viewer, group.id, {}, deps)).items.length, 6)
   })

   await t.test('staff open the group page ranking: everyone, whatever students see', async () => {
      const otherTeacher = await createUser('teacher', 'Other')
      const otherGroup = await createGroupService(adminId, { name: `Other ranking ${suffix}` })
      await addGroupTeacherService(adminId, otherGroup.id, { userId: otherTeacher })
      // Students currently see nothing (staff_only); staff still see all six, places included.
      for (const actor of [viewer, blind, assigner, adminId]) {
         const page = await getGroupRankingService(actor, group.id, {}, deps)
         assert.equal(page.viewerRole, 'staff')
         assert.equal(page.visibility, 'full')
         assert.equal(page.studentVisibility, 'staff_only')
         assert.equal(page.me, null)
         assert.equal(page.participantsCount, 6)
         assert.deepEqual(order(page), [
            [s1, 1, 95], [s2, 2, 80], [s4, 2, 80], [s3, 4, 50], [s5, 5, 0], [s6, null, null],
         ])
         assert.equal(page.items.some((item) => item.isMe || 'breakdown' in item), false)
      }
      // Admin: any group, also one they do not teach.
      assert.equal((await getGroupRankingService(adminId, otherGroup.id, {}, deps)).viewerRole, 'staff')
      // A teacher of another group, and a student who is not a member: 404.
      await assert.rejects(getGroupRankingService(otherTeacher, group.id, {}, deps), { code: 'GROUP_NOT_FOUND' })
      await assert.rejects(getGroupRankingService(outsider, group.id, {}, deps), { code: 'GROUP_NOT_FOUND' })
      // Students are unchanged.
      const student = await getGroupRankingService(s1, group.id, {}, deps)
      assert.deepEqual(
         [student.viewerRole, student.visibility, student.studentVisibility, student.items, student.me],
         ['student', 'staff_only', 'staff_only', [], null],
      )

      // "My groups": the viewer role, and the group pages open for the same people.
      const mine = await listGroupsService(blind, {})
      assert.deepEqual(mine.groups.map((item) => [item.id, item.viewerRole]), [[group.id, 'teacher']])
      const searched = await listGroupsService(adminId, { q: `Other ranking ${suffix}`, status: 'active' })
      assert.deepEqual(searched.groups.map((item) => [item.id, item.viewerRole]), [[otherGroup.id, 'admin']])
      assert.equal((await getGroupService(s1, group.id)).viewerRole, 'member')
      await client.query('UPDATE group_members SET is_representative = TRUE WHERE group_id = $1 AND user_id = $2', [group.id, s2])
      assert.equal((await getGroupService(s2, group.id)).viewerRole, 'representative')
      for (const actor of [blind, adminId]) {
         assert.equal((await getGroupService(actor, group.id)).memberCount, 6)
         const members = await listGroupMembersService(actor, group.id, {})
         assert.equal(members.members.length, 6)
         const teachers = await listGroupTeachersService(actor, group.id, {})
         assert.equal(teachers.teachers.length, 3)
         assert.equal(/phone/i.test(JSON.stringify([members, teachers])), false)
      }
      await assert.rejects(listGroupMembersService(otherTeacher, group.id, {}), { code: 'GROUP_NOT_FOUND' })
      await assert.rejects(getGroupService(otherTeacher, group.id), { code: 'GROUP_NOT_FOUND' })
   })

   await t.test('staff scope and settings', async () => {
      assert.equal((await getStaffGroupRankingService(viewer, group.id, { board: 'activity', period: 'month' }, deps)).participantsCount, 6)
      for (const actor of [blind, assigner, s1]) {
         await assert.rejects(getStaffGroupRankingService(actor, group.id, {}, deps), { code: 'GROUP_NOT_FOUND' })
         await assert.rejects(getRankingSettingsService(actor, group.id), { code: 'GROUP_NOT_FOUND' })
         await assert.rejects(updateRankingSettingsService(actor, group.id, { visibility: 'full' }), { code: 'GROUP_NOT_FOUND' })
      }
      const settings = await getRankingSettingsService(viewer, group.id)
      assert.equal(settings.visibility, 'staff_only')
      assert.equal(settings.isDefault, false)
      assert.equal(settings.updatedBy, viewer)
      for (const body of [{ visibility: 'public' }, {}, { visibility: 'full', extra: 1 }, null]) {
         await assert.rejects(updateRankingSettingsService(adminId, group.id, body), { code: 'VALIDATION_ERROR' })
      }
      const { rows } = await client.query(
         `SELECT metadata FROM audit_events WHERE event_code = 'group.ranking_settings_updated' AND entity_id = $1
          ORDER BY id`,
         [group.id],
      )
      assert.deepEqual(rows.map((row) => row.metadata), [
         { visibility: 'full', previous: 'top10_self' },
         { visibility: 'staff_only', previous: 'full' },
      ])

      const fresh = await createGroupService(adminId, { name: `Fresh ${suffix}` })
      assert.deepEqual(await getRankingSettingsService(adminId, fresh.id), {
         groupId: fresh.id, visibility: 'top10_self', isDefault: true, updatedBy: null, updatedAt: null,
      })
      const empty = await getStaffGroupRankingService(adminId, fresh.id, {}, deps)
      assert.deepEqual([empty.items, empty.participantsCount], [[], 0])
   })
})
