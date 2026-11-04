import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import pg from 'pg'

import { createApp } from '../../src/app.js'
import env from '../../src/configs/env.js'
import { withTransaction } from '../../src/repositories/transaction-repository.js'
import { issueSessionService } from '../../src/services/auth/session-service.js'

const { Client } = pg
const suffix = randomUUID().slice(0, 8)
const config = {
   ...env,
   jwtAccessSecret: 'tests-authoring-integration-secret-longer-than-32-chars',
   authSessionTtlSeconds: 900,
   authRefreshTtlSeconds: 86400,
   authAdminRateLimit: 1000,
}
const future = (days) => new Date(Date.now() + days * 86400000).toISOString()

function text(value) {
   return { blocks: [{ type: 'text', text: value }] }
}

test('test authoring, publication and assignment integration', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   const server = await new Promise((resolve) => {
      const app = createApp({ authProtection: { config }, telegramAuth: { config } })
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
   })
   const port = server.address().port
   // npm test runs in a disposable database, so fixtures are dropped with it.
   t.after(async () => {
      await new Promise((resolve) => server.close(resolve))
      await client.end()
   })

   async function api(method, path, session, body) {
      const headers = { 'content-type': 'application/json' }
      if (session) headers.authorization = `Bearer ${session.accessToken}`
      const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
         method,
         headers,
         ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      return { status: response.status, body: await response.json() }
   }

   function expect(response, status, code) {
      assert.equal(response.status, status, JSON.stringify(response.body))
      if (code) assert.equal(response.body.error.code, code)
      return response.body.data
   }

   async function createUser(role, name) {
      const user = await client.query(
         `INSERT INTO users (status, onboarding_completed_at)
          VALUES ('active', CURRENT_TIMESTAMP) RETURNING id`,
      )
      const userId = user.rows[0].id
      await client.query(
         `INSERT INTO user_profiles (user_id, first_name, last_name) VALUES ($1, $2, 'M10')`,
         [userId, name],
      )
      await client.query(
         'INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2',
         [userId, role],
      )
      return userId
   }

   function issue(userId) {
      return withTransaction((transactionClient) => issueSessionService({
         userId,
         requestContext: { userAgent: 'M10 integration', ipAddress: '127.0.0.1' },
         client: transactionClient,
      }, { config }))
   }

   async function createCourse(title) {
      const course = await client.query(
         'INSERT INTO courses (title, created_by) VALUES ($1, $2) RETURNING id',
         [title, adminId],
      )
      return course.rows[0].id
   }

   async function assignCourseTeacher(courseId, teacherId, canManageTests) {
      await client.query(
         `INSERT INTO course_teachers (course_id, user_id, can_manage_tests, assigned_by)
          VALUES ($1, $2, $3, $4)`,
         [courseId, teacherId, canManageTests, adminId],
      )
   }

   async function createQuestion(bankId, externalId, { verify = true, publish = true } = {}) {
      const question = expect(await api('POST', `/admin/question-banks/${bankId}/questions`, admin, {
         externalId,
         questionType: 'single_choice',
         languageCode: 'en',
         content: text(`Question ${externalId}`),
         options: [
            { key: 'A', content: text('First') },
            { key: 'B', content: text('Second') },
         ],
      }), 201)
      expect(await api('PUT', `/admin/questions/${question.id}/answer-key`, admin, {
         answerData: { optionKey: 'B' },
         source: 'expert_review',
      }), 200)
      if (verify) {
         expect(await api('POST', `/admin/questions/${question.id}/answer-key/verify`, admin, {
            source: 'expert_review',
         }), 200)
      }
      if (publish) expect(await api('POST', `/admin/questions/${question.id}/publish`, admin), 200)
      return question.id
   }

   const createDraft = async (courseId, overrides = {}) => expect(await api('POST', '/admin/tests', admin, {
      courseId,
      title: 'Cell quiz',
      ...overrides,
   }), 201)

   async function createPublished(courseId, questionIds, overrides = {}) {
      const draft = await createDraft(courseId, overrides)
      expect(await api('POST', `/admin/tests/${draft.id}/questions`, admin, {
         questions: questionIds.map((questionId) => ({ questionId })),
      }), 201)
      return expect(await api('POST', `/admin/tests/${draft.id}/publish`, admin), 200)
   }

   const adminId = await createUser('admin', 'Admin')
   const scopedId = await createUser('teacher', 'Scoped')
   const lessonOnlyId = await createUser('teacher', 'LessonOnly')
   const outsiderId = await createUser('teacher', 'Outsider')
   const studentId = await createUser('student', 'Student')
   const strangerId = await createUser('student', 'Stranger')
   const revokedStudentId = await createUser('student', 'Revoked')
   const admin = await issue(adminId)
   const scoped = await issue(scopedId)
   const lessonOnly = await issue(lessonOnlyId)
   const outsider = await issue(outsiderId)
   const student = await issue(studentId)

   const courseId = await createCourse(`M10 course ${suffix}`)
   const otherCourseId = await createCourse(`M10 other ${suffix}`)
   await assignCourseTeacher(courseId, scopedId, true)
   await assignCourseTeacher(courseId, lessonOnlyId, false)

   const subject = expect(await api('POST', '/admin/subjects', admin, {
      code: `m10-${suffix}`,
      primaryLanguage: 'en',
      translations: { en: { title: 'M10' } },
   }), 201)
   const bank = expect(await api('POST', '/admin/question-banks', admin, {
      code: `m10-staff-${suffix}`,
      title: 'Staff bank',
      subjectId: subject.id,
      visibility: 'staff',
   }), 201)
   const privateBank = expect(await api('POST', '/admin/question-banks', admin, {
      code: `m10-private-${suffix}`,
      title: 'Private bank',
      subjectId: subject.id,
      visibility: 'private',
   }), 201)
   const [q1, q2, q3] = [
      await createQuestion(bank.id, 'q1'),
      await createQuestion(bank.id, 'q2'),
      await createQuestion(bank.id, 'q3'),
   ]
   const unverified = await createQuestion(bank.id, 'unverified', { verify: false, publish: false })
   const verifiedDraft = await createQuestion(bank.id, 'verified-draft', { publish: false })
   const privateQuestion = await createQuestion(privateBank.id, 'private')

   await t.test('creates drafts with the defaults and validates settings', async () => {
      const draft = await createDraft(courseId)
      assert.equal(draft.status, 'draft')
      assert.equal(draft.mode, 'practice')
      assert.equal(draft.maxAttempts, 1)
      assert.equal(draft.timeLimitMinutes, null)
      assert.equal(draft.answerRevealPolicy, 'after_submission')
      assert.equal(draft.passPercent, null)
      assert.equal(draft.totalPoints, '0')
      assert.deepEqual(draft.questions, [])

      const full = await createDraft(courseId, {
         mode: 'exam',
         timeLimitMinutes: 45,
         maxAttempts: null,
         answerRevealPolicy: 'after_window',
         shuffleQuestions: true,
         shuffleOptions: true,
         passPercent: 60,
         resultPolicy: 'best',
      })
      assert.equal(full.timeLimitMinutes, 45)
      assert.equal(full.maxAttempts, null)
      assert.equal(full.passPercent, 60)
      const stored = await client.query(
         'SELECT duration_seconds, grading_policy FROM tests WHERE id = $1',
         [full.id],
      )
      assert.equal(stored.rows[0].duration_seconds, 2700)
      assert.deepEqual(stored.rows[0].grading_policy, { passPercent: 60 })

      for (const invalid of [
         { title: '' },
         { mode: 'nct', timeLimitMinutes: 10 },
         { mode: 'exam' },
         { timeLimitMinutes: 0 },
         { maxAttempts: 0 },
         { passPercent: 101 },
         { answerRevealPolicy: 'after_answer' },
         { shuffleQuestions: 'yes' },
         { unknown: true },
      ]) {
         expect(await api('POST', '/admin/tests', admin, { courseId, title: 'x', ...invalid }), 400, 'VALIDATION_ERROR')
      }
      expect(await api('POST', '/admin/tests', admin, { title: 'x' }), 400, 'VALIDATION_ERROR')
      expect(await api('GET', '/admin/tests/abc', admin), 400, 'INVALID_TEST_ID')

      const patched = expect(await api('PATCH', `/admin/tests/${draft.id}`, admin, {
         title: 'Renamed',
         passPercent: 50,
      }), 200)
      assert.equal(patched.title, 'Renamed')
      const cleared = expect(await api('PATCH', `/admin/tests/${draft.id}`, admin, { passPercent: null }), 200)
      assert.equal(cleared.passPercent, null)
      expect(await api('PATCH', `/admin/tests/${draft.id}`, admin, { courseId: otherCourseId }), 400, 'VALIDATION_ERROR')
      expect(await api('PATCH', `/admin/tests/${draft.id}`, admin, { mode: 'exam' }), 400, 'VALIDATION_ERROR')

      const archivedCourse = await createCourse(`M10 archived ${suffix}`)
      await client.query(`UPDATE courses SET status = 'archived' WHERE id = $1`, [archivedCourse])
      expect(await api('POST', '/admin/tests', admin, { courseId: archivedCourse, title: 'x' }), 409, 'COURSE_ARCHIVED')
   })

   await t.test('adds only published questions with verified keys, with points and order', async () => {
      const draft = await createDraft(courseId)
      const path = `/admin/tests/${draft.id}/questions`
      expect(await api('POST', path, admin, { questions: [{ questionId: unverified }] }), 409, 'QUESTION_NOT_ELIGIBLE')
      expect(await api('POST', path, admin, { questions: [{ questionId: verifiedDraft }] }), 409, 'QUESTION_NOT_ELIGIBLE')
      expect(await api('POST', path, admin, { questions: [{ questionId: '999999999' }] }), 404, 'QUESTION_NOT_FOUND')
      expect(await api('POST', path, admin, { questions: [] }), 400, 'VALIDATION_ERROR')
      expect(await api('POST', path, admin, { questions: [{ questionId: q1 }, { questionId: q1 }] }), 400, 'VALIDATION_ERROR')
      for (const points of [0, -1, '1.234', 10000, 'x', null]) {
         expect(await api('POST', path, admin, { questions: [{ questionId: q1, points }] }), 400, 'VALIDATION_ERROR')
      }

      const added = expect(await api('POST', path, admin, {
         questions: [{ questionId: q1 }, { questionId: q2, points: 2.5 }, { questionId: q3, points: '3' }],
      }), 201)
      assert.deepEqual(added.questions.map((item) => [item.questionId, item.position, item.points]), [
         [q1, 1, '1.00'],
         [q2, 2, '2.50'],
         [q3, 3, '3.00'],
      ])
      assert.equal(added.totalPoints, '6.50')
      assert.ok(!JSON.stringify(added).includes('answerData'))
      expect(await api('POST', path, admin, { questions: [{ questionId: q1 }] }), 409, 'TEST_QUESTION_DUPLICATE')

      const orderPath = `/admin/tests/${draft.id}/questions/order`
      expect(await api('PUT', orderPath, admin, { questionIds: [q1, q2] }), 400, 'VALIDATION_ERROR')
      expect(await api('PUT', orderPath, admin, { questionIds: [q1, q1, q2] }), 400, 'VALIDATION_ERROR')
      const reordered = expect(await api('PUT', orderPath, admin, { questionIds: [q3, q1, q2] }), 200)
      assert.deepEqual(reordered.questions.map((item) => item.questionId), [q3, q1, q2])

      const repriced = expect(await api('PUT', `${path}/${q1}/points`, admin, { points: 4 }), 200)
      assert.equal(repriced.questions[1].points, '4.00')
      expect(await api('PUT', `${path}/${privateQuestion}/points`, admin, { points: 4 }), 404, 'TEST_QUESTION_NOT_FOUND')

      const removed = expect(await api('DELETE', `${path}/${q3}`, admin), 200)
      assert.deepEqual(removed.questions.map((item) => [item.questionId, item.position]), [[q1, 1], [q2, 2]])
      expect(await api('DELETE', `${path}/${q3}`, admin), 404, 'TEST_QUESTION_NOT_FOUND')

      const deleted = expect(await api('DELETE', `/admin/tests/${draft.id}`, admin), 200)
      assert.equal(deleted.status, 'deleted')
      expect(await api('GET', `/admin/tests/${draft.id}`, admin), 404, 'TEST_NOT_FOUND')
   })

   await t.test('publish requires questions; a published test is immutable', async () => {
      const empty = await createDraft(courseId)
      expect(await api('POST', `/admin/tests/${empty.id}/publish`, admin), 409, 'TEST_NOT_PUBLISHABLE')

      const published = await createPublished(courseId, [q1, q2])
      assert.equal(published.status, 'published')
      const path = `/admin/tests/${published.id}`
      expect(await api('POST', `${path}/publish`, admin), 409, 'INVALID_TEST_TRANSITION')
      expect(await api('PATCH', path, admin, { title: 'Changed' }), 409, 'TEST_IMMUTABLE')
      expect(await api('DELETE', path, admin), 409, 'TEST_IMMUTABLE')
      expect(await api('POST', `${path}/questions`, admin, { questions: [{ questionId: q3 }] }), 409, 'TEST_IMMUTABLE')
      expect(await api('DELETE', `${path}/questions/${q1}`, admin), 409, 'TEST_IMMUTABLE')
      expect(await api('PUT', `${path}/questions/order`, admin, { questionIds: [q2, q1] }), 409, 'TEST_IMMUTABLE')
      expect(await api('PUT', `${path}/questions/${q1}/points`, admin, { points: 9 }), 409, 'TEST_IMMUTABLE')
      await assert.rejects(
         client.query('UPDATE test_questions SET points = 9 WHERE test_id = $1', [published.id]),
         /TEST_IMMUTABLE/,
      )
      await assert.rejects(
         client.query(`UPDATE tests SET title = 'x' WHERE id = $1`, [published.id]),
         /TEST_IMMUTABLE/,
      )

      const archived = expect(await api('POST', `${path}/archive`, admin), 200)
      assert.equal(archived.status, 'archived')
      expect(await api('POST', `${path}/archive`, admin), 409, 'INVALID_TEST_TRANSITION')
      expect(await api('PATCH', path, admin, { title: 'Changed' }), 409, 'TEST_IMMUTABLE')
   })

   await t.test('later question changes do not alter a published test', async () => {
      const snapshotQuestion = await createQuestion(bank.id, 'snapshot')
      const published = await createPublished(courseId, [snapshotQuestion])
      const before = expect(await api('GET', `/admin/tests/${published.id}`, admin), 200)

      expect(await api('PATCH', `/admin/questions/${snapshotQuestion}`, admin, { difficulty: 3 }), 409, 'QUESTION_IMMUTABLE')
      expect(await api('PUT', `/admin/questions/${snapshotQuestion}/answer-key`, admin, {
         answerData: { optionKey: 'A' },
         source: 'expert_review',
      }), 409)
      expect(await api('POST', `/admin/questions/${snapshotQuestion}/archive`, admin), 200)

      const after = expect(await api('GET', `/admin/tests/${published.id}`, admin), 200)
      assert.deepEqual(after.questions[0].content, before.questions[0].content)
      assert.equal(after.questions[0].points, before.questions[0].points)
      assert.equal(after.questions[0].status, 'archived')
      assert.equal(after.status, 'published')

      const blocked = await createDraft(courseId)
      await client.query(
         `INSERT INTO test_questions (test_id, question_id, position, points) VALUES ($1, $2, 1, 1)`,
         [blocked.id, snapshotQuestion],
      )
      expect(await api('POST', `/admin/tests/${blocked.id}/publish`, admin), 409, 'TEST_NOT_PUBLISHABLE')
   })

   await t.test('copy makes an editable draft and protects its source', async () => {
      const published = await createPublished(courseId, [q1, q2], { passPercent: 70 })
      const copy = expect(await api('POST', `/admin/tests/${published.id}/copy`, admin), 201)
      assert.equal(copy.status, 'draft')
      assert.equal(copy.copiedFromId, published.id)
      assert.equal(copy.title, 'Cell quiz (copy)')
      assert.equal(copy.passPercent, 70)
      assert.deepEqual(copy.questions.map((item) => item.questionId), [q1, q2])
      expect(await api('DELETE', `/admin/tests/${copy.id}/questions/${q1}`, admin), 200)

      const source = await createDraft(courseId)
      const draftCopy = expect(await api('POST', `/admin/tests/${source.id}/copy`, admin), 201)
      expect(await api('DELETE', `/admin/tests/${source.id}`, admin), 409, 'TEST_HAS_COPIES')
      expect(await api('DELETE', `/admin/tests/${draftCopy.id}`, admin), 200)
      expect(await api('DELETE', `/admin/tests/${source.id}`, admin), 200)
   })

   await t.test('permissions and teacher scope', async () => {
      const draft = await createDraft(courseId)
      const foreign = await createDraft(otherCourseId)
      const path = `/admin/tests/${draft.id}`

      expect(await api('GET', '/admin/tests'), 401)
      expect(await api('GET', '/admin/tests', student), 403, 'ACTION_FORBIDDEN')
      expect(await api('POST', '/admin/tests', student, { courseId, title: 'x' }), 403, 'ACTION_FORBIDDEN')

      expect(await api('GET', path, scoped), 200)
      const listed = expect(await api('GET', '/admin/tests?limit=100', scoped), 200)
      assert.ok(listed.tests.some((item) => item.id === draft.id))
      assert.ok(listed.tests.every((item) => item.courseId === courseId))
      expect(await api('POST', '/admin/tests', scoped, { courseId, title: 'Teacher test' }), 201)
      expect(await api('POST', '/admin/tests', scoped, { courseId: otherCourseId, title: 'x' }), 404, 'COURSE_NOT_FOUND')
      expect(await api('GET', `/admin/tests/${foreign.id}`, scoped), 404, 'TEST_NOT_FOUND')
      expect(await api('PATCH', `/admin/tests/${foreign.id}`, scoped, { title: 'x' }), 404, 'TEST_NOT_FOUND')
      expect(await api('GET', `/admin/tests/${foreign.id}/assignments`, scoped), 404, 'TEST_NOT_FOUND')

      expect(await api('POST', `${path}/questions`, scoped, { questions: [{ questionId: q1 }] }), 201)
      expect(await api('POST', `${path}/questions`, scoped, { questions: [{ questionId: privateQuestion }] }), 404, 'QUESTION_NOT_FOUND')
      expect(await api('POST', `${path}/publish`, scoped), 403, 'ACTION_FORBIDDEN')

      for (const session of [lessonOnly, outsider]) {
         expect(await api('GET', path, session), 404, 'TEST_NOT_FOUND')
         expect(await api('PATCH', path, session, { title: 'x' }), 404, 'TEST_NOT_FOUND')
         expect(await api('POST', '/admin/tests', session, { courseId, title: 'x' }), 404, 'COURSE_NOT_FOUND')
         const empty = expect(await api('GET', `/admin/tests?courseId=${courseId}`, session), 200)
         assert.deepEqual(empty.tests, [])
      }

      const seeded = await client.query(
         `SELECT role.code, count(*)::integer AS count
          FROM role_permissions AS grant_record
          JOIN roles AS role ON role.id = grant_record.role_id
          JOIN permissions AS permission ON permission.id = grant_record.permission_id
          WHERE permission.code LIKE 'tests.%'
          GROUP BY role.code ORDER BY role.code`,
      )
      assert.deepEqual(seeded.rows, [
         { code: 'admin', count: 5 },
         { code: 'owner', count: 5 },
         { code: 'teacher', count: 4 },
      ])
   })

   await t.test('list pagination and filters', async () => {
      const listed = expect(await api('GET', `/admin/tests?courseId=${courseId}&limit=1`, admin), 200)
      assert.equal(listed.tests.length, 1)
      assert.equal(listed.pagination.hasMore, true)
      const published = expect(await api('GET', `/admin/tests?courseId=${courseId}&status=published`, admin), 200)
      assert.ok(published.tests.every((item) => item.status === 'published'))
      expect(await api('GET', '/admin/tests?status=open', admin), 400, 'VALIDATION_ERROR')
      expect(await api('GET', '/admin/tests?extra=1', admin), 400, 'VALIDATION_ERROR')
   })

   await t.test('assignment validation, groups and enrolled students', async () => {
      const group = expect(await api('POST', '/admin/groups', admin, { name: `M10 group ${suffix}` }), 201)
      const archivedGroup = expect(await api('POST', '/admin/groups', admin, { name: `M10 archived ${suffix}` }), 201)
      expect(await api('PATCH', `/admin/groups/${archivedGroup.id}`, admin, { status: 'archived' }), 200)
      await client.query(
         'INSERT INTO course_enrollments (user_id, course_id, granted_by) VALUES ($1, $2, $3)',
         [studentId, courseId, adminId],
      )
      await client.query(
         `INSERT INTO course_enrollments (user_id, course_id, granted_by, revoked_at, revoked_by)
          VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $3)`,
         [revokedStudentId, courseId, adminId],
      )

      const draft = await createDraft(courseId)
      expect(await api('POST', `/admin/tests/${draft.id}/assignments`, admin, { groupId: group.id }), 409, 'TEST_NOT_PUBLISHED')

      const published = await createPublished(courseId, [q1])
      const path = `/admin/tests/${published.id}/assignments`
      expect(await api('POST', path, admin, {}), 400, 'VALIDATION_ERROR')
      expect(await api('POST', path, admin, { groupId: group.id, userId: studentId }), 400, 'VALIDATION_ERROR')
      expect(await api('POST', path, admin, { courseId }), 400, 'VALIDATION_ERROR')
      expect(await api('POST', path, admin, { groupId: group.id, closesAt: 'tomorrow' }), 400, 'VALIDATION_ERROR')
      expect(await api('POST', path, admin, { groupId: group.id, closesAt: future(-1) }), 400, 'VALIDATION_ERROR')
      expect(await api('POST', path, admin, {
         groupId: group.id,
         opensAt: future(3),
         closesAt: future(2),
      }), 400, 'VALIDATION_ERROR')
      expect(await api('POST', path, admin, { groupId: '999999999' }), 404, 'GROUP_NOT_FOUND')
      expect(await api('POST', path, admin, { groupId: archivedGroup.id }), 409, 'GROUP_ARCHIVED')
      expect(await api('POST', path, admin, { userId: '999999999' }), 404, 'USER_NOT_FOUND')
      expect(await api('POST', path, admin, { userId: strangerId }), 409, 'STUDENT_NOT_ENROLLED')
      expect(await api('POST', path, admin, { userId: revokedStudentId }), 409, 'STUDENT_NOT_ENROLLED')

      const toGroup = expect(await api('POST', path, admin, {
         groupId: group.id,
         opensAt: future(1),
         closesAt: future(2),
      }), 201)
      assert.equal(toGroup.audienceType, 'group')
      assert.equal(toGroup.groupTitle, `M10 group ${suffix}`)
      assert.equal(toGroup.status, 'active')
      const toStudent = expect(await api('POST', path, admin, { userId: studentId }), 201)
      assert.equal(toStudent.audienceType, 'user')
      assert.equal(toStudent.userDisplayName, 'Student M10')
      expect(await api('POST', path, admin, { groupId: group.id }), 409, 'ASSIGNMENT_DUPLICATE')
      expect(await api('POST', path, admin, { userId: studentId }), 409, 'ASSIGNMENT_DUPLICATE')

      const enrollments = await client.query(
         'SELECT count(*)::integer AS count FROM course_enrollments WHERE user_id = $1',
         [strangerId],
      )
      assert.equal(enrollments.rows[0].count, 0)

      const listed = expect(await api('GET', `${path}?limit=1`, admin), 200)
      assert.equal(listed.assignments.length, 1)
      assert.equal(listed.pagination.hasMore, true)
      assert.equal(expect(await api('GET', `/admin/tests/${published.id}`, admin), 200).activeAssignmentCount, 2)

      const moved = expect(await api('PATCH', `${path}/${toGroup.id}`, admin, { closesAt: future(5) }), 200)
      assert.ok(new Date(moved.closesAt) > new Date(toGroup.closesAt))
      expect(await api('PATCH', `${path}/${toGroup.id}`, admin, { closesAt: future(0.5) }), 400, 'VALIDATION_ERROR')
      expect(await api('PATCH', `${path}/${toGroup.id}`, admin, { groupId: group.id }), 400, 'VALIDATION_ERROR')
      expect(await api('PATCH', `${path}/999999999`, admin, { closesAt: future(5) }), 404, 'ASSIGNMENT_NOT_FOUND')

      const revoked = expect(await api('DELETE', `${path}/${toStudent.id}`, admin), 200)
      assert.equal(revoked.status, 'revoked')
      expect(await api('DELETE', `${path}/${toStudent.id}`, admin), 409, 'ASSIGNMENT_NOT_ACTIVE')
      expect(await api('PATCH', `${path}/${toStudent.id}`, admin, { closesAt: future(5) }), 409, 'ASSIGNMENT_NOT_ACTIVE')
      const onlyRevoked = expect(await api('GET', `${path}?status=revoked`, admin), 200)
      assert.deepEqual(onlyRevoked.assignments.map((item) => item.id), [toStudent.id])
      expect(await api('POST', path, admin, { userId: studentId }), 201)
   })

   await t.test('after_window tests need a closing time; teachers need the group flag', async () => {
      const group = expect(await api('POST', '/admin/groups', admin, { name: `M10 flag ${suffix}` }), 201)
      const windowed = await createPublished(courseId, [q1], { answerRevealPolicy: 'after_window' })
      const path = `/admin/tests/${windowed.id}/assignments`
      expect(await api('POST', path, admin, { groupId: group.id }), 400, 'VALIDATION_ERROR')
      const assignment = expect(await api('POST', path, admin, { groupId: group.id, closesAt: future(2) }), 201)
      expect(await api('PATCH', `${path}/${assignment.id}`, admin, { closesAt: null }), 400, 'VALIDATION_ERROR')

      const published = await createPublished(courseId, [q2])
      const teacherPath = `/admin/tests/${published.id}/assignments`
      expect(await api('POST', teacherPath, scoped, { groupId: group.id }), 404, 'GROUP_NOT_FOUND')
      await client.query(
         `INSERT INTO group_teachers (group_id, user_id, can_assign_tests, assigned_by)
          VALUES ($1, $2, false, $3)`,
         [group.id, scopedId, adminId],
      )
      expect(await api('POST', teacherPath, scoped, { groupId: group.id }), 404, 'GROUP_NOT_FOUND')
      await client.query(
         'UPDATE group_teachers SET can_assign_tests = true WHERE group_id = $1 AND user_id = $2',
         [group.id, scopedId],
      )
      expect(await api('POST', teacherPath, scoped, { groupId: group.id }), 201)
      expect(await api('GET', teacherPath, outsider), 404, 'TEST_NOT_FOUND')
      expect(await api('POST', teacherPath, outsider, { groupId: group.id }), 404, 'TEST_NOT_FOUND')
      expect(await api('POST', teacherPath, student, { groupId: group.id }), 403, 'ACTION_FORBIDDEN')
   })

   await t.test('mutations are audited and roll back together', async () => {
      const draft = await createDraft(courseId)
      const events = await client.query(
         `SELECT event_code FROM audit_events WHERE entity_type = 'test' AND entity_id = $1`,
         [draft.id],
      )
      assert.deepEqual(events.rows.map((row) => row.event_code), ['test.created'])

      const failingApp = createApp({
         authProtection: { config },
         telegramAuth: { config },
         tests: {
            auth: { appendAuditEvent: async () => { throw new Error('audit failed') } },
         },
      })
      const failing = await new Promise((resolve) => {
         const listener = failingApp.listen(0, '127.0.0.1', () => resolve(listener))
      })
      try {
         const response = await fetch(`http://127.0.0.1:${failing.address().port}/api/v1/admin/tests/${draft.id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.accessToken}` },
            body: JSON.stringify({ title: 'Not saved' }),
         })
         assert.equal(response.status, 500)
      } finally {
         await new Promise((resolve) => failing.close(resolve))
      }
      assert.equal(expect(await api('GET', `/admin/tests/${draft.id}`, admin), 200).title, 'Cell quiz')
   })

   await t.test('concurrent duplicate assignments create one row', async () => {
      const group = expect(await api('POST', '/admin/groups', admin, { name: `M10 race ${suffix}` }), 201)
      const published = await createPublished(courseId, [q1])
      const responses = await Promise.all([1, 2, 3, 4].map(() => (
         api('POST', `/admin/tests/${published.id}/assignments`, admin, { groupId: group.id })
      )))
      assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409, 409, 409])
   })

})
