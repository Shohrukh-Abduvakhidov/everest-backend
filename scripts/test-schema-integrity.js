import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

import pg from 'pg';

import env from '../src/configs/env.js';

const { Client } = pg;
const client = new Client(env.database);
const id = () => randomUUID();
const results = [];

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

  const adminId = id();
  const studentId = id();
  await client.query('INSERT INTO users (id, status) VALUES ($1, $2), ($3, $2)', [
    adminId, 'active', studentId,
  ]);

  const courseOne = id();
  const courseTwo = id();
  await client.query(
    'INSERT INTO courses (id, title, created_by) VALUES ($1, $2, $3), ($4, $5, $3)',
    [courseOne, 'Course one', adminId, courseTwo, 'Course two']
  );
  const enrollmentId = id();
  await client.query(
    'INSERT INTO course_enrollments (id, user_id, course_id, granted_by) VALUES ($1, $2, $3, $4)',
    [enrollmentId, studentId, courseOne, adminId]
  );
  const otherCourseModule = id();
  await client.query(
    'INSERT INTO course_modules (id, course_id, title, position) VALUES ($1, $2, $3, $4)',
    [otherCourseModule, courseTwo, 'Other course module', 1]
  );
  await expectRejected(
    'module grant referencing the wrong course',
    `INSERT INTO module_access_grants
      (id, user_id, course_id, module_id, granted_by)
      VALUES ($1, $2, $3, $4, $5)`,
    [id(), studentId, courseOne, otherCourseModule, adminId]
  );

  const testId = id();
  await client.query(
    'INSERT INTO tests (id, title, mode, created_by) VALUES ($1, $2, $3, $4)',
    [testId, 'Integrity test', 'practice', adminId]
  );
  const groupId = id();
  await client.query(
    'INSERT INTO groups (id, code, title, created_by) VALUES ($1, $2, $3, $4)',
    [groupId, `group-${groupId}`, 'Integrity group', adminId]
  );
  await expectRejected(
    'assignment with multiple audience kinds',
    `INSERT INTO test_assignments
      (id, test_id, group_id, user_id, assigned_by)
      VALUES ($1, $2, $3, $4, $5)`,
    [id(), testId, groupId, studentId, adminId]
  );

  const assignmentId = id();
  await client.query(
    `INSERT INTO test_assignments (id, test_id, user_id, assigned_by)
     VALUES ($1, $2, $3, $4)`,
    [assignmentId, testId, studentId, adminId]
  );
  await client.query(
    `INSERT INTO test_attempts
      (id, test_id, assignment_id, user_id, attempt_number, policy_snapshot)
     VALUES ($1, $2, $3, $4, 1, '{}'::jsonb)`,
    [id(), testId, assignmentId, studentId]
  );
  await expectRejected(
    'two simultaneously open attempts',
    `INSERT INTO test_attempts
      (id, test_id, assignment_id, user_id, attempt_number, status, paused_at, policy_snapshot)
     VALUES ($1, $2, $3, $4, 2, 'paused', CURRENT_TIMESTAMP, '{}'::jsonb)`,
    [id(), testId, assignmentId, studentId]
  );

  const subjectId = id();
  const bankId = id();
  await client.query('INSERT INTO subjects (id, code) VALUES ($1, $2)', [subjectId, `subject-${subjectId}`]);
  await client.query(
    `INSERT INTO question_banks (id, code, title, subject_id, owner_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [bankId, `bank-${bankId}`, 'Integrity bank', subjectId, adminId]
  );
  const questionOne = id();
  const questionTwo = id();
  await client.query(
    `INSERT INTO questions
      (id, bank_id, subject_id, question_type, language_code, created_by)
     VALUES ($1, $3, $4, 'short_text', 'en', $5),
            ($2, $3, $4, 'short_text', 'en', $5)`,
    [questionOne, questionTwo, bankId, subjectId, adminId]
  );
  const testQuestionOne = id();
  const testQuestionTwo = id();
  await client.query(
    `INSERT INTO test_questions (id, test_id, question_id, position, points)
     VALUES ($1, $3, $4, 1, 1), ($2, $3, $5, 2, 1)`,
    [testQuestionOne, testQuestionTwo, testId, questionOne, questionTwo]
  );
  const attemptId = id();
  await client.query(
    `INSERT INTO test_attempts
      (id, test_id, assignment_id, user_id, attempt_number, status, policy_snapshot)
     VALUES ($1, $2, $3, $4, 2, 'cancelled', '{}'::jsonb)`,
    [attemptId, testId, assignmentId, studentId]
  );
  const attemptQuestion = id();
  await client.query(
    `INSERT INTO attempt_questions
      (id, attempt_id, test_id, test_question_id, question_id, position, max_points, grading_snapshot)
     VALUES ($1, $2, $3, $4, $5, 1, 1, '{}'::jsonb)`,
    [attemptQuestion, attemptId, testId, testQuestionOne, questionOne]
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

  const bonusAccountId = id();
  await client.query(
    'INSERT INTO bonus_accounts (id, user_id) VALUES ($1, $2)',
    [bonusAccountId, studentId]
  );
  const bonusTransactionId = id();
  await client.query(
    `INSERT INTO bonus_transactions
      (id, account_id, delta, source_event_key, operation)
     VALUES ($1, $2, 10, $3, 'earn')`,
    [bonusTransactionId, bonusAccountId, 'integrity-event']
  );
  await expectRejected(
    'duplicate bonus event',
    `INSERT INTO bonus_transactions
      (id, account_id, delta, source_event_key, operation)
     VALUES ($1, $2, 10, $3, 'earn')`,
    [id(), bonusAccountId, 'integrity-event']
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
