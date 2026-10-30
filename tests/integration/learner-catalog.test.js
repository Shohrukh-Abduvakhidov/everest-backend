import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import pg from 'pg'

import { createApp } from '../../src/app.js'
import env from '../../src/configs/env.js'
import { withTransaction } from '../../src/repositories/transaction-repository.js'
import { issueSessionService } from '../../src/services/auth/session-service.js'

const { Client } = pg
const userIds = []
const suffix = randomUUID().slice(0, 8)
const config = {
   ...env,
   jwtAccessSecret: 'learner-catalog-integration-secret-longer-than-32-chars',
   authSessionTtlSeconds: 900,
   authRefreshTtlSeconds: 86400,
   authAdminRateLimit: 1000,
}

async function createUser(client, role, name) {
   const user = await client.query(
      `INSERT INTO users (status, onboarding_completed_at)
       VALUES ('active', CURRENT_TIMESTAMP) RETURNING id`,
   )
   const userId = user.rows[0].id
   userIds.push(userId)
   await client.query(
      `INSERT INTO user_profiles (user_id, first_name, last_name) VALUES ($1, $2, 'M07C')`,
      [userId, name],
   )
   await client.query(
      'INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2',
      [userId, role],
   )
   return userId
}

async function issue(userId) {
   return withTransaction((client) => issueSessionService({
      userId,
      requestContext: { userAgent: 'M07C integration', ipAddress: '127.0.0.1' },
      client,
   }, { config }))
}

async function listen(app) {
   return new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
   })
}

async function cleanup(client) {
   if (!userIds.length) return
   const courses = 'SELECT id FROM courses WHERE created_by = ANY($1::bigint[])'
   await client.query(`DELETE FROM lessons WHERE course_id IN (${courses})`, [userIds])
   await client.query(`DELETE FROM course_enrollments WHERE course_id IN (${courses})`, [userIds])
   await client.query(`DELETE FROM course_modules WHERE course_id IN (${courses})`, [userIds])
   await client.query('DELETE FROM courses WHERE created_by = ANY($1::bigint[])', [userIds])
   const subjects = `SELECT id FROM subjects WHERE code LIKE '%-${suffix}'`
   await client.query(`DELETE FROM subject_translations WHERE subject_id IN (${subjects})`)
   await client.query(`DELETE FROM subjects WHERE code LIKE '%-${suffix}'`)
   await client.query('DELETE FROM auth_identities WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM audit_events WHERE actor_user_id = ANY($1::bigint[]) OR subject_user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM auth_refresh_tokens WHERE session_id IN (SELECT id FROM auth_sessions WHERE user_id = ANY($1::bigint[]))', [userIds])
   await client.query('DELETE FROM auth_sessions WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM user_roles WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM user_profiles WHERE user_id = ANY($1::bigint[])', [userIds])
   await client.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [userIds])
}

test('learner catalog subject, counts and profile telegram flag integration', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   const server = await listen(createApp({ authProtection: { config }, telegramAuth: { config } }))
   const port = server.address().port

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

   t.after(async () => {
      await new Promise((resolve) => server.close(resolve))
      await cleanup(client)
      await client.end()
   })

   const adminId = await createUser(client, 'admin', 'Admin')
   const studentId = await createUser(client, 'student', 'Student')
   const admin = await issue(adminId)
   const student = await issue(studentId)

   let subject
   await t.test('subject color uses the fixed palette with a neutral default', async () => {
      const created = await api('POST', '/admin/subjects', admin, {
         code: `chem-${suffix}`, translations: { tg: { title: 'Химия' }, ru: { title: 'Химия RU' } },
      })
      assert.equal(created.status, 201, JSON.stringify(created.body))
      assert.equal(created.body.data.color, 'neutral')
      const invalid = await api('PATCH', `/admin/subjects/${created.body.data.id}`, admin, { color: '#00ff00' })
      assert.equal(invalid.status, 400)
      assert.equal(invalid.body.error.code, 'VALIDATION_ERROR')
      const updated = await api('PATCH', `/admin/subjects/${created.body.data.id}`, admin, { color: 'green' })
      assert.equal(updated.status, 200)
      assert.equal(updated.body.data.color, 'green')
      const bad = await api('POST', '/admin/subjects', admin, {
         code: `bad-${suffix}`, color: 'red', translations: { tg: { title: 'X' } },
      })
      assert.equal(bad.status, 400)
      await assert.rejects(
         client.query("UPDATE subjects SET color = 'red' WHERE id = $1", [created.body.data.id]),
         (error) => error.constraint === 'subjects_color_check',
      )
      subject = updated.body.data
   })

   await t.test('course cards include subject and learner-visible counts', async () => {
      const insertCourse = async (title, subjectId) => (await client.query(
         `INSERT INTO courses (title, subject_id, status, created_by)
          VALUES ($1, $2, 'published', $3) RETURNING id`,
         [title, subjectId, adminId],
      )).rows[0].id
      const insertModule = async (courseId, position, status) => (await client.query(
         `INSERT INTO course_modules (course_id, title, position, status)
          VALUES ($1, $2, $3, $4) RETURNING id`,
         [courseId, `Module ${position}`, position, status],
      )).rows[0].id
      const insertLesson = async (courseId, moduleId, position, status) => client.query(
         `INSERT INTO lessons (module_id, course_id, title, position, lesson_type, status, created_by)
          VALUES ($1, $2, $3, $4, 'text', $5, $6)`,
         [moduleId, courseId, `Lesson ${position}`, position, status, adminId],
      )
      const courseId = await insertCourse(`M07C A ${suffix}`, subject.id)
      const published = await insertModule(courseId, 1, 'published')
      const locked = await insertModule(courseId, 2, 'published')
      const draft = await insertModule(courseId, 3, 'draft')
      await insertModule(courseId, 4, 'archived')
      await insertLesson(courseId, published, 1, 'published')
      await insertLesson(courseId, published, 2, 'published')
      await insertLesson(courseId, published, 3, 'draft')
      await insertLesson(courseId, published, 4, 'archived')
      await insertLesson(courseId, locked, 1, 'published')
      await insertLesson(courseId, draft, 1, 'published')
      const plainId = await insertCourse(`M07C B ${suffix}`, null)
      for (const id of [courseId, plainId]) {
         await client.query(
            `INSERT INTO course_enrollments (user_id, course_id, granted_by, begins_at)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP - INTERVAL '1 hour')`,
            [studentId, id, adminId],
         )
      }

      const list = await api('GET', '/courses', student)
      assert.equal(list.status, 200, JSON.stringify(list.body))
      const card = list.body.data.courses.find((course) => course.id === courseId)
      assert.deepEqual(card.subject, {
         id: subject.id,
         title: 'Химия',
         translations: { tg: { title: 'Химия' }, ru: { title: 'Химия RU' } },
         color: 'green',
      })
      assert.equal(card.moduleCount, 2)
      assert.equal(card.lessonCount, 3)
      const plain = list.body.data.courses.find((course) => course.id === plainId)
      assert.equal(plain.subject, null)
      assert.equal(plain.moduleCount, 0)
      assert.equal(plain.lessonCount, 0)
      assert.equal(Object.hasOwn(card, 'testCount'), false)
      assert.equal(Object.hasOwn(card, 'code'), false)

      const detail = await api('GET', `/courses/${courseId}/modules`, student)
      assert.equal(detail.status, 200, JSON.stringify(detail.body))
      assert.deepEqual(detail.body.data.course.subject, card.subject)
      assert.equal(detail.body.data.course.moduleCount, 2)
      assert.equal(detail.body.data.course.lessonCount, 3)
   })

   await t.test('profile reports whether Telegram is linked without identity details', async () => {
      const before = await api('GET', '/profile', student)
      assert.equal(before.status, 200, JSON.stringify(before.body))
      assert.equal(before.body.data.telegramLinked, false)
      await client.query(
         `INSERT INTO auth_identities (user_id, provider, issuer, provider_subject)
          VALUES ($1, 'telegram', 'https://oauth.telegram.org', $2)`,
         [studentId, `m07c-${suffix}`],
      )
      const after = await api('GET', '/profile', student)
      assert.equal(after.body.data.telegramLinked, true)
      assert.equal(JSON.stringify(after.body).includes(`m07c-${suffix}`), false)
   })
})
