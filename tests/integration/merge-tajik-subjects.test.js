import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import test from 'node:test'

import pg from 'pg'

import env from '../../src/configs/env.js'
import { up } from '../../src/migrations/20261109010000000_merge-tajik-subjects.js'
import { dryRunQuestionImportService } from '../../src/services/question-import-service.js'
import { loadQuestionPackage } from '../../src/utils/question-package.js'
import { createPng, entityPackage, writePackageDirectory } from '../helpers/import-fixtures.js'

const { Client } = pg
const suffix = randomUUID().slice(0, 8)

function migrationSql() {
   let sql
   up({ sql: (text) => { sql = text } })
   return sql
}

async function createAdmin(client) {
   const user = await client.query(
      `INSERT INTO users (status, onboarding_completed_at) VALUES ('active', CURRENT_TIMESTAMP) RETURNING id`,
   )
   const userId = user.rows[0].id
   await client.query(
      `INSERT INTO user_profiles (user_id, first_name, last_name) VALUES ($1, 'Merge', 'Subjects')`,
      [userId],
   )
   await client.query(
      `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = 'admin'`,
      [userId],
   )
   return userId
}

async function subjectId(client, code) {
   return (await client.query('SELECT id FROM subjects WHERE code = $1', [code])).rows[0]?.id ?? null
}

// Every row that references either subject, per table, plus the subject rows themselves.
async function snapshot(client, keep, drop) {
   const tables = (await client.query(
      `SELECT c.table_name FROM information_schema.columns AS c
       JOIN information_schema.tables AS t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
       WHERE c.table_schema = current_schema() AND c.column_name = 'subject_id'
       ORDER BY 1`,
   )).rows.map((row) => row.table_name)
   const counts = {}
   for (const table of tables) {
      const rows = (await client.query(
         `SELECT subject_id::text AS id, count(*)::integer AS total FROM ${table}
          WHERE subject_id = ANY($1::bigint[]) GROUP BY 1`,
         [[keep, drop]],
      )).rows
      counts[table] = Object.fromEntries(rows.map((row) => [row.id === String(keep) ? 'keep' : 'drop', row.total]))
   }
   const subjects = (await client.query(
      `SELECT s.code, s.color, json_object_agg(t.language_code, t.title ORDER BY t.language_code)
          FILTER (WHERE t.language_code IS NOT NULL) AS titles
       FROM subjects AS s LEFT JOIN subject_translations AS t ON t.subject_id = s.id
       WHERE s.id = ANY($1::bigint[]) GROUP BY s.id ORDER BY s.code`,
      [[keep, drop]],
   )).rows
   return { counts, subjects }
}

test('merge of the tajik_language subject into zaboni-tochiki', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   const directories = []
   let adminId
   try {
      adminId = await createAdmin(client)

      await t.test('moves every reference, keeps canonical values and is a no-op when repeated', async () => {
         await client.query('BEGIN')
         try {
            const keep = (await client.query(
               `INSERT INTO subjects (code, color) VALUES ('zaboni-tochiki', 'neutral') RETURNING id`,
            )).rows[0].id
            const drop = (await client.query(
               `INSERT INTO subjects (code, color) VALUES ('tajik_language', 'orange') RETURNING id`,
            )).rows[0].id
            await client.query(
               `INSERT INTO subject_translations (subject_id, language_code, title)
                VALUES ($1, 'tg', 'Забони Точики'), ($2, 'tg', 'Забони тоҷикӣ'), ($2, 'ru', 'Таджикский язык')`,
               [keep, drop],
            )
            const bank = (await client.query(
               `INSERT INTO question_banks (code, title, subject_id, owner_id) VALUES ($1, 'Tajik', $2, $3) RETURNING id`,
               [`merge-${suffix}`, drop, adminId],
            )).rows[0].id
            const section = (await client.query(
               `INSERT INTO sections (subject_id, code) VALUES ($1, 'syntax') RETURNING id`, [drop],
            )).rows[0].id
            const parent = (await client.query(
               `INSERT INTO topics (subject_id, section_id, code) VALUES ($1, $2, 'morphology') RETURNING id`,
               [drop, section],
            )).rows[0].id
            const topic = (await client.query(
               `INSERT INTO topics (subject_id, section_id, parent_id, code) VALUES ($1, $2, $3, 'verbs') RETURNING id`,
               [drop, section, parent],
            )).rows[0].id
            await client.query(
               `INSERT INTO topics (subject_id, code) VALUES ($1, 'keep-only')`, [keep],
            )
            await client.query(
               `INSERT INTO courses (subject_id, title, created_by) VALUES ($1, 'Tajik course', $2)`, [drop, adminId],
            )
            const questionIds = []
            for (const index of [1, 2, 3]) {
               const question = (await client.query(
                  `INSERT INTO questions (bank_id, subject_id, external_id, question_type, language_code, created_by)
                   VALUES ($1, $2, $3, 'numeric', 'tg', $4) RETURNING id`,
                  [bank, drop, `q-${index}`, adminId],
               )).rows[0].id
               questionIds.push(question)
               await client.query(
                  `INSERT INTO question_topics (question_id, topic_id, subject_id) VALUES ($1, $2, $3)`,
                  [question, index === 1 ? parent : topic, drop],
               )
               await client.query(
                  `INSERT INTO question_answer_keys (question_id, status, source, answer_data, verified_by, verified_at)
                   VALUES ($1, 'verified', 'official_key', '{"value": 1}', $2, CURRENT_TIMESTAMP)`,
                  [question, adminId],
               )
            }
            // Two published questions exercise the immutability guards; one stays a draft.
            await client.query(
               `UPDATE questions SET status = 'published' WHERE id = ANY($1::bigint[])`, [questionIds.slice(0, 2)],
            )

            const before = await snapshot(client, keep, drop)
            assert.deepEqual(before.counts.questions, { drop: 3 })

            await client.query(migrationSql())

            const after = await snapshot(client, keep, drop)
            assert.equal(await subjectId(client, 'tajik_language'), null)
            assert.deepEqual(after.counts, {
               courses: { keep: 1 },
               question_banks: { keep: 1 },
               question_topics: { keep: 3 },
               questions: { keep: 3 },
               sections: { keep: 1 },
               subject_translations: { keep: 2 },
               topics: { keep: 3 },
            })
            // The canonical tg title stays; the missing ru title and the non-neutral color move over.
            assert.deepEqual(after.subjects, [{
               code: 'zaboni-tochiki',
               color: 'orange',
               titles: { ru: 'Таджикский язык', tg: 'Забони Точики' },
            }])
            const published = (await client.query(
               `SELECT count(*)::integer AS total FROM questions WHERE subject_id = $1 AND status = 'published'`, [keep],
            )).rows[0].total
            assert.equal(published, 2)
            const guards = (await client.query(
               `SELECT tgname, tgenabled FROM pg_trigger
                WHERE tgname IN ('questions_guard', 'question_topics_guard') ORDER BY 1`,
            )).rows
            assert.deepEqual(guards.map((row) => row.tgenabled), ['O', 'O'])
            await assert.rejects(
               client.query(`UPDATE questions SET difficulty = 1, difficulty_source = 'expert' WHERE id = $1`, [questionIds[0]]),
               /QUESTION_IMMUTABLE/,
            )
         } finally {
            await client.query('ROLLBACK')
         }
      })

      await t.test('repeated run and a missing subject change nothing', async () => {
         await client.query('BEGIN')
         try {
            const keep = (await client.query(
               `INSERT INTO subjects (code) VALUES ('zaboni-tochiki') RETURNING id`,
            )).rows[0].id
            const drop = (await client.query(
               `INSERT INTO subjects (code) VALUES ('tajik_language') RETURNING id`,
            )).rows[0].id
            const bank = (await client.query(
               `INSERT INTO question_banks (code, title, subject_id, owner_id) VALUES ($1, 'Tajik', $2, $3) RETURNING id`,
               [`merge2-${suffix}`, drop, adminId],
            )).rows[0].id
            await client.query(
               `INSERT INTO questions (bank_id, subject_id, question_type, language_code, created_by)
                VALUES ($1, $2, 'numeric', 'tg', $3)`,
               [bank, drop, adminId],
            )
            await client.query(migrationSql())
            const first = await snapshot(client, keep, drop)
            await client.query(migrationSql())
            assert.deepEqual(await snapshot(client, keep, drop), first)
            assert.deepEqual(first.counts.questions, { keep: 1 })

            // Only the duplicate exists: nothing to merge, nothing removed.
            await client.query(`UPDATE subjects SET code = 'zaboni-tochiki-old' WHERE id = $1`, [keep])
            const lone = (await client.query(
               `INSERT INTO subjects (code) VALUES ('tajik_language') RETURNING id`,
            )).rows[0].id
            await client.query(migrationSql())
            assert.equal(await subjectId(client, 'tajik_language'), lone)
         } finally {
            await client.query('ROLLBACK')
         }
      })

      await t.test('section or topic codes in both subjects stop the merge', async () => {
         await client.query('BEGIN')
         try {
            const keep = (await client.query(`INSERT INTO subjects (code) VALUES ('zaboni-tochiki') RETURNING id`)).rows[0].id
            const drop = (await client.query(`INSERT INTO subjects (code) VALUES ('tajik_language') RETURNING id`)).rows[0].id
            await client.query(`INSERT INTO topics (subject_id, code) VALUES ($1, 'syntax'), ($2, 'syntax')`, [keep, drop])
            await assert.rejects(client.query(migrationSql()), /TAJIK_SUBJECT_MERGE_CONFLICT: codes exist in both subjects: topic syntax/)
         } finally {
            await client.query('ROLLBACK')
         }
      })

      await t.test('an import that names tajik_language resolves to zaboni-tochiki', async () => {
         await client.query(`INSERT INTO subjects (code, color) VALUES ('zaboni-tochiki', 'orange')`)
         try {
            const { manifest, files } = entityPackage({
               subjectCode: 'tajik_language',
               bankCode: `alias-${suffix}`,
               namespace: `alias:${suffix}`,
               png: createPng(3, 2, 9),
            })
            const directory = await writePackageDirectory(manifest, files)
            directories.push(directory)
            const report = await dryRunQuestionImportService(adminId, await loadQuestionPackage(directory))
            assert.equal(report.valid, true, JSON.stringify(report.errors))
            assert.equal(report.counters.subjects.created, 0)
            assert.ok(report.warnings.some((entry) => entry.code === 'SUBJECT_CODE_ALIASED'), JSON.stringify(report.warnings))
            assert.equal(await subjectId(client, 'tajik_language'), null)
         } finally {
            await client.query(`DELETE FROM subjects WHERE code = 'zaboni-tochiki'`)
         }
      })
   } finally {
      for (const directory of directories) await rm(directory, { recursive: true, force: true })
      if (adminId) {
         await client.query('DELETE FROM user_roles WHERE user_id = $1', [adminId])
         await client.query('DELETE FROM user_profiles WHERE user_id = $1', [adminId])
         await client.query('DELETE FROM users WHERE id = $1', [adminId])
      }
      await client.end()
   }
})
