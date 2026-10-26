import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import { createApp } from '../../src/app.js';
import env from '../../src/configs/env.js';
import * as userRepository from '../../src/repositories/user-repository.js';
import { securityKey } from '../../src/services/auth-protection-service.js';
import { verifyPassword } from '../../src/utils/password.js';
import { createPasswordAuthTestService } from '../helpers/service-factories.js';

const { Client, Pool } = pg;
const fixtureUserIds = [];
const testConfig = {
  ...env,
  jwtAccessSecret: 'password-auth-integration-secret-longer-than-32-characters',
  authSessionTtlSeconds: 900,
};

async function request(port, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'password-auth-test' },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function removeFixtures(client) {
  if (fixtureUserIds.length === 0) return;
  await client.query('DELETE FROM audit_events WHERE subject_user_id = ANY($1::bigint[])', [fixtureUserIds]);
  await client.query(
    'DELETE FROM auth_refresh_tokens WHERE session_id IN (SELECT id FROM auth_sessions WHERE user_id = ANY($1::bigint[]))',
    [fixtureUserIds]
  );
  await client.query('DELETE FROM auth_sessions WHERE user_id = ANY($1::bigint[])', [fixtureUserIds]);
  await client.query('DELETE FROM user_roles WHERE user_id = ANY($1::bigint[])', [fixtureUserIds]);
  await client.query('DELETE FROM user_passwords WHERE user_id = ANY($1::bigint[])', [fixtureUserIds]);
  await client.query('DELETE FROM user_phones WHERE user_id = ANY($1::bigint[])', [fixtureUserIds]);
  await client.query('DELETE FROM user_profiles WHERE user_id = ANY($1::bigint[])', [fixtureUserIds]);
  await client.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [fixtureUserIds]);
}

test('password registration and login integration', async (t) => {
  const client = new Client(env.database);
  const passwordPool = new Pool({ ...env.database, max: 2 });
  const transaction = async (work) => {
    const transactionClient = await passwordPool.connect();
    try {
      await transactionClient.query('BEGIN');
      const result = await work(transactionClient);
      await transactionClient.query('COMMIT');
      return result;
    } catch (error) {
      await transactionClient.query('ROLLBACK');
      throw error;
    } finally {
      transactionClient.release();
    }
  };
  const users = {
    ...userRepository,
    findPasswordAccountByPhone: (phoneE164) => (
      userRepository.findPasswordAccountByPhone(phoneE164, passwordPool)
    ),
  };
  const passwordService = createPasswordAuthTestService({
    config: testConfig, transaction, users,
  });
  const app = createApp({ passwordAuth: passwordService.dependencies });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const port = server.address().port;
  await client.connect();

  const phone = `+99291${String(Date.now()).slice(-7)}`;
  const formattedPhone = `${phone.slice(0, 4)} (${phone.slice(4, 7)}) ${phone.slice(7, 9)}-${phone.slice(9)}`;
  const password = 'safe integration password 9';

  try {
    await t.test('rejects invalid and unexpected registration input', async () => {
      const invalidPhone = await request(port, '/api/v1/auth/register', {
        phone: '992900000000', password, firstName: 'Test', lastName: 'User',
      });
      assert.equal(invalidPhone.response.status, 400);
      assert.equal(invalidPhone.body.error.code, 'VALIDATION_ERROR');

      const weakPassword = await request(port, '/api/v1/auth/register', {
        phone, password: 'weak', firstName: 'Test', lastName: 'User',
      });
      assert.equal(weakPassword.response.status, 400);

      const elevatedRole = await request(port, '/api/v1/auth/register', {
        phone, password, firstName: 'Test', lastName: 'User', role: 'admin',
      });
      assert.equal(elevatedRole.response.status, 400);
      assert.equal(elevatedRole.body.error.details[0].field, 'role');
    });

    let userId;
    await t.test('registers one pending student atomically without exposing the hash', async () => {
      const registered = await request(port, '/api/v1/auth/register', {
        phone: formattedPhone,
        password,
        firstName: '  M02B  ',
        lastName: '  Student  ',
      });
      assert.equal(registered.response.status, 201);
      assert.equal(registered.body.data.status, 'pending');
      assert.equal(registered.body.data.user.phone, phone);
      assert.equal(registered.body.data.user.firstName, 'M02B');
      assert.equal(JSON.stringify(registered.body).includes(password), false);
      assert.equal(JSON.stringify(registered.body).includes('scrypt$'), false);
      userId = registered.body.data.user.id;
      assert.match(userId, /^[1-9][0-9]*$/);
      fixtureUserIds.push(userId);

      const stored = await client.query(
        `SELECT account.status, profile.first_name, profile.last_name,
           phone.phone_e164, phone.is_primary, credential.password_hash,
           role.code, audit.event_code
         FROM users AS account
         JOIN user_profiles AS profile ON profile.user_id = account.id
         JOIN user_phones AS phone ON phone.user_id = account.id
         JOIN user_passwords AS credential ON credential.user_id = account.id
         JOIN user_roles AS membership ON membership.user_id = account.id
         JOIN roles AS role ON role.id = membership.role_id
         JOIN audit_events AS audit ON audit.subject_user_id = account.id
         WHERE account.id = $1`,
        [userId]
      );
      assert.equal(stored.rows[0].status, 'pending');
      assert.equal(stored.rows[0].first_name, 'M02B');
      assert.equal(stored.rows[0].last_name, 'Student');
      assert.equal(stored.rows[0].phone_e164, phone);
      assert.equal(stored.rows[0].is_primary, false);
      assert.equal(stored.rows[0].code, 'student');
      assert.equal(stored.rows[0].event_code, 'auth.password.registered');
      assert.equal(await verifyPassword(password, stored.rows[0].password_hash), true);
    });

    await t.test('rejects duplicate phone registration with a stable conflict', async () => {
      const duplicate = await request(port, '/api/v1/auth/register', {
        phone, password, firstName: 'Other', lastName: 'Student',
      });
      assert.equal(duplicate.response.status, 409);
      assert.equal(duplicate.body.error.code, 'PHONE_ALREADY_REGISTERED');
      assert.equal(JSON.stringify(duplicate.body).includes('user_phones_phone_e164_key'), false);
    });

    await t.test('allows only one concurrent registration for a phone', async () => {
      const concurrentPhone = `+99292${String(Date.now() + 1).slice(-7)}`;
      const payload = {
        phone: concurrentPhone, password, firstName: 'Concurrent', lastName: 'Student',
      };
      const results = await Promise.all([
        request(port, '/api/v1/auth/register', payload),
        request(port, '/api/v1/auth/register', payload),
      ]);
      assert.deepEqual(results.map(({ response }) => response.status).sort(), [201, 409]);
      const successful = results.find(({ response }) => response.status === 201);
      fixtureUserIds.push(successful.body.data.user.id);
      const count = await client.query(
        'SELECT count(*)::int AS count FROM user_phones WHERE phone_e164 = $1',
        [concurrentPhone]
      );
      assert.equal(count.rows[0].count, 1);
    });

    await t.test('rolls back all registration writes when a participating write fails', async () => {
      const rollbackPhone = `+99293${String(Date.now() + 2).slice(-7)}`;
      const before = await client.query('SELECT count(*)::int AS count FROM users');
      const rollbackService = createPasswordAuthTestService({
        config: testConfig,
        transaction,
        users: {
          ...users,
          createPassword: async () => { throw new Error('injected registration failure'); },
        },
      });
      await assert.rejects(
        rollbackService.register({
          phone: rollbackPhone, password, firstName: 'Rollback', lastName: 'Student',
        }),
        /injected registration failure/
      );
      const after = await client.query('SELECT count(*)::int AS count FROM users');
      const phoneCount = await client.query(
        'SELECT count(*)::int AS count FROM user_phones WHERE phone_e164 = $1',
        [rollbackPhone]
      );
      assert.equal(after.rows[0].count, before.rows[0].count);
      assert.equal(phoneCount.rows[0].count, 0);
    });

    await t.test('uses generic credential errors and rejects non-active accounts', async () => {
      const unknown = await request(port, '/api/v1/auth/login/password', {
        phone: `+99294${String(Date.now() + 3).slice(-7)}`, password,
      });
      const wrong = await request(port, '/api/v1/auth/login/password', {
        phone, password: 'wrong password value 8',
      });
      assert.equal(unknown.response.status, 401);
      assert.equal(wrong.response.status, 401);
      assert.deepEqual(unknown.body, wrong.body);
      assert.equal(wrong.body.error.code, 'INVALID_CREDENTIALS');

      const pending = await request(port, '/api/v1/auth/login/password', { phone, password });
      assert.equal(pending.response.status, 403);
      assert.equal(pending.body.error.code, 'ACCOUNT_NOT_ACTIVE');
    });

    await t.test('logs in an active account and creates a safe auditable session', async () => {
      await client.query("UPDATE users SET status = 'active' WHERE id = $1", [userId]);
      const loggedIn = await request(port, '/api/v1/auth/login/password', { phone, password });
      assert.equal(loggedIn.response.status, 200);
      assert.equal(loggedIn.body.data.status, 'authenticated');
      assert.equal(loggedIn.body.data.user.id, userId);
      assert.match(loggedIn.body.data.user.id, /^[1-9][0-9]*$/);
      assert.equal('accessToken' in loggedIn.body.data, false);
      assert.equal('refreshToken' in loggedIn.body.data, false);
      assert.match(loggedIn.response.headers.get('set-cookie'), /^everest_access=.*HttpOnly.*SameSite=Lax/i);
      assert.match(loggedIn.response.headers.get('set-cookie'), /everest_refresh=.*HttpOnly.*SameSite=Lax/i);

      const stored = await client.query(
        `SELECT account.last_login_at, session.user_agent, audit.event_code
         FROM users AS account
         JOIN auth_sessions AS session ON session.user_id = account.id
         JOIN audit_events AS audit ON audit.entity_id = session.id
         WHERE account.id = $1 AND session.revoked_at IS NULL`,
        [userId]
      );
      assert.ok(stored.rows[0].last_login_at);
      assert.equal(stored.rows[0].user_agent, 'password-auth-test');
      assert.equal(stored.rows[0].event_code, 'auth.password.login_succeeded');
    });

    await t.test('locks repeated password failures atomically, expires, and resets on success', async () => {
      const attempts = await Promise.all(Array.from({ length: 6 }, () => (
        request(port, '/api/v1/auth/login/password', {
          phone, password: 'wrong concurrent password 7',
        })
      )));
      assert.ok(attempts.some(({ response }) => response.status === 429));
      const limited = attempts.find(({ response }) => response.status === 429);
      assert.equal(limited.body.error.code, 'AUTH_RATE_LIMITED');
      assert.ok(Number(limited.response.headers.get('retry-after')) >= 1);

      const keyHash = securityKey(phone, testConfig);
      const stored = await client.query(
        `SELECT attempt_count FROM auth_security_counters
         WHERE scope = 'login.account' AND key_hash = $1`,
        [keyHash]
      );
      assert.equal(stored.rows[0].attempt_count, 6);

      await client.query(
        `UPDATE auth_security_counters
         SET window_started_at = CURRENT_TIMESTAMP - INTERVAL '1 hour', blocked_until = NULL
         WHERE scope = 'login.account' AND key_hash = $1`,
        [keyHash]
      );
      const succeeded = await request(port, '/api/v1/auth/login/password', { phone, password });
      assert.equal(succeeded.response.status, 200);
      const cleared = await client.query(
        `SELECT count(*)::int AS count FROM auth_security_counters
         WHERE scope = 'login.account' AND key_hash = $1`,
        [keyHash]
      );
      assert.equal(cleared.rows[0].count, 0);
    });

    await t.test('rejects blocked and rejected accounts with the same safe status error', async () => {
      await client.query(
        "UPDATE users SET status = 'blocked', blocked_at = CURRENT_TIMESTAMP WHERE id = $1",
        [userId]
      );
      const blocked = await request(port, '/api/v1/auth/login/password', { phone, password });
      await client.query("UPDATE users SET status = 'rejected' WHERE id = $1", [userId]);
      const rejected = await request(port, '/api/v1/auth/login/password', { phone, password });
      assert.equal(blocked.response.status, 403);
      assert.equal(rejected.response.status, 403);
      assert.deepEqual(blocked.body, rejected.body);
      assert.equal(blocked.body.error.code, 'ACCOUNT_NOT_ACTIVE');
    });
  } finally {
    await client.query(
      `DELETE FROM auth_security_counters
       WHERE scope IN ('register.ip', 'login.ip')
          OR (scope = 'login.account' AND key_hash = $1)`,
      [securityKey(phone, testConfig)]
    );
    await removeFixtures(client);
    await client.end();
    await new Promise((resolve) => server.close(resolve));
    await passwordPool.end();
  }
});
