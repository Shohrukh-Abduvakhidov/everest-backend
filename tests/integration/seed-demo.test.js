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

const accessState = (table) => `CASE
   WHEN ${table}.revoked_at IS NOT NULL THEN 'revoked'
   WHEN ${table}.begins_at > CURRENT_TIMESTAMP THEN 'scheduled'
   WHEN ${table}.expires_at IS NOT NULL AND ${table}.expires_at <= CURRENT_TIMESTAMP THEN 'expired'
   ELSE 'active' END`
const assignmentWindow = `CASE
   WHEN opens_at > CURRENT_TIMESTAMP THEN 'upcoming'
   WHEN closes_at IS NOT NULL AND closes_at < CURRENT_TIMESTAMP THEN 'closed'
   ELSE 'open' END`

async function counts(databaseName) {
   const client = new Client({ ...env.database, database: databaseName })
   await client.connect()
   try {
      const scalar = async (sql) => Number((await client.query(sql)).rows[0].count)
      const distribution = async (sql) => Object.fromEntries(
         (await client.query(sql)).rows.map((row) => [row.state, Number(row.count)]),
      )
      const role = (code) => scalar(`SELECT count(*) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.code = '${code}'`)
      return {
         users: await scalar(`SELECT count(*) FROM user_phones WHERE phone_e164 LIKE '+9929000000%'`),
         owners: await role('owner'),
         admins: await role('admin'),
         teachers: await role('teacher'),
         userStatuses: await distribution(`SELECT status AS state, count(*) FROM users GROUP BY status`),
         onboardedUsers: await scalar(`SELECT count(*) FROM users WHERE status = 'active' AND onboarding_completed_at IS NOT NULL`),
         subjects: await scalar(`SELECT count(*) FROM subjects`),
         subjectColors: await scalar(`SELECT count(DISTINCT color) FROM subjects`),
         sections: await scalar(`SELECT count(*) FROM sections`),
         topics: await scalar(`SELECT count(*) FROM topics`),
         nestedTopics: await scalar(`SELECT count(*) FROM topics WHERE parent_id IS NOT NULL`),
         minTopicsPerSubject: await scalar(`SELECT min(total) AS count FROM (SELECT count(*) AS total FROM topics GROUP BY subject_id) AS per_subject`),
         courses: await distribution(`SELECT status AS state, count(*) FROM courses GROUP BY status`),
         courseTeachers: await scalar(`SELECT count(*) FROM course_teachers`),
         modules: await distribution(`SELECT status AS state, count(*) FROM course_modules GROUP BY status`),
         lessons: await distribution(`SELECT lesson_type || '/' || status AS state, count(*) FROM lessons GROUP BY 1`),
         linkedLessons: await scalar(`SELECT count(*) FROM lessons l JOIN tests t ON t.id = l.test_id WHERE l.status = 'published' AND t.status = 'published'`),
         groups: await distribution(`SELECT status AS state, count(*) FROM groups GROUP BY status`),
         members: await scalar(`SELECT count(*) FROM group_members WHERE status = 'active'`),
         representatives: await scalar(`SELECT count(*) FROM group_members WHERE is_representative`),
         groupTeachers: await scalar(`SELECT count(*) FROM group_teachers`),
         announcements: await distribution(`SELECT status || CASE WHEN is_pinned THEN '/pinned' ELSE '' END AS state, count(*) FROM group_announcements GROUP BY 1`),
         banks: await distribution(`SELECT visibility AS state, count(*) FROM question_banks GROUP BY visibility`),
         questions: await distribution(`SELECT status AS state, count(*) FROM questions GROUP BY status`),
         publishedPerBank: await scalar(`SELECT min(total) AS count FROM (SELECT count(*) AS total FROM questions WHERE status = 'published' GROUP BY bank_id) AS per_bank`),
         publishedTypes: await scalar(`SELECT count(DISTINCT question_type) FROM questions WHERE status = 'published'`),
         questionLanguages: await distribution(`SELECT language_code AS state, count(*) FROM questions GROUP BY language_code`),
         difficulties: await scalar(`SELECT count(DISTINCT difficulty) FROM questions WHERE status = 'published'`),
         publishedMatching: await scalar(`SELECT count(*) FROM questions WHERE question_type = 'matching' AND status = 'published'`),
         matchingWithRules: await scalar(`SELECT count(*) FROM questions WHERE question_type = 'matching' AND status = 'published' AND interaction_settings ? 'requireAllLeft' AND interaction_settings ? 'allowRightReuse'`),
         topicLinks: await scalar(`SELECT count(*) FROM question_topics`),
         verifiedKeys: await scalar(`SELECT count(*) FROM question_answer_keys WHERE status = 'verified'`),
         draftsWithKeys: await scalar(`SELECT count(*) FROM questions q JOIN question_answer_keys k ON k.question_id = q.id WHERE q.status = 'draft' AND k.status <> 'unknown'`),
         publishedWithoutVerifiedKey: await scalar(`SELECT count(*) FROM questions q LEFT JOIN question_answer_keys k ON k.question_id = q.id AND k.status = 'verified' WHERE q.status <> 'draft' AND k.question_id IS NULL`),
         tests: await distribution(`SELECT status AS state, count(*) FROM tests GROUP BY status`),
         testQuestions: await scalar(`SELECT count(*) FROM test_questions`),
         groupAssignments: await scalar(`SELECT count(*) FROM test_assignments WHERE group_id IS NOT NULL AND status = 'active'`),
         userAssignments: await scalar(`SELECT count(*) FROM test_assignments WHERE user_id IS NOT NULL AND status = 'active'`),
         attempts: await distribution(`SELECT status AS state, count(*) FROM test_attempts GROUP BY status`),
         assignmentWindows: await distribution(`SELECT ${assignmentWindow} AS state, count(*) FROM test_assignments GROUP BY 1`),
         enrollmentStates: await distribution(`SELECT ${accessState('course_enrollments')} AS state, count(*) FROM course_enrollments GROUP BY 1`),
         moduleGrantStates: await distribution(`SELECT ${accessState('module_access_grants')} AS state, count(*) FROM module_access_grants GROUP BY 1`),
         fullAccessStudent: await scalar(`SELECT count(*) FROM course_enrollments e JOIN courses c ON c.id = e.course_id JOIN user_phones p ON p.user_id = e.user_id WHERE p.phone_e164 = '+992900000004' AND c.title = 'Биология 9 класс' AND e.revoked_at IS NULL AND e.expires_at IS NULL AND e.begins_at <= CURRENT_TIMESTAMP`),
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
            users: 26,
            owners: 1,
            admins: 1,
            teachers: 3,
            userStatuses: { active: 22, pending: 2, blocked: 1, rejected: 1 },
            onboardedUsers: 22,
            subjects: 5,
            subjectColors: 5,
            sections: 15,
            topics: 50,
            nestedTopics: 12,
            minTopicsPerSubject: 9,
            courses: { published: 5, draft: 1 },
            courseTeachers: 7,
            modules: { published: 12, draft: 1, archived: 1 },
            lessons: { 'text/published': 32, 'mixed/published': 4, 'text/draft': 2, 'video/draft': 9, 'test/published': 4 },
            linkedLessons: 4,
            groups: { active: 2, archived: 1 },
            members: 14,
            representatives: 3,
            groupTeachers: 4,
            announcements: { draft: 3, published: 4, 'published/pinned': 3, archived: 1 },
            banks: { staff: 4, private: 1 },
            questions: { published: 145, draft: 25, archived: 15 },
            publishedPerBank: 28,
            publishedTypes: 5,
            questionLanguages: { ru: 160, tg: 20, en: 5 },
            difficulties: 5,
            publishedMatching: 16,
            matchingWithRules: 16,
            topicLinks: 180,
            verifiedKeys: 160,
            draftsWithKeys: 0,
            publishedWithoutVerifiedKey: 0,
            tests: { published: 5, draft: 1, archived: 1 },
            testQuestions: 66,
            groupAssignments: 5,
            userAssignments: 6,
            attempts: { graded: 1, in_progress: 1 },
            assignmentWindows: { open: 7, upcoming: 2, closed: 2 },
            enrollmentStates: { active: 8, scheduled: 2, expired: 1, revoked: 1 },
            moduleGrantStates: { active: 17, scheduled: 1, expired: 1, revoked: 3 },
            fullAccessStudent: 1,
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
