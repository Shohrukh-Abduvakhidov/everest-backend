import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import pg from 'pg'

import env from '../../src/configs/env.js'
import {
   createQuestionBankService,
   createQuestionService,
   publishQuestionService,
   replaceAnswerKeyService,
   verifyAnswerKeyService,
} from '../../src/services/question-bank-service.js'
import { createSubjectService } from '../../src/services/taxonomy-service.js'

// scripts/fix-question-text.js on a bank of its own (--bank), in the disposable test database:
// dry run changes nothing, --apply changes only content and logs the old values, --rollback
// restores them byte for byte.

const { Client } = pg
const suffix = randomUUID().slice(0, 8)
const bankCode = `text-fix-${suffix}`

function runFix(args) {
   return new Promise((resolve) => {
      execFile(process.execPath, ['scripts/fix-question-text.js', ...args], { env: process.env }, (error, stdout, stderr) => {
         resolve({ code: error ? error.code : 0, stdout, stderr })
      })
   })
}

test('fix-question-text: cosmetic rules through dry run, apply and rollback', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   t.after(() => client.end())
   const directory = await mkdtemp(path.join(os.tmpdir(), 'everest-text-fix-'))
   t.after(() => rm(directory, { recursive: true, force: true }))

   const { rows: [admin] } = await client.query(
      `INSERT INTO users (status, onboarding_completed_at) VALUES ('active', CURRENT_TIMESTAMP) RETURNING id`,
   )
   await client.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = 'admin'`, [admin.id])
   const subject = await createSubjectService(admin.id, {
      code: `text-fix-${suffix}`, primaryLanguage: 'tg', translations: { tg: { title: 'Text fix' } },
   })
   const bank = await createQuestionBankService(admin.id, {
      code: bankCode, title: 'Text fix', subjectId: subject.id, visibility: 'staff',
   })
   const text = (value) => ({ blocks: [{ type: 'text', text: value }] })
   const question = await createQuestionService(admin.id, bank.id, {
      questionType: 'single_choice',
      languageCode: 'tg',
      content: {
         blocks: [
            { type: 'text', text: 'Дар раванди реаксияи ²₁H +³₁H  → ⁴₂He+? кадом зарра хориҷ мешавад ?' },
            { type: 'verse', lines: ['Агар бад кунӣ, чашми некӣ мадор,', 'Ки гар хор корӣ, суман надравӣ !'] },
         ],
      },
      options: [
         { key: 'a', content: text('даври 3-юм , гурӯҳи VIA') },
         { key: 'b', content: text('нейтрон') },
         // A dash outside the hyphen-join list is not touched.
         { key: 'c', content: text('Фарзанд- меваи ширин') },
      ],
   })
   await replaceAnswerKeyService(admin.id, question.id, { answerData: { optionKey: 'b' }, source: 'expert_review' })
   await verifyAnswerKeyService(admin.id, question.id, { source: 'expert_review' })
   await publishQuestionService(admin.id, question.id)

   const snapshot = async () => {
      const { rows: [row] } = await client.query(`
         SELECT q.content,
            (SELECT jsonb_agg(jsonb_build_array(o.id, o.option_key, o.position, o.content) ORDER BY o.position)
               FROM question_options o WHERE o.question_id = q.id) AS options,
            (SELECT jsonb_build_array(k.status, k.answer_data, k.verified_at) FROM question_answer_keys k
               WHERE k.question_id = q.id) AS answer_key
         FROM questions q WHERE q.id = $1
      `, [question.id])
      return row
   }
   const original = await snapshot()

   await t.test('dry run is the default and changes nothing', async () => {
      const dryLog = path.join(directory, 'dry.json')
      const result = await runFix(['--bank', bankCode, '--log', dryLog])
      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stderr, /mode: dry-run/)
      assert.match(result.stderr, /Would change: 2 content rows in 1 questions/)
      assert.deepEqual(await snapshot(), original)
      const log = JSON.parse(await readFile(dryLog, 'utf8'))
      assert.equal(log.mode, 'dry-run')
      assert.deepEqual(log.joinNotApplied, [])
      assert.ok(log.review.some((item) => item.type === 'hyphen_line_wrap' && item.path === 'option:c.blocks[0].text'))
   })

   await t.test('--apply needs --log', async () => {
      const result = await runFix(['--apply', '--bank', bankCode])
      assert.equal(result.code, 1)
      assert.deepEqual(await snapshot(), original)
   })

   const applyLog = path.join(directory, 'apply.json')
   await t.test('--apply changes only the content and logs the old values', async () => {
      const result = await runFix(['--apply', '--bank', bankCode, '--log', applyLog])
      assert.equal(result.code, 0, result.stderr)
      const after = await snapshot()
      assert.equal(after.content.blocks[0].text, 'Дар раванди реаксияи ²₁H +³₁H → ⁴₂He+? кадом зарра хориҷ мешавад?')
      assert.deepEqual(after.content.blocks[1].lines, ['Агар бад кунӣ, чашми некӣ мадор,', 'Ки гар хор корӣ, суман надравӣ!'])
      assert.equal(after.options[0][3].blocks[0].text, 'даври 3-юм, гурӯҳи VIA')
      assert.deepEqual(after.options[2], original.options[2])
      // Ids, keys and positions of the options and the answer key are unchanged.
      assert.deepEqual(after.options.map((option) => option.slice(0, 3)), original.options.map((option) => option.slice(0, 3)))
      assert.deepEqual(after.answer_key, original.answer_key)

      const log = JSON.parse(await readFile(applyLog, 'utf8'))
      assert.equal(log.committed, true)
      assert.deepEqual(log.changes.map((change) => change.table).sort(), ['question_options', 'questions'])
      const stem = log.changes.find((change) => change.table === 'questions')
      assert.deepEqual(stem.before, original.content)
      assert.deepEqual(stem.edits.map((edit) => edit.rules), [
         ['collapse_double_space', 'space_before_punctuation'],
         ['space_before_punctuation'],
      ])
      const { rows: events } = await client.query(
         `SELECT metadata FROM audit_events WHERE event_code = 'question.text_repaired' AND metadata->>'questionId' = $1`,
         [String(question.id)],
      )
      assert.equal(events.length, 1)

      // The content guards are on again: a published question cannot be edited directly.
      await assert.rejects(client.query(`UPDATE questions SET content = '{"blocks":[]}' WHERE id = $1`, [question.id]))
      // A second run finds nothing more to change.
      const again = await runFix(['--apply', '--bank', bankCode, '--log', path.join(directory, 'again.json')])
      assert.equal(again.code, 0, again.stderr)
      assert.match(again.stderr, /Changed: 0 content rows/)
   })

   await t.test('--rollback restores the old values once', async () => {
      const result = await runFix(['--rollback', applyLog])
      assert.equal(result.code, 0, result.stderr)
      assert.deepEqual(await snapshot(), original)
      const second = await runFix(['--rollback', applyLog])
      assert.equal(second.code, 1, 'the rows no longer hold the fixed values')
      assert.deepEqual(await snapshot(), original)
   })
})
