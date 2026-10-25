import assert from 'node:assert/strict';

import pg from 'pg';

import env from '../src/configs/env.js';

const { Client } = pg;
const client = new Client(env.database);
const results = [];

async function insertReturningId(query, values = []) {
  const result = await client.query(`${query} RETURNING id`, values);
  return result.rows[0].id;
}

async function expectRejected(name, query, values = []) {
  const savepoint = `check_${results.length}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  let error;
  try {
    await client.query(query, values);
  } catch (caught) {
    error = caught;
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  assert.ok(error, `${name} unexpectedly succeeded`);
  results.push({ name, code: error.code });
}

try {
  await client.connect();
  await client.query('BEGIN');

  const adminId = await insertReturningId("INSERT INTO users (status) VALUES ('active')");
  const studentId = await insertReturningId("INSERT INTO users (status) VALUES ('active')");

  const courseOne = await insertReturningId(
    'INSERT INTO courses (title, created_by) VALUES ($1, $2)',
    ['Course one', adminId]
  );
  const courseTwo = await insertReturningId(
    'INSERT INTO courses (title, created_by) VALUES ($1, $2)',
    ['Course two', adminId]
  );
  await client.query(
    'INSERT INTO course_enrollments (user_id, course_id, granted_by) VALUES ($1, $2, $3)',
    [studentId, courseOne, adminId]
  );
  const otherCourseModule = await insertReturningId(
    'INSERT INTO course_modules (course_id, title, position) VALUES ($1, $2, $3)',
    [courseTwo, 'Other course module', 1]
  );
  await expectRejected(
    'module grant referencing the wrong course',
    `INSERT INTO module_access_grants
      (user_id, course_id, module_id, granted_by)
      VALUES ($1, $2, $3, $4)`,
    [studentId, courseOne, otherCourseModule, adminId]
  );

  const testId = await insertReturningId(
    'INSERT INTO tests (title, mode, created_by) VALUES ($1, $2, $3)',
    ['Integrity test', 'practice', adminId]
  );
  const groupId = await insertReturningId(
    'INSERT INTO groups (code, title, created_by) VALUES ($1, $2, $3)',
    [`group-${Date.now()}`, 'Integrity group', adminId]
  );
  await expectRejected(
    'assignment with multiple audience kinds',
    `INSERT INTO test_assignments
      (test_id, group_id, user_id, assigned_by)
      VALUES ($1, $2, $3, $4)`,
    [testId, groupId, studentId, adminId]
  );

  const assignmentId = await insertReturningId(
    `INSERT INTO test_assignments (test_id, user_id, assigned_by)
     VALUES ($1, $2, $3)`,
    [testId, studentId, adminId]
  );
  await client.query(
    `INSERT INTO test_attempts
      (test_id, assignment_id, user_id, attempt_number, policy_snapshot)
     VALUES ($1, $2, $3, 1, '{}'::jsonb)`,
    [testId, assignmentId, studentId]
  );
  await expectRejected(
    'two simultaneously open attempts',
    `INSERT INTO test_attempts
      (test_id, assignment_id, user_id, attempt_number, status, paused_at, policy_snapshot)
     VALUES ($1, $2, $3, 2, 'paused', CURRENT_TIMESTAMP, '{}'::jsonb)`,
    [testId, assignmentId, studentId]
  );

  const subjectId = await insertReturningId(
    'INSERT INTO subjects (code) VALUES ($1)', [`subject-${Date.now()}`]
  );
  const bankId = await insertReturningId(
    `INSERT INTO question_banks (code, title, subject_id, owner_id)
     VALUES ($1, $2, $3, $4)`,
    [`bank-${Date.now()}`, 'Integrity bank', subjectId, adminId]
  );
  const questionOne = await insertReturningId(
    `INSERT INTO questions
      (bank_id, subject_id, question_type, language_code, created_by)
     VALUES ($1, $2, 'short_text', 'en', $3)`,
    [bankId, subjectId, adminId]
  );
  const questionTwo = await insertReturningId(
    `INSERT INTO questions
      (bank_id, subject_id, question_type, language_code, created_by)
     VALUES ($1, $2, 'short_text', 'en', $3)`,
    [bankId, subjectId, adminId]
  );
  const testQuestionOne = await insertReturningId(
    `INSERT INTO test_questions (test_id, question_id, position, points)
     VALUES ($1, $2, 1, 1)`, [testId, questionOne]
  );
  await insertReturningId(
    `INSERT INTO test_questions (test_id, question_id, position, points)
     VALUES ($1, $2, 2, 1)`, [testId, questionTwo]
  );
  const attemptId = await insertReturningId(
    `INSERT INTO test_attempts
      (test_id, assignment_id, user_id, attempt_number, status, policy_snapshot)
     VALUES ($1, $2, $3, 2, 'cancelled', '{}'::jsonb)`,
    [testId, assignmentId, studentId]
  );
  const attemptQuestion = await insertReturningId(
    `INSERT INTO attempt_questions
      (attempt_id, test_id, test_question_id, question_id, position, max_points, grading_snapshot)
     VALUES ($1, $2, $3, $4, 1, 1, '{}'::jsonb)`,
    [attemptId, testId, testQuestionOne, questionOne]
  );
  await expectRejected(
    'answer referencing the wrong attempt question',
    `INSERT INTO student_answers (attempt_question_id, question_id)
     VALUES ($1, $2)`,
    [attemptQuestion, questionTwo]
  );

  await expectRejected(
    'publication without a verified answer key',
    'UPDATE questions SET status = $1 WHERE id = $2',
    ['published', questionOne]
  );
  await client.query(
    `INSERT INTO question_answer_keys
      (question_id, status, source, answer_data, verified_by, verified_at)
     VALUES ($1, 'verified', 'expert_review', '{"accepted_answers":["ok"]}'::jsonb, $2, CURRENT_TIMESTAMP)`,
    [questionOne, adminId]
  );
  await client.query('UPDATE questions SET status = $1 WHERE id = $2', ['published', questionOne]);
  await expectRejected(
    'modification of protected published content',
    `UPDATE questions SET content = '{"blocks":[{"type":"text"}]}'::jsonb WHERE id = $1`,
    [questionOne]
  );

  const bonusAccountId = await insertReturningId(
    'INSERT INTO bonus_accounts (user_id) VALUES ($1)',
    [studentId]
  );
  const bonusTransactionId = await insertReturningId(
    `INSERT INTO bonus_transactions
      (account_id, delta, source_event_key, operation)
     VALUES ($1, 10, $2, 'earn')`,
    [bonusAccountId, 'integrity-event']
  );
  await expectRejected(
    'duplicate bonus event',
    `INSERT INTO bonus_transactions
      (account_id, delta, source_event_key, operation)
     VALUES ($1, 10, $2, 'earn')`,
    [bonusAccountId, 'integrity-event']
  );
  await expectRejected(
    'mutation of an append-only journal',
    'UPDATE bonus_transactions SET delta = 20 WHERE id = $1',
    [bonusTransactionId]
  );

  console.log(JSON.stringify({ database: env.database.database, results }, null, 2));
} catch (error) {
  console.error('Schema integrity test failed', { code: error.code, message: error.message });
  process.exitCode = 1;
} finally {
  await client.query('ROLLBACK').catch(() => {});
  await client.end();
}
