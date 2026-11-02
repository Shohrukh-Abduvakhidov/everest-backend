import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import pg from 'pg'

import env from '../../src/configs/env.js'

const { Client } = pg
const seedPassword = 'SeedSmoke2026pass'

function run(args, databaseName, extraEnv = {}) {
   return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
         cwd: process.cwd(),
         env: { ...process.env, DB_NAME: databaseName, ...extraEnv },
         stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      child.stdout.on('data', (chunk) => { output += chunk })
      child.stderr.on('data', (chunk) => { output += chunk })
      child.once('error', reject)
      child.once('exit', (code) => resolve({ code, output }))
   })
}

async function counts(databaseName) {
   const client = new Client({ ...env.database, database: databaseName })
   await client.connect()
   try {
      const scalar = async (sql) => Number((await client.query(sql)).rows[0].count)
      return {
         users: await scalar(`SELECT count(*) FROM user_phones WHERE phone_e164 LIKE '+9929000000%'`),
         owners: await scalar(`SELECT count(*) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.code = 'owner'`),
         admins: await scalar(`SELECT count(*) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.code = 'admin'`),
         teachers: await scalar(`SELECT count(*) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.code = 'teacher'`),
         activeUsers: await scalar(`SELECT count(*) FROM users WHERE status = 'active' AND onboarding_completed_at IS NOT NULL`),
         subjects: await scalar(`SELECT count(*) FROM subjects`),
         publishedCourses: await scalar(`SELECT count(*) FROM courses WHERE status = 'published'`),
         draftCourses: await scalar(`SELECT count(*) FROM courses WHERE status = 'draft'`),
         modules: await scalar(`SELECT count(*) FROM course_modules WHERE status = 'published'`),
         lessons: await scalar(`SELECT count(*) FROM lessons WHERE status = 'published'`),
         groups: await scalar(`SELECT count(*) FROM groups`),
         members: await scalar(`SELECT count(*) FROM group_members WHERE status = 'active'`),
         groupTeachers: await scalar(`SELECT count(*) FROM group_teachers`),
         announcements: await scalar(`SELECT count(*) FROM group_announcements WHERE status = 'published'`),
         banks: await scalar(`SELECT count(*) FROM question_banks`),
         publishedQuestions: await scalar(`SELECT count(*) FROM questions WHERE status = 'published'`),
         questionTypes: await scalar(`SELECT count(DISTINCT question_type) FROM questions WHERE status = 'published'`),
         verifiedKeys: await scalar(`SELECT count(*) FROM question_answer_keys WHERE status = 'verified'`),
         enrollments: await scalar(`SELECT count(*) FROM course_enrollments`),
         moduleGrants: await scalar(`SELECT count(*) FROM module_access_grants`),
      }
   } finally {
      await client.end()
   }
}

test('demo seed is idempotent and refuses unsafe targets', async (t) => {
   const databaseName = `everest_test_seed_${randomUUID().replaceAll('-', '').slice(0, 10)}`
   assert.match(databaseName, /^everest_test_seed_[a-f0-9]{10}$/)
   const maintenance = new Client({ ...env.database, database: 'postgres' })
   await maintenance.connect()
   await maintenance.query(`CREATE DATABASE "${databaseName}"`)
   try {
      const migrated = await run(['src/configs/migrate.js', 'up'], databaseName)
      assert.equal(migrated.code, 0, migrated.output)

      await t.test('refuses production and unnamed-safe databases without running', async () => {
         const production = await run(['scripts/seed-demo.js'], databaseName, { NODE_ENV: 'production' })
         assert.equal(production.code, 1)
         assert.match(production.output, /NODE_ENV is production/)
         const forcedProduction = await run(['scripts/seed-demo.js', '--force'], databaseName, { NODE_ENV: 'production' })
         assert.equal(forcedProduction.code, 1)
         assert.match(forcedProduction.output, /NODE_ENV is production/)
         const unsafe = await run(['scripts/seed-demo.js'], 'everest_main')
         assert.equal(unsafe.code, 1)
         assert.match(unsafe.output, /does not contain dev, test or demo/)
         assert.deepEqual((await counts(databaseName)).users, 0)
      })

      await t.test('first run creates the data, second run changes nothing', async () => {
         const first = await run(['scripts/seed-demo.js', '--password', seedPassword], databaseName)
         assert.equal(first.code, 0, first.output)
         assert.match(first.output, /newly created accounts use the password you supplied/)
         assert.ok(!first.output.includes(seedPassword), 'a supplied password is not echoed')
         const afterFirst = await counts(databaseName)
         assert.deepEqual(afterFirst, {
            users: 8,
            owners: 1,
            admins: 1,
            teachers: 1,
            activeUsers: 8,
            subjects: 2,
            publishedCourses: 1,
            draftCourses: 1,
            modules: 2,
            lessons: 6,
            groups: 1,
            members: 3,
            groupTeachers: 1,
            announcements: 2,
            banks: 1,
            publishedQuestions: 5,
            questionTypes: 5,
            verifiedKeys: 5,
            enrollments: 2,
            moduleGrants: 4,
         })

         const second = await run(['scripts/seed-demo.js', '--password', seedPassword], databaseName)
         assert.equal(second.code, 0, second.output)
         assert.deepEqual(await counts(databaseName), afterFirst)
      })
   } finally {
      await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
      await maintenance.end()
   }
})
