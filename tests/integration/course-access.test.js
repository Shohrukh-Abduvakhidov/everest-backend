import assert from 'node:assert/strict'
import test from 'node:test'

import pg from 'pg'

import { createApp } from '../../src/app.js'
import env from '../../src/configs/env.js'
import { withTransaction } from '../../src/repositories/transaction-repository.js'
import { issueSessionService } from '../../src/services/auth/session-service.js'
import { grantCourseEnrollmentService } from '../../src/services/course-access-service.js'
import { requireModuleAccessService } from '../../src/services/learner-course-service.js'

const { Client } = pg
const userIds = []
const courseIds = []
const groupIds = []
const subjectIds = []
const config = {
   ...env,
   jwtAccessSecret: 'course-access-integration-secret-longer-than-32-characters',
   authSessionTtlSeconds: 900,
   authRefreshTtlSeconds: 86400,
   authAdminRateLimit: 1000,
}
const day = 24 * 60 * 60 * 1000

function future(days = 30) {
   return new Date(Date.now() + days * day).toISOString()
}

async function createUser(client, role, name, { status = 'active', onboarded = true } = {}) {
   const user = await client.query(
      `INSERT INTO users (status, onboarding_completed_at)
       VALUES ($1, CASE WHEN $2 THEN CURRENT_TIMESTAMP END) RETURNING id`,
      [status, onboarded],
   )
   const userId = user.rows[0].id
   userIds.push(userId)
   await client.query(
      `INSERT INTO user_profiles (user_id, first_name, last_name) VALUES ($1, $2, 'M06')`,
      [userId, name],
   )
   await client.query(
      `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2`,
      [userId, role],
   )
   return userId
}

async function issue(userId) {
   return withTransaction((client) => issueSessionService({
      userId,
      requestContext: { userAgent: 'M06 integration', ipAddress: '127.0.0.1' },
      client,
   }, { config }))
}

async function api(port, method, path, session, body) {
   const headers = { 'content-type': 'application/json' }
   if (session) headers.authorization = `Bearer ${session.accessToken}`
   const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
   })
   return { response, body: await response.json() }
}

async function listen(app) {
   return new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
   })
}

async function cleanup(client) {
   if (!userIds.length) return
   await client.query('DELETE FROM lesson_progress WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM lessons WHERE course_id = ANY($1::bigint[])', [courseIds])
   await client.query('DELETE FROM module_access_grants WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM course_enrollments WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM course_modules WHERE course_id = ANY($1::bigint[])', [courseIds])
   await client.query("DELETE FROM audit_events WHERE event_code LIKE 'course.%' AND (actor_user_id = ANY($1::bigint[]) OR subject_user_id = ANY($1::bigint[]))", [userIds])
   await client.query("DELETE FROM audit_events WHERE event_code LIKE 'group.%' AND actor_user_id = ANY($1::bigint[])", [userIds])
   await client.query('DELETE FROM group_members WHERE group_id = ANY($1::bigint[])', [groupIds])
   await client.query('DELETE FROM groups WHERE id = ANY($1::bigint[])', [groupIds])
   await client.query('DELETE FROM course_teachers WHERE course_id = ANY($1::bigint[])', [courseIds])
   await client.query('DELETE FROM courses WHERE id = ANY($1::bigint[]) OR created_by = ANY($2::bigint[])', [courseIds, userIds])
   await client.query('DELETE FROM subjects WHERE id = ANY($1::bigint[])', [subjectIds])
   await client.query('DELETE FROM auth_refresh_tokens WHERE session_id IN (SELECT id FROM auth_sessions WHERE user_id = ANY($1::bigint[]))', [userIds])
   await client.query('DELETE FROM auth_sessions WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM user_roles WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM user_profiles WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [userIds])
}

test('course enrollments and module access grants integration', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   const app = createApp({ authProtection: { config }, telegramAuth: { config } })
   const server = await listen(app)
   const port = server.address().port
   const admin = '/api/v1/admin/courses'

   async function createCourse(sessionAdmin, title, { publish = true, modules = 2 } = {}) {
      const course = await api(port, 'POST', admin, sessionAdmin, {
         title,
         subjectId: null,
      })
      const courseId = course.body.data.id
      courseIds.push(courseId)
      const moduleIds = []
      for (let index = 0; index < modules; index += 1) {
         const created = await api(port, 'POST', `${admin}/${courseId}/modules`, sessionAdmin, {
            title: `${title} module ${index + 1}`,
            description: `Public description ${index + 1}`,
         })
         moduleIds.push(created.body.data.id)
         await api(port, 'POST', `${admin}/${courseId}/modules/${created.body.data.id}/publish`, sessionAdmin)
      }
      if (publish) {
         await client.query(
            'UPDATE courses SET subject_id = $2 WHERE id = $1',
            [courseId, subjectIds[0]],
         )
         const published = await api(port, 'POST', `${admin}/${courseId}/publish`, sessionAdmin)
         assert.equal(published.response.status, 200, JSON.stringify(published.body))
      }
      return { courseId, moduleIds }
   }

   try {
      const subject = await client.query(
         "INSERT INTO subjects (code, primary_language) VALUES ($1, 'tg') RETURNING id",
         [`m06-${Date.now()}`],
      )
      subjectIds.push(subject.rows[0].id)
      const adminId = await createUser(client, 'admin', 'Admin')
      const studentId = await createUser(client, 'student', 'Student')
      const otherStudentId = await createUser(client, 'student', 'Other')
      const freshStudentId = await createUser(client, 'student', 'Fresh', { onboarded: false })
      const pendingStudentId = await createUser(client, 'student', 'Pending', { status: 'pending' })
      const teacherId = await createUser(client, 'teacher', 'Teacher')
      const sessions = {
         admin: await issue(adminId),
         student: await issue(studentId),
         otherStudent: await issue(otherStudentId),
         freshStudent: await issue(freshStudentId),
         teacher: await issue(teacherId),
      }

      const main = await createCourse(sessions.admin, 'Access Course')
      const second = await createCourse(sessions.admin, 'Second Course', { modules: 1 })
      const draft = await createCourse(sessions.admin, 'Draft Course', { publish: false, modules: 1 })
      const enrollments = `${admin}/${main.courseId}/enrollments`
      const [moduleOne, moduleTwo] = main.moduleIds
      await api(port, 'POST', `${admin}/${main.courseId}/teachers`, sessions.admin, {
         userId: teacherId,
         canEditCourse: true,
      })

      await t.test('requires authentication and the course access permissions', async () => {
         const anonymous = await api(port, 'GET', enrollments, null)
         assert.equal(anonymous.response.status, 401)
         for (const actor of [sessions.student, sessions.teacher]) {
            const read = await api(port, 'GET', enrollments, actor)
            assert.equal(read.response.status, 403)
            assert.equal(read.body.error.code, 'ACTION_FORBIDDEN')
            const grant = await api(port, 'POST', enrollments, actor, { userId: studentId, expiresAt: null })
            assert.equal(grant.response.status, 403)
            const module = await api(port, 'POST', `${enrollments}/${studentId}/modules`, actor, {
               moduleId: moduleOne,
               expiresAt: null,
            })
            assert.equal(module.response.status, 403)
            const revoke = await api(port, 'POST', `${enrollments}/${studentId}/revoke`, actor)
            assert.equal(revoke.response.status, 403)
         }
         const none = await client.query('SELECT 1 FROM course_enrollments WHERE user_id = $1', [studentId])
         assert.equal(none.rowCount, 0)
      })

      await t.test('validates enrollment input and eligibility', async () => {
         const post = (body) => api(port, 'POST', enrollments, sessions.admin, body)
         for (const body of [
            { userId: studentId },
            { userId: studentId, expiresAt: 'tomorrow' },
            { userId: studentId, expiresAt: '2020-01-01T00:00:00Z' },
            { userId: studentId, beginsAt: future(10), expiresAt: future(5) },
            { userId: studentId, expiresAt: null, grantedBy: adminId },
            { userId: 'abc', expiresAt: null },
            { expiresAt: null },
         ]) {
            const result = await post(body)
            assert.equal(result.response.status, 400, JSON.stringify(body))
            assert.equal(result.body.error.code, 'VALIDATION_ERROR')
         }
         assert.equal((await post({ userId: '999999999999', expiresAt: null })).response.status, 404)
         for (const userId of [teacherId, adminId, pendingStudentId]) {
            const result = await post({ userId, expiresAt: null })
            assert.equal(result.response.status, 409)
            assert.equal(result.body.error.code, 'ENROLLMENT_USER_INELIGIBLE')
         }
         const unpublished = await api(port, 'POST', `${admin}/${draft.courseId}/enrollments`, sessions.admin, {
            userId: studentId,
            expiresAt: null,
         })
         assert.equal(unpublished.response.status, 409)
         assert.equal(unpublished.body.error.code, 'COURSE_NOT_PUBLISHED')
         const missingCourse = await api(port, 'POST', `${admin}/999999999999/enrollments`, sessions.admin, {
            userId: studentId,
            expiresAt: null,
         })
         assert.equal(missingCourse.response.status, 404)
      })

      await t.test('group membership grants no course or module access', async () => {
         const group = await api(port, 'POST', '/api/v1/admin/groups', sessions.admin, {
            code: `m06-${Date.now()}`,
            name: 'M06 Group',
         })
         groupIds.push(group.body.data.id)
         const member = await api(port, 'POST', `/api/v1/admin/groups/${group.body.data.id}/members`, sessions.admin, { userId: studentId })
         assert.equal(member.response.status, 201)
         const courses = await api(port, 'GET', '/api/v1/courses', sessions.student)
         assert.deepEqual(courses.body.data.courses, [])
         const modules = await api(port, 'GET', `/api/v1/courses/${main.courseId}/modules`, sessions.student)
         assert.equal(modules.response.status, 404)
         await assert.rejects(
            requireModuleAccessService(studentId, moduleOne),
            { code: 'MODULE_ACCESS_DENIED' },
         )
      })

      await t.test('grants an enrollment once, including under concurrency', async () => {
         const body = { userId: studentId, expiresAt: future(30) }
         const results = await Promise.all([
            api(port, 'POST', enrollments, sessions.admin, body),
            api(port, 'POST', enrollments, sessions.admin, body),
         ])
         assert.deepEqual(results.map(({ response }) => response.status).sort(), [201, 409])
         const created = results.find(({ response }) => response.status === 201).body.data
         assert.equal(created.state, 'active')
         assert.equal(created.userId, studentId)
         assert.equal(created.grantedBy, adminId)
         assert.equal(typeof created.id, 'string')
         const conflict = results.find(({ response }) => response.status === 409)
         assert.equal(conflict.body.error.code, 'ENROLLMENT_ALREADY_EXISTS')
      })

      await t.test('an enrollment alone grants no module content', async () => {
         const modules = await api(port, 'GET', `/api/v1/courses/${main.courseId}/modules`, sessions.student)
         assert.equal(modules.response.status, 200)
         assert.equal(modules.body.data.modules.length, 2)
         for (const module of modules.body.data.modules) {
            assert.deepEqual(module.access, { granted: false, lockReason: 'not_granted' })
         }
         await assert.rejects(
            requireModuleAccessService(studentId, moduleOne),
            { code: 'MODULE_ACCESS_DENIED' },
         )
      })

      await t.test('validates module grant input, course scope and enrollment', async () => {
         const modulesUrl = `${enrollments}/${studentId}/modules`
         const post = (body, url = modulesUrl) => api(port, 'POST', url, sessions.admin, body)
         assert.equal((await post({ moduleId: moduleOne })).response.status, 400)
         assert.equal((await post({ moduleId: 'x', expiresAt: null })).response.status, 400)
         const foreign = await post({ moduleId: second.moduleIds[0], expiresAt: null })
         assert.equal(foreign.response.status, 404)
         assert.equal(foreign.body.error.code, 'COURSE_MODULE_NOT_FOUND')
         const noEnrollment = await post({ moduleId: moduleOne, expiresAt: null }, `${enrollments}/${otherStudentId}/modules`)
         assert.equal(noEnrollment.response.status, 404)
         assert.equal(noEnrollment.body.error.code, 'ENROLLMENT_NOT_FOUND')
         const extra = await api(port, 'POST', `${admin}/${main.courseId}/modules`, sessions.admin, { title: 'Hidden draft' })
         const draftModule = await post({ moduleId: extra.body.data.id, expiresAt: null })
         assert.equal(draftModule.response.status, 409)
         assert.equal(draftModule.body.error.code, 'MODULE_NOT_PUBLISHED')
      })

      await t.test('grants a module separately and exposes it to the learner', async () => {
         const modulesUrl = `${enrollments}/${studentId}/modules`
         const body = { moduleId: moduleOne, expiresAt: future(10) }
         const results = await Promise.all([
            api(port, 'POST', modulesUrl, sessions.admin, body),
            api(port, 'POST', modulesUrl, sessions.admin, body),
         ])
         assert.deepEqual(results.map(({ response }) => response.status).sort(), [201, 409])
         assert.equal(
            results.find(({ response }) => response.status === 409).body.error.code,
            'MODULE_ACCESS_ALREADY_EXISTS',
         )
         await requireModuleAccessService(studentId, moduleOne)
         await assert.rejects(
            requireModuleAccessService(studentId, moduleTwo),
            { code: 'MODULE_ACCESS_DENIED' },
         )
         const modules = await api(port, 'GET', `/api/v1/courses/${main.courseId}/modules`, sessions.student)
         const [first, secondModule] = modules.body.data.modules
         assert.deepEqual(first.access, { granted: true, lockReason: null })
         assert.deepEqual(secondModule.access, { granted: false, lockReason: 'not_granted' })
         assert.deepEqual(Object.keys(secondModule).sort(), [
            'access', 'description', 'id', 'position', 'title', 'translations',
         ])
         assert.equal(modules.body.data.modules.length, 2)
         const list = await api(port, 'GET', modulesUrl, sessions.admin)
         assert.equal(list.body.data.moduleGrants.length, 1)
         assert.equal(list.body.data.moduleGrants[0].state, 'active')
      })

      await t.test('denies cross-course and cross-user access', async () => {
         await assert.rejects(
            requireModuleAccessService(studentId, second.moduleIds[0]),
            { code: 'MODULE_ACCESS_DENIED' },
         )
         await assert.rejects(
            requireModuleAccessService(otherStudentId, moduleOne),
            { code: 'MODULE_ACCESS_DENIED' },
         )
         const hidden = await api(port, 'GET', `/api/v1/courses/${second.courseId}/modules`, sessions.student)
         assert.equal(hidden.response.status, 404)
         const own = await api(port, 'GET', '/api/v1/courses', sessions.student)
         assert.deepEqual(own.body.data.courses.map((course) => course.id), [main.courseId])
         assert.equal(own.body.data.courses[0].enrollment.state, 'active')
      })

      await t.test('requires completed onboarding for protected content', async () => {
         const enrolled = await api(port, 'POST', enrollments, sessions.admin, {
            userId: freshStudentId,
            expiresAt: future(5),
         })
         assert.equal(enrolled.response.status, 201)
         const granted = await api(port, 'POST', `${enrollments}/${freshStudentId}/modules`, sessions.admin, {
            moduleId: moduleOne,
            expiresAt: future(5),
         })
         assert.equal(granted.response.status, 201)
         await assert.rejects(
            requireModuleAccessService(freshStudentId, moduleOne),
            { code: 'MODULE_ACCESS_DENIED' },
         )
         const modules = await api(port, 'GET', `/api/v1/courses/${main.courseId}/modules`, sessions.freshStudent)
         assert.equal(modules.body.data.modules[0].access.lockReason, 'onboarding_required')
      })

      await t.test('extends, expires and renews access while preserving progress', async () => {
         const lesson = await client.query(
            `INSERT INTO lessons (module_id, course_id, title, position, lesson_type, created_by)
             VALUES ($1, $2, 'Fixture lesson', 1, 'text', $3) RETURNING id`,
            [moduleOne, main.courseId, adminId],
         )
         await client.query(
            `INSERT INTO lesson_progress (user_id, lesson_id, status, completed_at)
             VALUES ($1, $2, 'completed', CURRENT_TIMESTAMP)`,
            [studentId, lesson.rows[0].id],
         )
         const progressCount = async () => (await client.query(
            'SELECT count(*)::int AS total FROM lesson_progress WHERE user_id = $1',
            [studentId],
         )).rows[0].total
         const moduleUrl = `${enrollments}/${studentId}/modules/${moduleOne}`

         const past = await api(port, 'PATCH', moduleUrl, sessions.admin, { expiresAt: '2020-01-01T00:00:00Z' })
         assert.equal(past.response.status, 400)
         const extended = await api(port, 'PATCH', moduleUrl, sessions.admin, { expiresAt: future(20) })
         assert.equal(extended.response.status, 200)
         assert.equal(extended.body.data.state, 'active')
         const strict = await api(port, 'PATCH', moduleUrl, sessions.admin, { expiresAt: future(20), beginsAt: future(1) })
         assert.equal(strict.response.status, 400)

         // Expire the module grant (fixture clock change), then renew it.
         await client.query(
            `UPDATE module_access_grants SET begins_at = CURRENT_TIMESTAMP - interval '2 days',
               expires_at = CURRENT_TIMESTAMP - interval '1 day'
             WHERE user_id = $1 AND module_id = $2`,
            [studentId, moduleOne],
         )
         await assert.rejects(requireModuleAccessService(studentId, moduleOne), { code: 'MODULE_ACCESS_DENIED' })
         let modules = await api(port, 'GET', `/api/v1/courses/${main.courseId}/modules`, sessions.student)
         assert.deepEqual(modules.body.data.modules[0].access, { granted: false, lockReason: 'expired' })
         assert.equal(await progressCount(), 1)
         const renewed = await api(port, 'PATCH', moduleUrl, sessions.admin, { expiresAt: future(15) })
         assert.equal(renewed.body.data.state, 'active')
         await requireModuleAccessService(studentId, moduleOne)

         // Expire the enrollment: the still-valid module grant must not grant content.
         await client.query(
            `UPDATE course_enrollments SET begins_at = CURRENT_TIMESTAMP - interval '2 days',
               expires_at = CURRENT_TIMESTAMP - interval '1 day'
             WHERE user_id = $1 AND course_id = $2`,
            [studentId, main.courseId],
         )
         await assert.rejects(requireModuleAccessService(studentId, moduleOne), { code: 'MODULE_ACCESS_DENIED' })
         modules = await api(port, 'GET', `/api/v1/courses/${main.courseId}/modules`, sessions.student)
         assert.equal(modules.body.data.modules[0].access.lockReason, 'expired')
         const own = await api(port, 'GET', '/api/v1/courses', sessions.student)
         assert.equal(own.body.data.courses[0].enrollment.state, 'expired')
         assert.equal(await progressCount(), 1)
         const blockedModuleGrant = await api(port, 'POST', `${enrollments}/${studentId}/modules`, sessions.admin, {
            moduleId: moduleTwo,
            expiresAt: null,
         })
         assert.equal(blockedModuleGrant.body.error.code, 'ENROLLMENT_NOT_ACTIVE')

         const renewedEnrollment = await api(port, 'PATCH', `${enrollments}/${studentId}`, sessions.admin, { expiresAt: future(60) })
         assert.equal(renewedEnrollment.response.status, 200)
         assert.equal(renewedEnrollment.body.data.state, 'active')
         await requireModuleAccessService(studentId, moduleOne)
         assert.equal(await progressCount(), 1)
      })

      await t.test('revokes a module grant and keeps progress and history', async () => {
         const moduleUrl = `${enrollments}/${studentId}/modules/${moduleOne}`
         const revoked = await api(port, 'POST', `${moduleUrl}/revoke`, sessions.admin)
         assert.equal(revoked.response.status, 200)
         assert.equal(revoked.body.data.state, 'revoked')
         assert.equal(revoked.body.data.revokedBy, adminId)
         await assert.rejects(requireModuleAccessService(studentId, moduleOne), { code: 'MODULE_ACCESS_DENIED' })
         const again = await api(port, 'POST', `${moduleUrl}/revoke`, sessions.admin)
         assert.equal(again.body.error.code, 'MODULE_ACCESS_ALREADY_REVOKED')
         const extend = await api(port, 'PATCH', moduleUrl, sessions.admin, { expiresAt: future(5) })
         assert.equal(extend.body.error.code, 'MODULE_ACCESS_REVOKED')
         const modules = await api(port, 'GET', `/api/v1/courses/${main.courseId}/modules`, sessions.student)
         assert.equal(modules.body.data.modules[0].access.lockReason, 'not_granted')
         const regranted = await api(port, 'POST', `${enrollments}/${studentId}/modules`, sessions.admin, {
            moduleId: moduleOne,
            expiresAt: future(5),
         })
         assert.equal(regranted.response.status, 201)
         assert.equal(regranted.body.data.revokedAt, null)
         await requireModuleAccessService(studentId, moduleOne)
         const progress = await client.query('SELECT 1 FROM lesson_progress WHERE user_id = $1', [studentId])
         assert.equal(progress.rowCount, 1)
      })

      await t.test('revoking an enrollment revokes module grants and a re-grant restores none', async () => {
         const second = await api(port, 'POST', `${enrollments}/${studentId}/modules`, sessions.admin, {
            moduleId: moduleTwo,
            expiresAt: null,
         })
         assert.equal(second.response.status, 201)
         const revoked = await api(port, 'POST', `${enrollments}/${studentId}/revoke`, sessions.admin)
         assert.equal(revoked.response.status, 200)
         assert.equal(revoked.body.data.state, 'revoked')
         await assert.rejects(requireModuleAccessService(studentId, moduleOne), { code: 'MODULE_ACCESS_DENIED' })
         await assert.rejects(requireModuleAccessService(studentId, moduleTwo), { code: 'MODULE_ACCESS_DENIED' })
         const left = await client.query(
            'SELECT count(*)::int AS active FROM module_access_grants WHERE user_id = $1 AND revoked_at IS NULL',
            [studentId],
         )
         assert.equal(left.rows[0].active, 0)
         const learner = await api(port, 'GET', `/api/v1/courses/${main.courseId}/modules`, sessions.student)
         assert.equal(learner.response.status, 404)
         assert.deepEqual((await api(port, 'GET', '/api/v1/courses', sessions.student)).body.data.courses, [])
         const again = await api(port, 'POST', `${enrollments}/${studentId}/revoke`, sessions.admin)
         assert.equal(again.body.error.code, 'ENROLLMENT_ALREADY_REVOKED')
         const extend = await api(port, 'PATCH', `${enrollments}/${studentId}`, sessions.admin, { expiresAt: future(5) })
         assert.equal(extend.body.error.code, 'ENROLLMENT_REVOKED')

         const regrant = await api(port, 'POST', enrollments, sessions.admin, { userId: studentId, expiresAt: future(40) })
         assert.equal(regrant.response.status, 201)
         assert.equal(regrant.body.data.state, 'active')
         await assert.rejects(requireModuleAccessService(studentId, moduleOne), { code: 'MODULE_ACCESS_DENIED' })
         await assert.rejects(requireModuleAccessService(studentId, moduleTwo), { code: 'MODULE_ACCESS_DENIED' })
         const progress = await client.query('SELECT 1 FROM lesson_progress WHERE user_id = $1', [studentId])
         assert.equal(progress.rowCount, 1)
      })

      await t.test('unpublished modules and courses are not accessible and a scheduled grant waits', async () => {
         const grant = await api(port, 'POST', `${enrollments}/${studentId}/modules`, sessions.admin, {
            moduleId: moduleOne,
            beginsAt: future(2),
            expiresAt: future(9),
         })
         assert.equal(grant.response.status, 201)
         assert.equal(grant.body.data.state, 'scheduled')
         await assert.rejects(requireModuleAccessService(studentId, moduleOne), { code: 'MODULE_ACCESS_DENIED' })
         let modules = await api(port, 'GET', `/api/v1/courses/${main.courseId}/modules`, sessions.student)
         assert.equal(modules.body.data.modules[0].access.lockReason, 'not_started')
         await client.query(
            `UPDATE module_access_grants SET begins_at = CURRENT_TIMESTAMP - interval '1 hour'
             WHERE user_id = $1 AND module_id = $2`,
            [studentId, moduleOne],
         )
         await requireModuleAccessService(studentId, moduleOne)
         await api(port, 'POST', `${admin}/${main.courseId}/modules/${moduleOne}/archive`, sessions.admin)
         await assert.rejects(requireModuleAccessService(studentId, moduleOne), { code: 'MODULE_ACCESS_DENIED' })
         modules = await api(port, 'GET', `/api/v1/courses/${main.courseId}/modules`, sessions.student)
         assert.equal(modules.body.data.modules.length, 1)
         await api(port, 'POST', `${admin}/${main.courseId}/modules/${moduleOne}/restore`, sessions.admin)
         await api(port, 'POST', `${admin}/${main.courseId}/modules/${moduleOne}/publish`, sessions.admin)
         await requireModuleAccessService(studentId, moduleOne)
         await api(port, 'POST', `${admin}/${main.courseId}/unpublish`, sessions.admin)
         await assert.rejects(requireModuleAccessService(studentId, moduleOne), { code: 'MODULE_ACCESS_DENIED' })
         const hidden = await api(port, 'GET', `/api/v1/courses/${main.courseId}/modules`, sessions.student)
         assert.equal(hidden.response.status, 404)
         await api(port, 'POST', `${admin}/${main.courseId}/publish`, sessions.admin)
         await requireModuleAccessService(studentId, moduleOne)
      })

      await t.test('a blocked account is denied by the database predicate', async () => {
         await client.query("UPDATE users SET status = 'blocked', blocked_at = CURRENT_TIMESTAMP WHERE id = $1", [studentId])
         await assert.rejects(requireModuleAccessService(studentId, moduleOne), { code: 'MODULE_ACCESS_DENIED' })
         await client.query("UPDATE users SET status = 'active', blocked_at = NULL WHERE id = $1", [studentId])
      })

      await t.test('lists enrollments with pagination and a state filter', async () => {
         const list = await api(port, 'GET', `${enrollments}?limit=1`, sessions.admin)
         assert.equal(list.response.status, 200)
         assert.equal(list.body.data.enrollments.length, 1)
         assert.equal(list.body.data.pagination.hasMore, true)
         assert.equal(typeof list.body.data.enrollments[0].user.firstName, 'string')
         const active = await api(port, 'GET', `${enrollments}?state=active`, sessions.admin)
         assert.equal(active.body.data.enrollments.length, 2)
         const revoked = await api(port, 'GET', `${enrollments}?state=revoked`, sessions.admin)
         assert.equal(revoked.body.data.enrollments.length, 0)
         assert.equal((await api(port, 'GET', `${enrollments}?state=bogus`, sessions.admin)).response.status, 400)
         assert.equal((await api(port, 'GET', `${enrollments}?limit=0`, sessions.admin)).response.status, 400)
         assert.equal((await api(port, 'GET', `${admin}/999999999999/enrollments`, sessions.admin)).response.status, 404)
      })

      await t.test('audits each change and rolls back when audit persistence fails', async () => {
         const events = await client.query(
            `SELECT DISTINCT event_code FROM audit_events
             WHERE event_code LIKE 'course.enrollment.%' OR event_code LIKE 'course.module_access.%'`,
         )
         const codes = events.rows.map((row) => row.event_code)
         for (const code of [
            'course.enrollment.granted',
            'course.enrollment.regranted',
            'course.enrollment.extended',
            'course.enrollment.revoked',
            'course.module_access.granted',
            'course.module_access.regranted',
            'course.module_access.extended',
            'course.module_access.revoked',
         ]) {
            assert.ok(codes.includes(code), `missing audit event ${code}`)
         }
         const revokeAudit = await client.query(
            `SELECT metadata FROM audit_events WHERE event_code = 'course.enrollment.revoked'
             AND subject_user_id = $1`,
            [studentId],
         )
         assert.equal(revokeAudit.rows[0].metadata.revokedModuleGrants, 2)

         await assert.rejects(
            grantCourseEnrollmentService(
               adminId,
               second.courseId,
               { userId: otherStudentId, expiresAt: future(3) },
               {
                  auth: { appendAuditEvent: async () => { throw new Error('audit failed') } },
               },
            ),
            /audit failed/,
         )
         const persisted = await client.query(
            'SELECT 1 FROM course_enrollments WHERE user_id = $1 AND course_id = $2',
            [otherStudentId, second.courseId],
         )
         assert.equal(persisted.rowCount, 0)
      })
   } finally {
      await new Promise((resolve) => server.close(resolve))
      await cleanup(client)
      await client.end()
   }
})
