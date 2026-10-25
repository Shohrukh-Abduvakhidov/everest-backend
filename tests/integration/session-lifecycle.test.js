import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import { createApp } from '../../src/app.js';
import env from '../../src/configs/env.js';
import * as authRepository from '../../src/repositories/auth-repository.js';
import * as sessionRepository from '../../src/repositories/session-repository.js';
import { withTransaction } from '../../src/repositories/transaction-repository.js';
import { createSessionService } from '../../src/services/auth/session-service.js';
import { createSessionLifecycleService } from '../../src/services/session-lifecycle-service.js';
import { createTelegramAuthService } from '../../src/services/telegram-auth-service.js';

const { Client } = pg;
const fixtureIds = [];
const config = {
  ...env,
  jwtAccessSecret: 'session-lifecycle-integration-secret-longer-than-32-characters',
  authSessionTtlSeconds: 900,
  authRefreshTtlSeconds: 86400,
  telegram: {
    clientId: 'test-client', clientSecret: 'test-secret', redirectUri: 'http://localhost/callback',
    botUsername: 'test_bot', botToken: 'test-token', webhookSecret: 'test-webhook',
  },
};

async function createUser(client, status = 'active') {
  const result = await client.query('INSERT INTO users (status) VALUES ($1) RETURNING id', [status]);
  fixtureIds.push(result.rows[0].id);
  return result.rows[0].id;
}

async function issue(sessionService, userId, userAgent = 'Mozilla/5.0 Windows Chrome/120.0') {
  return withTransaction((client) => sessionService.issueSession({
    userId, requestContext: { userAgent, ipAddress: '127.0.0.1' }, client,
  }));
}

function cookie(name, value) {
  return `${name}=${encodeURIComponent(value)}`;
}

function cookieValue(response, name) {
  const header = response.headers.get('set-cookie') || '';
  return header.match(new RegExp(`${name}=([^;,]+)`))?.[1];
}

async function api(port, path, { method = 'GET', accessToken, refreshToken } = {}) {
  const cookies = [];
  if (accessToken) cookies.push(cookie('everest_access', accessToken));
  if (refreshToken) cookies.push(cookie('everest_refresh', refreshToken));
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(cookies.length ? { cookie: cookies.join('; ') } : {}),
    },
  });
  return { response, body: await response.json() };
}

async function cleanup(client) {
  if (!fixtureIds.length) return;
  await client.query('DELETE FROM audit_events WHERE actor_user_id = ANY($1::bigint[]) OR subject_user_id = ANY($1::bigint[])', [fixtureIds]);
  await client.query('DELETE FROM auth_refresh_tokens WHERE session_id IN (SELECT id FROM auth_sessions WHERE user_id = ANY($1::bigint[]))', [fixtureIds]);
  await client.query('DELETE FROM auth_sessions WHERE user_id = ANY($1::bigint[])', [fixtureIds]);
  await client.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [fixtureIds]);
}

test('secure multi-device session lifecycle integration', async (t) => {
  const client = new Client(env.database);
  await client.connect();
  const sessionService = createSessionService({ config });
  const lifecycle = createSessionLifecycleService({ config });
  const authService = createTelegramAuthService({ config });
  const app = createApp(authService, undefined, undefined, lifecycle);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const port = server.address().port;

  try {
    const userId = await createUser(client);
    const otherUserId = await createUser(client);

    await t.test('issues hashed refresh state and rotates it without JSON exposure', async () => {
      const issued = await issue(sessionService, userId);
      const stored = await client.query(
        'SELECT token_hash FROM auth_refresh_tokens WHERE session_id = $1', [issued.sessionId]
      );
      assert.notEqual(stored.rows[0].token_hash, issued.refreshToken);
      assert.equal(stored.rows[0].token_hash.includes(issued.refreshToken), false);

      const refreshed = await api(port, '/api/v1/auth/refresh', {
        method: 'POST', refreshToken: issued.refreshToken,
      });
      assert.equal(refreshed.response.status, 200);
      assert.equal(refreshed.body.data.status, 'refreshed');
      assert.equal(JSON.stringify(refreshed.body).includes('refreshToken'), false);
      assert.equal(JSON.stringify(refreshed.body).includes('accessToken'), false);
      const replacement = decodeURIComponent(cookieValue(refreshed.response, 'everest_refresh'));
      assert.ok(replacement);
      const second = await api(port, '/api/v1/auth/refresh', { method: 'POST', refreshToken: replacement });
      assert.equal(second.response.status, 200);
      const touched = await client.query('SELECT last_used_at FROM auth_sessions WHERE id = $1', [issued.sessionId]);
      assert.ok(touched.rows[0].last_used_at);
    });

    await t.test('rejects missing, malformed, expired, revoked, blocked, and revoked-session refresh', async () => {
      assert.equal((await api(port, '/api/v1/auth/refresh', { method: 'POST' })).response.status, 401);
      assert.equal((await api(port, '/api/v1/auth/refresh', { method: 'POST', refreshToken: 'bad' })).response.status, 401);

      const expired = await issue(sessionService, userId);
      await client.query(
        `UPDATE auth_refresh_tokens SET created_at = CURRENT_TIMESTAMP - INTERVAL '2 days',
           expires_at = CURRENT_TIMESTAMP - INTERVAL '1 day' WHERE session_id = $1`,
        [expired.sessionId]
      );
      assert.equal((await api(port, '/api/v1/auth/refresh', { method: 'POST', refreshToken: expired.refreshToken })).response.status, 401);

      const revoked = await issue(sessionService, userId);
      await client.query('UPDATE auth_refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE session_id = $1', [revoked.sessionId]);
      assert.equal((await api(port, '/api/v1/auth/refresh', { method: 'POST', refreshToken: revoked.refreshToken })).response.status, 401);

      const blocked = await issue(sessionService, userId);
      await client.query("UPDATE users SET status = 'blocked', blocked_at = CURRENT_TIMESTAMP WHERE id = $1", [userId]);
      assert.equal((await api(port, '/api/v1/auth/refresh', { method: 'POST', refreshToken: blocked.refreshToken })).response.status, 401);
      await client.query("UPDATE users SET status = 'active', blocked_at = NULL WHERE id = $1", [userId]);

      const deadSession = await issue(sessionService, userId);
      await client.query("UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP, revoke_reason = 'test' WHERE id = $1", [deadSession.sessionId]);
      assert.equal((await api(port, '/api/v1/auth/refresh', { method: 'POST', refreshToken: deadSession.refreshToken })).response.status, 401);
    });

    await t.test('detects reuse and serializes concurrent refresh', async () => {
      const issued = await issue(sessionService, userId);
      const [first, second] = await Promise.all([
        api(port, '/api/v1/auth/refresh', { method: 'POST', refreshToken: issued.refreshToken }),
        api(port, '/api/v1/auth/refresh', { method: 'POST', refreshToken: issued.refreshToken }),
      ]);
      assert.deepEqual([first.response.status, second.response.status].sort(), [200, 401]);
      const failed = first.response.status === 401 ? first : second;
      assert.equal(failed.body.error.code, 'REFRESH_TOKEN_REUSE_DETECTED');
      const state = await client.query(
        `SELECT session.revoked_at, count(*) FILTER (WHERE token.revoked_at IS NULL)::int AS live_tokens
         FROM auth_sessions AS session JOIN auth_refresh_tokens AS token ON token.session_id = session.id
         WHERE session.id = $1 GROUP BY session.id`,
        [issued.sessionId]
      );
      assert.ok(state.rows[0].revoked_at);
      assert.equal(state.rows[0].live_tokens, 0);
      const audit = await client.query(
        "SELECT count(*)::int AS count FROM audit_events WHERE entity_id = $1 AND event_code = 'auth.refresh.reuse_detected'",
        [issued.sessionId]
      );
      assert.equal(audit.rows[0].count, 1);
      const succeeded = first.response.status === 200 ? first : second;
      const descendant = decodeURIComponent(cookieValue(succeeded.response, 'everest_refresh'));
      assert.equal((await api(port, '/api/v1/auth/refresh', {
        method: 'POST', refreshToken: descendant,
      })).response.status, 401);
    });

    await t.test('lists only owned sessions with safe device metadata', async () => {
      const current = await issue(sessionService, userId, 'Mozilla/5.0 Windows Firefox/120.0');
      await issue(sessionService, userId, 'Mozilla/5.0 Android Chrome/120.0 Mobile');
      const foreign = await issue(sessionService, otherUserId);
      const listed = await api(port, '/api/v1/auth/sessions', { accessToken: current.accessToken });
      assert.equal(listed.response.status, 200);
      assert.ok(listed.body.data.sessions.some(({ current: isCurrent }) => isCurrent));
      assert.equal(listed.body.data.sessions.some(({ id }) => id === foreign.sessionId), false);
      const serialized = JSON.stringify(listed.body);
      for (const field of ['token_hash', 'refreshToken', 'accessToken', 'ip_address']) assert.equal(serialized.includes(field), false);
    });

    await t.test('revokes owned sessions, hides foreign sessions, and validates IDs', async () => {
      const current = await issue(sessionService, userId);
      const owned = await issue(sessionService, userId);
      const foreign = await issue(sessionService, otherUserId);
      const revoked = await api(port, `/api/v1/auth/sessions/${owned.sessionId}`, { method: 'DELETE', accessToken: current.accessToken });
      assert.equal(revoked.response.status, 200);
      assert.equal((await api(port, `/api/v1/auth/sessions/${owned.sessionId}`, {
        method: 'DELETE', accessToken: current.accessToken,
      })).response.status, 200);
      assert.equal((await api(port, `/api/v1/auth/sessions/${foreign.sessionId}`, { method: 'DELETE', accessToken: current.accessToken })).response.status, 404);
      for (const id of ['0', '01', '-1', '1.5', '1e2', '9223372036854775808']) {
        const result = await api(port, `/api/v1/auth/sessions/${id}`, { method: 'DELETE', accessToken: current.accessToken });
        assert.equal(result.body.error.code, 'INVALID_SESSION_ID');
      }
      const currentRevoked = await api(port, `/api/v1/auth/sessions/${current.sessionId}`, { method: 'DELETE', accessToken: current.accessToken });
      assert.match(currentRevoked.response.headers.get('set-cookie'), /everest_access=;/);
    });

    await t.test('logs out one session idempotently and logs out all user sessions only', async () => {
      const one = await issue(sessionService, userId);
      const loggedOut = await api(port, '/api/v1/auth/logout', {
        method: 'POST', accessToken: one.accessToken, refreshToken: one.refreshToken,
      });
      assert.equal(loggedOut.response.status, 200);
      assert.match(loggedOut.response.headers.get('set-cookie'), /everest_access=;/);
      assert.equal((await api(port, '/api/v1/auth/logout', { method: 'POST', refreshToken: one.refreshToken })).response.status, 200);
      assert.equal((await api(port, '/api/v1/auth/refresh', {
        method: 'POST', refreshToken: one.refreshToken,
      })).response.status, 401);

      const expiredAccess = await issue(sessionService, userId);
      assert.equal((await api(port, '/api/v1/auth/logout', {
        method: 'POST', accessToken: 'expired-or-invalid', refreshToken: expiredAccess.refreshToken,
      })).response.status, 200);
      const expiredAccessState = await client.query(
        'SELECT revoked_at FROM auth_sessions WHERE id = $1', [expiredAccess.sessionId]
      );
      assert.ok(expiredAccessState.rows[0].revoked_at);

      const current = await issue(sessionService, userId);
      await issue(sessionService, userId);
      const other = await issue(sessionService, otherUserId);
      const all = await api(port, '/api/v1/auth/logout-all', { method: 'POST', accessToken: current.accessToken });
      assert.equal(all.response.status, 200);
      const counts = await client.query(
        `SELECT user_id, count(*) FILTER (WHERE revoked_at IS NULL)::int AS live
         FROM auth_sessions WHERE user_id = ANY($1::bigint[]) GROUP BY user_id`,
        [[userId, otherUserId]]
      );
      assert.equal(counts.rows.find(({ user_id: id }) => id === userId).live, 0);
      assert.ok(counts.rows.find(({ user_id: id }) => id === otherUserId).live > 0);
      assert.equal((await api(port, '/api/v1/auth/sessions', { accessToken: current.accessToken })).response.status, 401);
      assert.equal((await api(port, '/api/v1/auth/refresh', {
        method: 'POST', refreshToken: current.refreshToken,
      })).response.status, 401);
      assert.equal((await api(port, '/api/v1/auth/refresh', { method: 'POST', refreshToken: other.refreshToken })).response.status, 200);
    });

    await t.test('rolls back rotation when replacement persistence fails', async () => {
      const issued = await issue(sessionService, userId);
      const failing = createSessionLifecycleService({
        config,
        repository: {
          ...sessionRepository,
          createRefreshToken: async () => { throw new Error('injected replacement failure'); },
        },
        auth: authRepository,
      });
      await assert.rejects(failing.refresh(issued.refreshToken), /injected replacement failure/);
      const stored = await client.query('SELECT used_at FROM auth_refresh_tokens WHERE session_id = $1', [issued.sessionId]);
      assert.equal(stored.rows[0].used_at, null);
    });

    await t.test('rolls back owned-session revocation when audit persistence fails', async () => {
      const current = await issue(sessionService, userId);
      const target = await issue(sessionService, userId);
      const failing = createSessionLifecycleService({
        config,
        auth: {
          ...authRepository,
          appendAuditEvent: async () => { throw new Error('injected audit failure'); },
        },
      });
      await assert.rejects(
        failing.revokeOwnedSession(userId, current.sessionId, target.sessionId),
        /injected audit failure/
      );
      const stored = await client.query(
        `SELECT session.revoked_at,
           count(*) FILTER (WHERE token.revoked_at IS NULL)::int AS live_tokens
         FROM auth_sessions AS session JOIN auth_refresh_tokens AS token ON token.session_id = session.id
         WHERE session.id = $1 GROUP BY session.id`,
        [target.sessionId]
      );
      assert.equal(stored.rows[0].revoked_at, null);
      assert.equal(stored.rows[0].live_tokens, 1);
    });
  } finally {
    await cleanup(client);
    await client.end();
    await new Promise((resolve) => server.close(resolve));
  }
});
