import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import { createApp } from '../../src/app.js';
import env from '../../src/configs/env.js';
import * as authRepository from '../../src/repositories/auth-repository.js';
import * as sessionRepository from '../../src/repositories/session-repository.js';
import { withTransaction } from '../../src/repositories/transaction-repository.js';
import { hashRefreshToken } from '../../src/utils/refresh-token.js';
import {
  createSessionLifecycleTestService,
  createSessionTestService,
  createTelegramAuthTestService,
} from '../helpers/service-factories.js';

const { Client } = pg;
const fixtureIds = [];
const csrfByToken = new Map();
const config = {
  ...env,
  jwtAccessSecret: 'session-lifecycle-integration-secret-longer-than-32-characters',
  authSessionTtlSeconds: 900,
  authRefreshTtlSeconds: 86400,
  authRefreshReuseGraceSeconds: 30,
  authRefreshSessionRateLimit: 1000,
  authRefreshIpRateLimit: 10000,
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
  const result = await withTransaction((client) => sessionService.issueSession({
    userId, requestContext: { userAgent, ipAddress: '127.0.0.1' }, client,
  }));
  csrfByToken.set(result.refreshToken, result.csrfToken);
  csrfByToken.set(result.accessToken, result.csrfToken);
  return result;
}

function cookie(name, value) {
  return `${name}=${encodeURIComponent(value)}`;
}

function cookieValue(response, name) {
  const header = response.headers.get('set-cookie') || '';
  return header.match(new RegExp(`${name}=([^;,]+)`))?.[1];
}

async function api(port, path, {
  method = 'GET', accessToken, refreshToken, cookieAccess = false,
  csrfToken: suppliedCsrf, omitCsrf = false,
} = {}) {
  const cookies = [];
  if (accessToken) cookies.push(cookie('everest_access', accessToken));
  if (refreshToken) cookies.push(cookie('everest_refresh', refreshToken));
  const csrfToken = omitCsrf
    ? null
    : suppliedCsrf || csrfByToken.get(refreshToken || (cookieAccess ? accessToken : null));
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(accessToken && !cookieAccess ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(cookies.length ? { cookie: cookies.join('; ') } : {}),
      ...(cookieAccess || csrfToken ? { origin: 'http://localhost:3000' } : {}),
      ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
    },
  });
  const replacement = cookieValue(response, 'everest_refresh');
  const replacementCsrf = cookieValue(response, 'everest_csrf');
  if (replacement && (replacementCsrf || csrfToken)) {
    csrfByToken.set(
      decodeURIComponent(replacement),
      replacementCsrf ? decodeURIComponent(replacementCsrf) : csrfToken,
    );
  }
  return { response, body: await response.json() };
}

function refreshCookie(response) {
  const value = cookieValue(response, 'everest_refresh');
  return value ? decodeURIComponent(value) : value;
}

function refresh(port, refreshToken) {
  return api(port, '/api/v1/auth/refresh', { method: 'POST', refreshToken });
}

async function listen(app) {
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  return { server, port: server.address().port };
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
  const clearRefreshCounters = () => client.query(
    "DELETE FROM auth_security_counters WHERE scope IN ('refresh.ip', 'refresh.session')"
  );
  const sessionState = async (sessionId) => (await client.query(
    `SELECT session.revoked_at,
       count(*) FILTER (WHERE token.revoked_at IS NULL)::int AS live_tokens,
       count(*) FILTER (WHERE token.revoked_at IS NULL AND token.used_at IS NULL)::int AS live_unused
     FROM auth_sessions AS session JOIN auth_refresh_tokens AS token ON token.session_id = session.id
     WHERE session.id = $1 GROUP BY session.id`,
    [sessionId]
  )).rows[0];
  const auditCount = async (sessionId, code) => (await client.query(
    'SELECT count(*)::int AS count FROM audit_events WHERE entity_id = $1 AND event_code = $2',
    [sessionId, code]
  )).rows[0].count;
  const tokenUsedAt = async (token) => (await client.query(
    'SELECT used_at FROM auth_refresh_tokens WHERE token_hash = $1', [hashRefreshToken(token)]
  )).rows[0].used_at;
  await clearRefreshCounters();
  const sessionService = createSessionTestService({ config });
  const lifecycle = createSessionLifecycleTestService({ config });
  const authService = createTelegramAuthTestService({ config });
  const app = createApp({
    telegramAuth: authService.dependencies,
    sessionLifecycle: lifecycle.dependencies,
  });
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

    await t.test('serializes concurrent refresh and keeps one chain after the grace replay', async () => {
      const issued = await issue(sessionService, userId);
      const [first, second] = await Promise.all([
        refresh(port, issued.refreshToken),
        refresh(port, issued.refreshToken),
      ]);
      assert.deepEqual([first.response.status, second.response.status], [200, 200]);
      const [a, b] = [first, second].map(({ response }) => refreshCookie(response));
      assert.notEqual(a, b);
      assert.equal(await auditCount(issued.sessionId, 'auth.refresh.grace_reissued'), 1);
      // Whichever sibling rotates first closes the other branch.
      assert.equal((await refresh(port, a)).response.status, 200);
      const stale = await refresh(port, b);
      assert.equal(stale.response.status, 401);
      assert.equal(stale.body.error.code, 'REFRESH_TOKEN_REUSE_DETECTED');
      assert.ok((await sessionState(issued.sessionId)).revoked_at);
    });

    await t.test('re-issues a pair for a replay inside the window without extending the refresh lifetime', async () => {
      const issued = await issue(sessionService, userId);
      const original = await client.query(
        'SELECT expires_at FROM auth_refresh_tokens WHERE token_hash = $1', [hashRefreshToken(issued.refreshToken)]
      );
      const lost = await refresh(port, issued.refreshToken);
      assert.equal(lost.response.status, 200);
      const usedAt = await tokenUsedAt(issued.refreshToken);

      const replay = await refresh(port, issued.refreshToken);
      assert.equal(replay.response.status, 200);
      assert.equal(replay.body.data.status, 'refreshed');
      assert.ok(cookieValue(replay.response, 'everest_access'));
      const reissued = refreshCookie(replay.response);
      assert.notEqual(reissued, refreshCookie(lost.response));
      const stored = await client.query(
        'SELECT session_id, expires_at FROM auth_refresh_tokens WHERE token_hash = $1', [hashRefreshToken(reissued)]
      );
      assert.equal(stored.rows[0].session_id, issued.sessionId);
      assert.equal(stored.rows[0].expires_at.getTime(), original.rows[0].expires_at.getTime());
      assert.equal(new Date(replay.body.data.refreshExpiresAt).getTime(), original.rows[0].expires_at.getTime());
      // The window is anchored at the first use: a replay does not move it.
      assert.equal((await tokenUsedAt(issued.refreshToken)).getTime(), usedAt.getTime());
      assert.equal((await sessionState(issued.sessionId)).revoked_at, null);
      assert.equal(await auditCount(issued.sessionId, 'auth.refresh.grace_reissued'), 1);
      assert.equal(await auditCount(issued.sessionId, 'auth.refresh.reuse_detected'), 0);

      // The client carries on with the re-issued token.
      const next = await refresh(port, reissued);
      assert.equal(next.response.status, 200);
      assert.equal((await sessionState(issued.sessionId)).live_unused, 1);
    });

    await t.test('treats a replay outside the window as theft', async () => {
      const issued = await issue(sessionService, userId);
      assert.equal((await refresh(port, issued.refreshToken)).response.status, 200);
      await client.query(
        `UPDATE auth_refresh_tokens SET used_at = used_at - make_interval(secs => $2)
         WHERE token_hash = $1`,
        [hashRefreshToken(issued.refreshToken), config.authRefreshReuseGraceSeconds + 1]
      );
      const replay = await refresh(port, issued.refreshToken);
      assert.equal(replay.response.status, 401);
      assert.equal(replay.body.error.code, 'REFRESH_TOKEN_REUSE_DETECTED');
      assert.match(replay.response.headers.get('set-cookie'), /everest_refresh=;/);
      const state = await sessionState(issued.sessionId);
      assert.ok(state.revoked_at);
      assert.equal(state.live_tokens, 0);
      assert.equal(await auditCount(issued.sessionId, 'auth.refresh.reuse_detected'), 1);
      assert.equal(await auditCount(issued.sessionId, 'auth.refresh.grace_reissued'), 0);
    });

    await t.test('turns the window off when the grace period is zero', async () => {
      const strictApp = createApp({
        telegramAuth: authService.dependencies,
        sessionLifecycle: { ...lifecycle.dependencies, config: { ...config, authRefreshReuseGraceSeconds: 0 } },
      });
      const strict = await listen(strictApp);
      try {
        const issued = await issue(sessionService, userId);
        assert.equal((await refresh(strict.port, issued.refreshToken)).response.status, 200);
        const replay = await refresh(strict.port, issued.refreshToken);
        assert.equal(replay.body.error.code, 'REFRESH_TOKEN_REUSE_DETECTED');
      } finally {
        await new Promise((resolve) => strict.server.close(resolve));
      }
    });

    await t.test('rejects a replay once the chain moved on, and never touches another session', async () => {
      const victim = await issue(sessionService, userId);
      const bystander = await issue(sessionService, otherUserId);
      const stolen = victim.refreshToken;
      const rotated = await refresh(port, stolen);
      // The legitimate client already rotated past the stolen token inside the window.
      assert.equal((await refresh(port, refreshCookie(rotated.response))).response.status, 200);
      const replay = await refresh(port, stolen);
      assert.equal(replay.response.status, 401);
      assert.equal(replay.body.error.code, 'REFRESH_TOKEN_REUSE_DETECTED');
      assert.ok((await sessionState(victim.sessionId)).revoked_at);
      assert.equal(await auditCount(victim.sessionId, 'auth.refresh.grace_reissued'), 0);

      // A token revoked by logout gets no grace either.
      const loggedOut = await issue(sessionService, userId);
      const used = await refresh(port, loggedOut.refreshToken);
      await api(port, '/api/v1/auth/logout', { method: 'POST', refreshToken: refreshCookie(used.response) });
      assert.equal((await refresh(port, loggedOut.refreshToken)).response.status, 401);
      assert.equal(await auditCount(loggedOut.sessionId, 'auth.refresh.grace_reissued'), 0);

      assert.equal((await sessionState(bystander.sessionId)).revoked_at, null);
      assert.equal((await refresh(port, bystander.refreshToken)).response.status, 200);
    });

    await t.test('limits refresh per session and separately per IP', async () => {
      await clearRefreshCounters();
      const sessionLimited = await listen(createApp({
        telegramAuth: { ...authService.dependencies, config: { ...config, authRefreshSessionRateLimit: 3 } },
        sessionLifecycle: lifecycle.dependencies,
      }));
      try {
        const busy = await issue(sessionService, userId);
        let token = busy.refreshToken;
        for (let index = 0; index < 3; index += 1) {
          const result = await refresh(sessionLimited.port, token);
          assert.equal(result.response.status, 200);
          token = refreshCookie(result.response);
        }
        // The key is the session, so rotation does not reset it.
        const limited = await refresh(sessionLimited.port, token);
        assert.equal(limited.response.status, 429);
        assert.equal(limited.body.error.code, 'AUTH_RATE_LIMITED');
        assert.ok(Number(limited.response.headers.get('retry-after')) >= 1);
        assert.equal(limited.response.headers.get('set-cookie'), null);
        // Another session behind the same address is unaffected.
        const neighbour = await issue(sessionService, userId);
        assert.equal((await refresh(sessionLimited.port, neighbour.refreshToken)).response.status, 200);
      } finally {
        await new Promise((resolve) => sessionLimited.server.close(resolve));
      }

      await clearRefreshCounters();
      const ipLimited = await listen(createApp({
        telegramAuth: {
          ...authService.dependencies,
          config: { ...config, authPublicRateLimit: 1, authRefreshIpRateLimit: 3 },
        },
        sessionLifecycle: lifecycle.dependencies,
      }));
      try {
        // The shared public limit (1) does not apply to refresh; its own IP limit (3) does.
        for (let index = 0; index < 3; index += 1) {
          const own = await issue(sessionService, userId);
          assert.equal((await refresh(ipLimited.port, own.refreshToken)).response.status, 200);
        }
        const fourth = await issue(sessionService, userId);
        const limited = await refresh(ipLimited.port, fourth.refreshToken);
        assert.equal(limited.response.status, 429);
        assert.equal(limited.response.headers.get('set-cookie'), null);
      } finally {
        await new Promise((resolve) => ipLimited.server.close(resolve));
        await clearRefreshCounters();
      }
    });

    await t.test('keeps the cookies on a server error and clears them only on 401', async () => {
      const broken = await listen(createApp({
        telegramAuth: authService.dependencies,
        sessionLifecycle: {
          ...lifecycle.dependencies,
          transaction: async () => { throw new Error('database unavailable'); },
        },
      }));
      try {
        const issued = await issue(sessionService, userId);
        const failed = await refresh(broken.port, issued.refreshToken);
        assert.equal(failed.response.status, 500);
        assert.equal(failed.body.error.code, 'INTERNAL_ERROR');
        assert.equal(failed.response.headers.get('set-cookie'), null);
        // Nothing was consumed: the same token still works once the server recovers.
        assert.equal(await tokenUsedAt(issued.refreshToken), null);
        assert.equal((await refresh(port, issued.refreshToken)).response.status, 200);
      } finally {
        await new Promise((resolve) => broken.server.close(resolve));
      }
      const rejected = await refresh(port, 'not-a-real-token');
      assert.equal(rejected.response.status, 401);
      assert.match(rejected.response.headers.get('set-cookie'), /everest_refresh=;/);
    });

    await t.test('revokes the whole family, descendants included, on reuse', async () => {
      const issued = await issue(sessionService, userId);
      const first = await refresh(port, issued.refreshToken);
      await client.query(
        `UPDATE auth_refresh_tokens SET used_at = used_at - make_interval(secs => $2)
         WHERE token_hash = $1`,
        [hashRefreshToken(issued.refreshToken), config.authRefreshReuseGraceSeconds + 1]
      );
      const failed = await refresh(port, issued.refreshToken);
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
      assert.equal((await refresh(port, refreshCookie(first.response))).response.status, 401);
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

    await t.test('requires a session-bound CSRF token for cookie-authenticated mutations', async () => {
      const csrfUserId = await createUser(client);
      const first = await issue(sessionService, csrfUserId);
      const second = await issue(sessionService, csrfUserId);

      const missing = await api(port, '/api/v1/auth/logout-all', {
        method: 'POST', accessToken: first.accessToken, cookieAccess: true, omitCsrf: true,
      });
      assert.equal(missing.response.status, 403);
      assert.equal(missing.body.error.code, 'CSRF_TOKEN_INVALID');

      const invalid = await api(port, '/api/v1/auth/logout-all', {
        method: 'POST', accessToken: first.accessToken, cookieAccess: true, csrfToken: 'invalid',
      });
      assert.equal(invalid.response.status, 403);
      assert.equal(invalid.body.error.code, 'CSRF_TOKEN_INVALID');

      const crossSession = await api(port, '/api/v1/auth/logout-all', {
        method: 'POST', accessToken: first.accessToken, cookieAccess: true,
        csrfToken: second.csrfToken,
      });
      assert.equal(crossSession.response.status, 403);

      const valid = await api(port, '/api/v1/auth/logout-all', {
        method: 'POST', accessToken: first.accessToken, cookieAccess: true,
      });
      assert.equal(valid.response.status, 200);
    });

    await t.test('rolls back rotation when replacement persistence fails', async () => {
      const issued = await issue(sessionService, userId);
      const failing = createSessionLifecycleTestService({
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
      const failing = createSessionLifecycleTestService({
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
    await clearRefreshCounters();
    await cleanup(client);
    await client.end();
    await new Promise((resolve) => server.close(resolve));
  }
});
