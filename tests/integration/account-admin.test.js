import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import { createApp } from '../../src/app.js';
import env from '../../src/configs/env.js';
import * as accountAdminRepository from '../../src/repositories/account-admin-repository.js';
import { withTransaction } from '../../src/repositories/transaction-repository.js';
import { createAccessToken } from '../../src/services/auth/session-token-service.js';
import {
  createAccountAdminTestService,
  createTelegramAuthTestService,
} from '../helpers/service-factories.js';

const { Client } = pg;
const fixtureIds = [];
const secret = 'account-admin-integration-secret-longer-than-32-characters';
const config = {
  ...env,
  jwtAccessSecret: secret,
  telegram: {
    clientId: 'test-client', clientSecret: 'test-client-secret', redirectUri: 'http://localhost/callback',
    botUsername: 'test_bot', botToken: 'test-token', webhookSecret: 'test-webhook-secret',
  },
};

async function createUser(client, { status = 'pending', role = 'student', phone }) {
  const user = await client.query("INSERT INTO users (status) VALUES ($1) RETURNING id", [status]);
  const userId = user.rows[0].id;
  fixtureIds.push(userId);
  await client.query("INSERT INTO user_profiles (user_id, first_name, last_name) VALUES ($1, 'M02C', 'Fixture')", [userId]);
  await client.query('INSERT INTO user_phones (user_id, phone_e164) VALUES ($1, $2)', [userId, phone]);
  await client.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2', [userId, role]);
  return userId;
}

async function issueToken(client, userId) {
  const expiresAt = new Date(Date.now() + 600000);
  const session = await client.query(
    'INSERT INTO auth_sessions (user_id, expires_at) VALUES ($1, $2) RETURNING id',
    [userId, expiresAt]
  );
  await client.query(
    `INSERT INTO auth_refresh_tokens (session_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [session.rows[0].id, `account-admin-test-${session.rows[0].id}`, expiresAt]
  );
  return createAccessToken({ userId, sessionId: session.rows[0].id, expiresAt }, secret);
}

async function api(port, path, { method = 'GET', token } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { response, body: await response.json() };
}

async function cleanup(client) {
  if (!fixtureIds.length) return;
  await client.query('DELETE FROM audit_events WHERE subject_user_id = ANY($1::bigint[]) OR actor_user_id = ANY($1::bigint[])', [fixtureIds]);
  await client.query('DELETE FROM auth_refresh_tokens WHERE session_id IN (SELECT id FROM auth_sessions WHERE user_id = ANY($1::bigint[]))', [fixtureIds]);
  await client.query('DELETE FROM auth_sessions WHERE user_id = ANY($1::bigint[])', [fixtureIds]);
  await client.query('DELETE FROM user_roles WHERE user_id = ANY($1::bigint[]) OR assigned_by = ANY($1::bigint[])', [fixtureIds]);
  await client.query('DELETE FROM user_phones WHERE user_id = ANY($1::bigint[])', [fixtureIds]);
  await client.query('DELETE FROM user_profiles WHERE user_id = ANY($1::bigint[])', [fixtureIds]);
  await client.query('UPDATE users SET approved_by = NULL, blocked_by = NULL WHERE id = ANY($1::bigint[])', [fixtureIds]);
  await client.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [fixtureIds]);
}

test('account approval administration integration', async (t) => {
  const client = new Client(env.database);
  await client.connect();
  const stamp = String(Date.now()).slice(-7);
  const authService = createTelegramAuthTestService({ config });
  const accountAdminService = createAccountAdminTestService();
  const app = createApp({
    telegramAuth: authService.dependencies,
    accountAdmin: accountAdminService.dependencies,
  });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const port = server.address().port;

  try {
    const existingOwner = await client.query(
      "SELECT 1 FROM user_roles membership JOIN roles role ON role.id = membership.role_id WHERE role.code = 'owner' LIMIT 1"
    );
    assert.equal(existingOwner.rowCount, 0, 'integration database must not have a pre-existing owner');

    const bootstrapId = await createUser(client, { phone: `+99270${stamp}` });
    const bootstrapResults = await Promise.allSettled([
      accountAdminService.bootstrapOwner(`+99270${stamp}`),
      accountAdminService.bootstrapOwner(`+99270${stamp}`),
    ]);
    assert.equal(
      bootstrapResults.filter(({ status }) => status === 'fulfilled').length,
      1,
      bootstrapResults.map((result) => result.status === 'rejected'
        ? `${result.reason.code}:${result.reason.message}` : 'fulfilled').join(', ')
    );
    assert.equal(bootstrapResults.filter(({ status }) => status === 'rejected')[0].reason.code, 'OWNER_ALREADY_CONFIGURED');
    const bootstrapped = await client.query(
      `SELECT account.status, role.code, audit.event_code
       FROM users AS account
       JOIN user_roles AS membership ON membership.user_id = account.id
       JOIN roles AS role ON role.id = membership.role_id AND role.code = 'owner'
       JOIN audit_events AS audit ON audit.subject_user_id = account.id
         AND audit.event_code = 'admin.owner.bootstrapped'
       WHERE account.id = $1`,
      [bootstrapId]
    );
    assert.equal(bootstrapped.rows[0].status, 'active');
    const ownerToken = await issueToken(client, bootstrapId);

    const adminId = await createUser(client, { status: 'active', role: 'admin', phone: `+99271${stamp}` });
    const studentId = await createUser(client, { status: 'active', role: 'student', phone: `+99272${stamp}` });
    const teacherId = await createUser(client, { status: 'active', role: 'teacher', phone: `+99273${stamp}` });
    const pendingOne = await createUser(client, { phone: `+99274${stamp}` });
    const pendingTwo = await createUser(client, { phone: `+99275${stamp}` });
    const adminToken = await issueToken(client, adminId);
    const studentToken = await issueToken(client, studentId);
    const teacherToken = await issueToken(client, teacherId);

    await t.test('requires authentication and an owner/admin database role', async () => {
      const unauthenticated = await api(port, '/api/v1/admin/users/pending');
      assert.equal(unauthenticated.response.status, 401);
      assert.equal(unauthenticated.body.error.code, 'AUTHENTICATION_REQUIRED');
      for (const token of [studentToken, teacherToken]) {
        const denied = await api(port, '/api/v1/admin/users/pending', { token });
        assert.equal(denied.response.status, 403);
        assert.equal(denied.body.error.code, 'ADMIN_ROLE_REQUIRED');
      }
      assert.equal((await api(port, '/api/v1/admin/users/pending', { token: ownerToken })).response.status, 200);
      assert.equal((await api(port, '/api/v1/admin/users/pending', { token: adminToken })).response.status, 200);
    });

    await t.test('lists pending users deterministically with safe pagination', async () => {
      const listed = await api(port, '/api/v1/admin/users/pending?limit=1&offset=0', { token: adminToken });
      assert.equal(listed.response.status, 200);
      assert.equal(listed.body.data.users.length, 1);
      assert.equal(listed.body.data.pagination.limit, 1);
      assert.equal(listed.body.data.pagination.hasMore, true);
      const complete = await api(port, '/api/v1/admin/users/pending?limit=100', { token: adminToken });
      const ids = complete.body.data.users.map(({ id }) => id);
      assert.ok(ids.indexOf(pendingOne) < ids.indexOf(pendingTwo));
      const serialized = JSON.stringify(listed.body);
      for (const secretField of ['password_hash', 'accessToken', 'provider_profile']) assert.equal(serialized.includes(secretField), false);
    });

    await t.test('validates route identifiers and missing users', async () => {
      for (const id of ['0', '-1', '1.5', '01', '1e2', '9223372036854775808']) {
        const result = await api(port, `/api/v1/admin/users/${id}/approve`, { method: 'POST', token: adminToken });
        assert.equal(result.response.status, 400);
        assert.equal(result.body.error.code, 'INVALID_USER_ID');
      }
      const missing = await api(port, '/api/v1/admin/users/9223372036854775807/approve', { method: 'POST', token: adminToken });
      assert.equal(missing.response.status, 404);
    });

    await t.test('serializes concurrent approval and audits exactly one decision', async () => {
      const results = await Promise.all([
        api(port, `/api/v1/admin/users/${pendingOne}/approve`, { method: 'POST', token: adminToken }),
        api(port, `/api/v1/admin/users/${pendingOne}/approve`, { method: 'POST', token: ownerToken }),
      ]);
      assert.deepEqual(results.map(({ response }) => response.status).sort(), [200, 409]);
      const audit = await client.query("SELECT count(*)::int AS count FROM audit_events WHERE subject_user_id = $1 AND event_code = 'admin.account.approved'", [pendingOne]);
      assert.equal(audit.rows[0].count, 1);
    });

    await t.test('rejects pending users and forbids self rejection/blocking', async () => {
      const rejected = await api(port, `/api/v1/admin/users/${pendingTwo}/reject`, { method: 'POST', token: adminToken });
      assert.equal(rejected.response.status, 200);
      assert.equal(rejected.body.data.user.status, 'rejected');
      const selfBlock = await api(port, `/api/v1/admin/users/${adminId}/block`, { method: 'POST', token: adminToken });
      assert.equal(selfBlock.body.error.code, 'SELF_BLOCK_FORBIDDEN');
      const selfReject = await api(port, `/api/v1/admin/users/${adminId}/reject`, { method: 'POST', token: adminToken });
      assert.equal(selfReject.body.error.code, 'SELF_REJECTION_FORBIDDEN');
      const repeated = await api(port, `/api/v1/admin/users/${pendingTwo}/reject`, { method: 'POST', token: adminToken });
      assert.equal(repeated.body.error.code, 'INVALID_ACCOUNT_TRANSITION');
    });

    await t.test('blocks atomically, revokes sessions, and unblock does not restore them', async () => {
      await issueToken(client, studentId);
      const blocked = await api(port, `/api/v1/admin/users/${studentId}/block`, { method: 'POST', token: adminToken });
      assert.equal(blocked.response.status, 200);
      assert.equal(blocked.body.data.user.status, 'blocked');
      assert.ok(blocked.body.data.revokedSessions >= 2);
      const oldToken = await api(port, '/api/v1/admin/users/pending', { token: studentToken });
      assert.equal(oldToken.response.status, 401);
      const unblocked = await api(port, `/api/v1/admin/users/${studentId}/unblock`, { method: 'POST', token: adminToken });
      assert.equal(unblocked.response.status, 200);
      const sessions = await client.query('SELECT count(*)::int AS count FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL', [studentId]);
      assert.equal(sessions.rows[0].count, 0);
      const refreshTokens = await client.query(
        `SELECT count(*) FILTER (WHERE token.revoked_at IS NULL)::int AS live
         FROM auth_refresh_tokens AS token JOIN auth_sessions AS session ON session.id = token.session_id
         WHERE session.user_id = $1`,
        [studentId]
      );
      assert.equal(refreshTokens.rows[0].live, 0);
      const audits = await client.query(
        `SELECT event_code FROM audit_events WHERE subject_user_id = ANY($1::bigint[])
         AND event_code LIKE 'admin.account.%'`,
        [[pendingOne, pendingTwo, studentId]]
      );
      assert.deepEqual(
        new Set(audits.rows.map(({ event_code: code }) => code)),
        new Set(['admin.account.approved', 'admin.account.rejected', 'admin.account.blocked', 'admin.account.unblocked'])
      );
    });

    await t.test('rolls back a transition when its audit write fails', async () => {
      const rollbackId = await createUser(client, { phone: `+99276${stamp}` });
      const rollbackService = createAccountAdminTestService({
        repository: accountAdminRepository,
        transaction: withTransaction,
        auth: { appendAuditEvent: async () => { throw new Error('injected audit failure'); } },
      });
      await assert.rejects(rollbackService.approve(adminId, rollbackId), /injected audit failure/);
      const stored = await client.query('SELECT status, approved_at FROM users WHERE id = $1', [rollbackId]);
      assert.equal(stored.rows[0].status, 'pending');
      assert.equal(stored.rows[0].approved_at, null);
    });
  } finally {
    await cleanup(client);
    await client.end();
    await new Promise((resolve) => server.close(resolve));
  }
});
