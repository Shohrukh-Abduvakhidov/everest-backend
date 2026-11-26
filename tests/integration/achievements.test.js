import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import pg from 'pg'

import env from '../../src/configs/env.js'
import {
   backfillAchievementsService,
   evaluateUserAchievementsService,
   getMyAchievementsService,
   getStaffStudentAchievementsService,
   markAchievementsSeenService,
   runRankingSnapshotService,
   scheduleAchievementJobsService,
} from '../../src/services/achievement-service.js'
import { addGroupMemberService, createGroupService } from '../../src/services/group-service.js'
import { getNotificationSettingsService } from '../../src/services/notification-settings-service.js'
import { runNotificationFanoutService } from '../../src/services/notification-service.js'
import { getStudentHomeService } from '../../src/services/student-home-service.js'
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

// Thursday 26 Nov 2026; the finished week is Mon 16 Nov to Mon 23 Nov (Asia/Dushanbe).
const now = at('2026-11-26T10:00:00Z')
const previousWeek = {
   periodKind: 'week',
   periodStart: '2026-11-16',
   startAt: '2026-11-15T19:00:00.000Z',
   endAt: '2026-11-22T19:00:00.000Z',
}

test('M13 achievements: evaluation, awards once, notification, reads, seen, snapshots, backfill', async (t) => {
   const client = new Client(env.database)
   await client.connect()
   t.after(() => client.end())

   async function createUser(role, firstName, status = 'active') {
      const { rows } = await client.query(
         `INSERT INTO users (status, onboarding_completed_at, blocked_at)
          VALUES ($1::varchar, CURRENT_TIMESTAMP, CASE WHEN $1::varchar = 'blocked' THEN CURRENT_TIMESTAMP END) RETURNING id`,
         [status],
      )
      await client.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2', [rows[0].id, role])
      await client.query('INSERT INTO user_profiles (user_id, first_name, last_name) VALUES ($1, $2, $3)', [
         rows[0].id, firstName, `A${suffix}`,
      ])
      return String(rows[0].id)
   }

   const adminId = await createUser('admin', 'Admin')
   const students = []
   for (let index = 1; index <= 5; index += 1) students.push(await createUser('student', `S${index}`))
   const [s1, s2, s3, s4, s5] = students
   const stranger = await createUser('teacher', 'Stranger')
   const blocked = await createUser('student', 'Blocked', 'blocked')

   const group = await createGroupService(adminId, { name: `Achievements ${suffix}` })
   for (const userId of students) await addGroupMemberService(adminId, group.id, { userId })
   await client.query('UPDATE group_members SET joined_at = $2 WHERE group_id = $1', [group.id, at('2026-11-01T00:00:00Z')])

   const subject = await createSubjectService(adminId, {
      code: `ach-${suffix}`, primaryLanguage: 'en', translations: { en: { title: 'Achievements' } },
   })
   const bank = await createQuestionBankService(adminId, {
      code: `ach-bank-${suffix}`, title: 'Achievements', subjectId: subject.id, visibility: 'staff',
   })
   const questionIds = []
   for (let index = 0; index < 3; index += 1) {
      const created = await createQuestionService(adminId, bank.id, {
         questionType: 'single_choice', languageCode: 'en', content: text(`Pick A ${index}`),
         options: [{ key: 'A', content: text('Right') }, { key: 'B', content: text('Wrong') }],
         difficulty: 1, difficultySource: 'expert',
      })
      await replaceAnswerKeyService(adminId, created.id, { answerData: { optionKey: 'A' }, source: 'expert_review' })
      await verifyAnswerKeyService(adminId, created.id, { source: 'expert_review' })
      await publishQuestionService(adminId, created.id)
      questionIds.push(created.id)
   }

   // A finished attempt with answers: items [{ questionId, full, answered }].
   async function finishedAttempt({ testId, assignmentId, userId, number = 1, finishedAt, seconds, items, maxScore = null }) {
      const score = items.filter((item) => item.full).length
      const attemptId = (await client.query(
         `INSERT INTO test_attempts (test_id, assignment_id, user_id, attempt_number, status, started_at,
            submitted_at, graded_at, score, max_score, policy_snapshot)
          VALUES ($1, $2, $3, $4, 'graded', $5::timestamptz - make_interval(secs => $6), $5, $5, $7, $8, '{}'::jsonb)
          RETURNING id`,
         [testId, assignmentId, userId, number, finishedAt, seconds, score, maxScore ?? items.length],
      )).rows[0].id
      for (const [index, item] of items.entries()) {
         // A published test is immutable: reuse its question rows; generated tests get new ones.
         const existing = (await client.query(
            'SELECT id FROM test_questions WHERE test_id = $1 AND question_id = $2',
            [testId, item.questionId],
         )).rows[0]
         const testQuestionId = existing ? existing.id : (await client.query(
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
      return String(attemptId)
   }

   async function trainerAttempt(userId, finishedAt, seconds, items) {
      const testId = (await client.query(
         `INSERT INTO tests (title, mode, status, origin, created_by, generation_filters)
          VALUES ('Generated', 'practice', 'draft', 'trainer', $1, $2::jsonb) RETURNING id`,
         [userId, JSON.stringify({ subjectId: String(subject.id), mode: 'standard' })],
      )).rows[0].id
      const assignmentId = (await client.query(
         'INSERT INTO test_assignments (test_id, user_id, assigned_by) VALUES ($1, $2, $2) RETURNING id',
         [testId, userId],
      )).rows[0].id
      return finishedAttempt({ testId, assignmentId, userId, finishedAt, seconds, items })
   }

   const items = (full) => questionIds.map((questionId) => ({ questionId, full }))
   const awardsOf = async (userId) => (await client.query(
      `SELECT achievement.code, award.seen_at, award.metadata, award.awarded_at
       FROM user_achievements AS award JOIN achievements AS achievement ON achievement.id = award.achievement_id
       WHERE award.user_id = $1 ORDER BY achievement.position`,
      [userId],
   )).rows
   const deps = { clock: () => now }

   await t.test('the catalog is seeded with three tiers per tiered family', async () => {
      const { rows } = await client.query(
         `SELECT code, family, tier, category, translations FROM achievements WHERE is_active ORDER BY position`,
      )
      assert.equal(rows.length, 17)
      assert.deepEqual(rows.filter((row) => row.family === 'solver').map((row) => row.tier), ['bronze', 'silver', 'gold'])
      assert.deepEqual(rows.filter((row) => row.family === 'streak').map((row) => row.tier), ['bronze', 'silver', 'gold'])
      for (const row of rows) for (const language of ['ru', 'tg', 'en']) assert.ok(row.translations[language].title, row.code)
   })

   await t.test('a rejected attempt earns nothing; a counted one earns first_step once with a notification', async () => {
      await trainerAttempt(s1, at('2026-11-18T05:00:00Z'), 3, items(true))
      let result = await evaluateUserAchievementsService(s1, { source: 'test:1' }, deps)
      assert.deepEqual(result.awarded, [])

      await trainerAttempt(s1, at('2026-11-19T05:00:00Z'), 60, items(true))
      result = await evaluateUserAchievementsService(s1, { source: 'test:2' }, deps)
      assert.deepEqual(result.awarded.map((item) => item.code), ['first_step'])
      const [award] = await awardsOf(s1)
      assert.equal(award.seen_at, null)
      assert.equal(award.awarded_at.toISOString(), '2026-11-19T05:00:00.000Z')
      assert.equal(award.metadata.source, 'test:2')

      const again = await evaluateUserAchievementsService(s1, { source: 'test:3' }, deps)
      assert.deepEqual(again.awarded, [])
      assert.deepEqual(again.planned, [])

      const job = (await client.query(
         `SELECT payload FROM background_jobs WHERE dedupe_key LIKE 'notify:achievement.unlocked:' || $1 || ':%'`,
         [s1],
      )).rows
      assert.equal(job.length, 1)
      await runNotificationFanoutService(job[0].payload)
      await runNotificationFanoutService(job[0].payload)
      const notifications = (await client.query(
         `SELECT title, body, target_path FROM notifications WHERE user_id = $1 AND event_code = 'achievement.unlocked'`,
         [s1],
      )).rows
      assert.deepEqual(notifications, [{
         title: 'Новое достижение', body: 'Вы получили достижение «Первый шаг».', target_path: '/achievements',
      }])
   })

   await t.test('an inactive account is never awarded', async () => {
      await trainerAttempt(blocked, at('2026-11-19T05:00:00Z'), 60, items(true))
      const result = await evaluateUserAchievementsService(blocked, { source: 'test' }, deps)
      assert.deepEqual(result.planned, [])
      await assert.rejects(getMyAchievementsService(blocked, deps), { code: 'ACCOUNT_NOT_ACTIVE' })
   })

   await t.test('GET /me/achievements: whole catalog, progress, seen; home shows recent ones', async () => {
      const list = await getMyAchievementsService(s1, deps)
      assert.deepEqual(list.summary, { earned: 1, total: 17 })
      assert.equal(list.items[0].code, 'first_step')
      assert.equal(list.items[0].earnedAt, '2026-11-19T05:00:00.000Z')
      assert.equal(list.items[0].seen, false)
      assert.deepEqual(list.items[0].progress, { current: 1, target: 1 })
      const solver = list.items.filter((item) => item.family === 'solver')
      assert.deepEqual(solver.map((item) => [item.tier, item.progress]), [
         ['bronze', { current: 3, target: 100 }], ['silver', { current: 3, target: 500 }], ['gold', { current: 3, target: 1000 }],
      ])
      assert.equal(list.items.find((item) => item.code === 'mock_120').progress, null)
      assert.deepEqual(Object.keys(list.items[0].translations), ['ru', 'tg', 'en'])

      await assert.rejects(markAchievementsSeenService(s1, { codes: [] }, deps), { code: 'VALIDATION_ERROR' })
      await assert.rejects(markAchievementsSeenService(s1, { codes: ['Bad code'] }, deps), { code: 'VALIDATION_ERROR' })
      assert.deepEqual(await markAchievementsSeenService(s1, { codes: ['first_step', 'mock_120', 'unknown'] }, deps), { updated: 1 })
      assert.deepEqual(await markAchievementsSeenService(s1, { codes: ['first_step'] }, deps), { updated: 0 })
      assert.equal((await getMyAchievementsService(s1, deps)).items[0].seen, true)

      const home = await getStudentHomeService(s1)
      assert.deepEqual(home.recentAchievements.map((item) => [item.code, item.seen, item.progress]), [['first_step', true, null]])
   })

   await t.test('staff read: progress scope like M12, 404 outside it', async () => {
      const list = await getStaffStudentAchievementsService(adminId, s1, deps)
      assert.equal(list.summary.earned, 1)
      await assert.rejects(getStaffStudentAchievementsService(stranger, s1, deps), { code: 'USER_NOT_FOUND' })
   })

   // A counted standalone quiz of the group (3 questions), closed last week.
   const quiz = await createTestService(adminId, {
      courseId: null, title: `Quiz ${suffix}`, mode: 'practice', maxAttempts: 3, resultPolicy: 'best', passPercent: 60,
   })
   await addTestQuestionsService(adminId, quiz.id, { questions: questionIds.map((questionId) => ({ questionId, points: '1' })) })
   await publishTestService(adminId, quiz.id)

   await t.test('assignments queue the close-time evaluation; a moved close time queues new jobs', async () => {
      const assignment = await createAssignmentService(adminId, quiz.id, { groupId: group.id, countsForGroupRanking: true })
      await client.query('UPDATE test_assignments SET opens_at = $2 WHERE id = $1', [assignment.id, at('2026-11-01T00:00:00Z')])
      await updateAssignmentService(adminId, quiz.id, assignment.id, { closesAt: '2026-11-20T12:00:00Z' })
      const jobs = (await client.query(
         `SELECT dedupe_key, available_at FROM background_jobs WHERE job_type = 'achievements.assignment'
          AND payload ->> 'assignmentId' = $1 ORDER BY dedupe_key`,
         [String(assignment.id)],
      )).rows
      assert.deepEqual(jobs.map((job) => job.dedupe_key), [
         `achievements.assignment:${assignment.id}:2026-11-20T12:00:00.000Z:changed`,
         `achievements.assignment:${assignment.id}:2026-11-20T12:00:00.000Z:closed`,
      ])
      // s1 3/3, s2 2/3, s3 1/3 (a third each), s4 and s5 nothing (0 after close).
      const marks = [[s1, 3], [s2, 2], [s3, 1]]
      for (const [userId, right] of marks) {
         await finishedAttempt({
            testId: quiz.id, assignmentId: assignment.id, userId, finishedAt: at('2026-11-18T08:00:00Z'), seconds: 60,
            items: questionIds.map((questionId, index) => ({ questionId, full: index < right })),
         })
      }
   })

   await t.test('weekly snapshot: both boards once, only finished periods, then group_top3', async () => {
      await assert.rejects(
         runRankingSnapshotService({ ...previousWeek, endAt: '2026-11-29T19:00:00.000Z' }, deps),
         { code: 'SNAPSHOT_PERIOD_NOT_FINISHED' },
      )
      const first = await runRankingSnapshotService(previousWeek, deps)
      assert.ok(first.written >= 10)
      const rows = (await client.query(
         `SELECT board, user_id::text, rank, score::float8 AS score FROM group_ranking_snapshots
          WHERE group_id = $1 AND period_start = '2026-11-16' ORDER BY board, rank NULLS LAST, user_id`,
         [group.id],
      )).rows
      assert.equal(rows.length, 10)
      const performance = rows.filter((row) => row.board === 'performance')
      assert.deepEqual(performance.slice(0, 3).map((row) => [row.user_id, row.rank]), [[s1, 1], [s2, 2], [s3, 3]])
      assert.equal(performance[0].score, 100)

      const second = await runRankingSnapshotService(previousWeek, deps)
      assert.equal(second.written, 0)
      const queued = (await client.query(
         `SELECT payload ->> 'userId' AS user_id FROM background_jobs
          WHERE job_type = 'achievements.evaluate' AND payload ->> 'source' = 'ranking:week:2026-11-16'`,
      )).rows.map((row) => row.user_id)
      for (const userId of [s1, s2, s3]) assert.ok(queued.includes(userId), userId)
      assert.ok(!queued.includes(s4))

      const result = await evaluateUserAchievementsService(s3, { source: 'ranking:week:2026-11-16' }, deps)
      assert.ok(result.awarded.some((item) => item.code === 'group_top3'))
      const award = (await awardsOf(s3)).find((row) => row.code === 'group_top3')
      assert.equal(award.metadata.periodStart, '2026-11-16')
      assert.equal(award.metadata.groupId, String(group.id))
   })

   await t.test('scheduling queues each period once', async () => {
      const monday = { clock: () => at('2026-11-29T19:06:00Z') }
      const first = await scheduleAchievementJobsService(monday)
      assert.ok(first.includes('ranking.snapshot:week:2026-11-23'))
      assert.ok(first.includes('achievements.streaks:2026-11-30'))
      assert.ok(first.includes('ranking.snapshot:month:2026-10-01'))
      assert.deepEqual(await scheduleAchievementJobsService(monday), [])
      const job = (await client.query(
         `SELECT available_at FROM background_jobs WHERE dedupe_key = 'ranking.snapshot:week:2026-11-23'`,
      )).rows[0]
      assert.equal(job.available_at.toISOString(), '2026-11-29T19:05:00.000Z')
   })

   await t.test('Telegram copy of achievement.unlocked is off by default in the settings', async () => {
      const settings = await getNotificationSettingsService(s1)
      assert.deepEqual(settings.events['achievement.unlocked'], { telegram: false })
      assert.deepEqual(settings.events['test.assigned'], { telegram: true })
   })

   await t.test('backfill: dry run writes nothing; apply without notify marks seen and queues nothing', async () => {
      await trainerAttempt(s5, at('2026-11-10T05:00:00Z'), 60, items(true))
      const dry = await backfillAchievementsService({ apply: false, userIds: [s5] }, deps)
      assert.deepEqual(dry.results[0].planned.map((item) => item.code), ['first_step'])
      assert.deepEqual(await awardsOf(s5), [])
      const applied = await backfillAchievementsService({ apply: true, notify: false, userIds: [s5] }, deps)
      assert.deepEqual(applied.results[0].awarded.map((item) => item.code), ['first_step'])
      const [award] = await awardsOf(s5)
      assert.equal(award.seen_at.toISOString(), now.toISOString())
      assert.equal(award.metadata.source, 'backfill')
      const jobs = (await client.query(
         `SELECT count(*)::integer AS count FROM background_jobs WHERE dedupe_key LIKE 'notify:achievement.unlocked:' || $1 || ':%'`,
         [s5],
      )).rows[0].count
      assert.equal(jobs, 0)
      const again = await backfillAchievementsService({ apply: true, userIds: [s5] }, deps)
      assert.deepEqual(again.results, [])
   })
})
