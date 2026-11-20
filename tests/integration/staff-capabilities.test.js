import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import pg from 'pg'

import { createApp } from '../../src/app.js'
import env from '../../src/configs/env.js'
import { withTransaction } from '../../src/repositories/transaction-repository.js'
import { addCourseTeacherService } from '../../src/services/course-service.js'
import { addGroupTeacherService, createGroupService } from '../../src/services/group-service.js'
import { getStaffCapabilitiesService } from '../../src/services/staff-capabilities-service.js'
import { createSessionTestService, createTelegramAuthTestService } from '../helpers/service-factories.js'

const { Client } = pg
const suffix = randomUUID().slice(0, 8)

test('staff capabilities: own roles, permissions and assignment flags', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   t.after(() => client.end())

   async function createUser(roles, status = 'active') {
      const { rows } = await client.query(
         `INSERT INTO users (status, onboarding_completed_at, blocked_at)
          VALUES ($1::varchar, CURRENT_TIMESTAMP, CASE WHEN $1::varchar = 'blocked' THEN CURRENT_TIMESTAMP END)
          RETURNING id`,
         [status],
      )
      for (const role of roles) {
         await client.query(
            'INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2',
            [rows[0].id, role],
         )
      }
      return rows[0].id
   }

   async function course(title, status = 'published') {
      return (await client.query(
         `INSERT INTO courses (title, status, created_by) VALUES ($1, $2, $3) RETURNING id`,
         [`${title} ${suffix}`, status, adminId],
      )).rows[0].id
   }

   const ownerId = await createUser(['owner'])
   const adminId = await createUser(['admin'])
   const teacher = await createUser(['teacher'])
   const otherTeacher = await createUser(['teacher'])
   const student = await createUser(['student'])
   const blocked = await createUser(['teacher'], 'blocked')

   const algebra = await course('Algebra')
   const geometry = await course('Geometry', 'archived')
   const foreignCourse = await course('Foreign')
   await addCourseTeacherService(adminId, algebra, {
      userId: teacher, canManageLessons: true, canViewResults: true,
   })
   await addCourseTeacherService(adminId, geometry, { userId: teacher, canEditCourse: true })
   await addCourseTeacherService(adminId, foreignCourse, { userId: otherTeacher, canManageTests: true })
   const group = await createGroupService(adminId, { name: `Group ${suffix}` })
   const foreignGroup = await createGroupService(adminId, { name: `Foreign ${suffix}` })
   await addGroupTeacherService(adminId, group.id, { userId: teacher, canViewResults: true, canAssignTests: true })
   await addGroupTeacherService(adminId, foreignGroup.id, { userId: otherTeacher, canPublishAnnouncements: true })

   await t.test('a teacher sees only their own assignments with their flags', async () => {
      const result = await getStaffCapabilitiesService(teacher)
      assert.deepEqual(result.roles, ['teacher'])
      assert.equal(result.allAccess, false)
      assert.equal(result.isTeacher, true)
      assert.ok(result.permissions.includes('progress.read'))
      assert.equal(result.permissions.includes('accounts.approve'), false)
      assert.deepEqual(result.courses.map((entry) => entry.courseId).sort(), [String(algebra), String(geometry)].sort())
      const algebraRow = result.courses.find((entry) => entry.courseId === String(algebra))
      assert.deepEqual(algebraRow, {
         courseId: String(algebra),
         title: `Algebra ${suffix}`,
         status: 'published',
         canEditCourse: false,
         canManageLessons: true,
         canManageQuestions: false,
         canManageTests: false,
         canViewResults: true,
      })
      assert.equal(result.courses.find((entry) => entry.courseId === String(geometry)).status, 'archived')
      assert.deepEqual(result.groups, [{
         groupId: String(group.id),
         code: group.code,
         name: group.name,
         status: 'active',
         canPublishAnnouncements: false,
         canAssignTests: true,
         canViewResults: true,
      }])

      const other = await getStaffCapabilitiesService(otherTeacher)
      assert.deepEqual(other.courses.map((entry) => entry.courseId), [String(foreignCourse)])
      assert.deepEqual(other.groups.map((entry) => entry.groupId), [String(foreignGroup.id)])
   })

   await t.test('owner and admin get allAccess without listing every course', async () => {
      for (const [userId, role] of [[ownerId, 'owner'], [adminId, 'admin']]) {
         const result = await getStaffCapabilitiesService(userId)
         assert.deepEqual(result.roles, [role])
         assert.equal(result.allAccess, true)
         assert.equal(result.isTeacher, false)
         assert.deepEqual(result.courses, [])
         assert.deepEqual(result.groups, [])
      }
   })

   await t.test('a student gets empty lists, not an error', async () => {
      const result = await getStaffCapabilitiesService(student)
      assert.deepEqual(result.roles, ['student'])
      assert.equal(result.allAccess, false)
      assert.equal(result.isTeacher, false)
      assert.deepEqual(result.courses, [])
      assert.deepEqual(result.groups, [])
   })

   await t.test('assignments are hidden once the teacher role is gone', async () => {
      const former = await createUser(['teacher'])
      await addCourseTeacherService(adminId, algebra, { userId: former, canManageLessons: true })
      await client.query(
         `DELETE FROM user_roles WHERE user_id = $1 AND role_id = (SELECT id FROM roles WHERE code = 'teacher')`,
         [former],
      )
      await client.query(
         `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = 'student'`,
         [former],
      )
      const result = await getStaffCapabilitiesService(former)
      assert.deepEqual(result.courses, [])
   })

   await t.test('inactive and invalid accounts are refused', async () => {
      await assert.rejects(getStaffCapabilitiesService(blocked), (error) => error.code === 'ACCOUNT_NOT_ACTIVE')
      await assert.rejects(getStaffCapabilitiesService('abc'), (error) => error.code === 'INVALID_USER_ID')
   })

   await t.test('HTTP: authentication required, own data only', async () => {
      const config = { ...env, jwtAccessSecret: 'staff-capabilities-integration-secret-longer-than-32-chars' }
      const sessions = createSessionTestService({ config })
      const app = createApp({
         telegramAuth: createTelegramAuthTestService({ config }).dependencies,
         authProtection: { config },
      })
      const server = await new Promise((resolve) => {
         const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
      })
      t.after(() => new Promise((resolve) => server.close(resolve)))
      const url = `http://127.0.0.1:${server.address().port}/api/v1/me/staff-capabilities`
      const token = async (userId) => (await withTransaction((transactionClient) => sessions.issueSession({
         userId, requestContext: { userAgent: 'test', ipAddress: '127.0.0.1' }, client: transactionClient,
      }))).accessToken

      assert.equal((await fetch(url)).status, 401)
      const response = await fetch(`${url}?userId=${otherTeacher}`, {
         headers: { authorization: `Bearer ${await token(teacher)}` },
      })
      assert.equal(response.status, 200)
      const { data } = await response.json()
      assert.equal(data.courses.length, 2, 'a query parameter never selects another user')
      assert.equal(data.courses.some((entry) => entry.courseId === String(foreignCourse)), false)
      const serialized = JSON.stringify(data)
      for (const field of ['phone', 'password', 'token', 'telegram']) assert.equal(serialized.includes(field), false)

      const studentResponse = await fetch(url, { headers: { authorization: `Bearer ${await token(student)}` } })
      assert.equal(studentResponse.status, 200)
      assert.deepEqual((await studentResponse.json()).data.courses, [])
   })
})
