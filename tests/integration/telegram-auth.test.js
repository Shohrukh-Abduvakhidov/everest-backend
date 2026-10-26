import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import { createApp } from '../../src/app.js';
import pool from '../../src/configs/db.js';
import env from '../../src/configs/env.js';
import { createAccessToken } from '../../src/services/auth/session-token-service.js';
import AppError from '../../src/utils/app-error.js';
import { sha256Hex } from '../../src/utils/telegram-crypto.js';
import { createTelegramAuthTestService } from '../helpers/service-factories.js';

const { Client } = pg;
const fixtureUserIds = [];
const fixtureStateHashes = [];
const testConfig = {
  ...env,
  jwtAccessSecret: 'integration-jwt-secret-that-is-longer-than-32-characters',
  authSessionTtlSeconds: 900,
  telegramOidcStateTtlSeconds: 600,
  telegram: {
    discoveryUrl: 'https://oauth.telegram.org/.well-known/openid-configuration',
    clientId: 'integration-bot-id',
    clientSecret: 'integration-client-secret-long-enough',
    redirectUri: 'https://example.test/api/v1/auth/telegram/callback',
    botUsername: 'everest_test_bot',
    botToken: 'mock-bot-token',
    webhookSecret: 'mock-webhook-secret',
  },
};

class MockOidcProvider {
  async buildAuthorizationUrl({ state, nonce, codeChallenge }) {
    const url = new URL('https://oauth.telegram.org/auth');
    url.search = new URLSearchParams({
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  async exchangeCode({ code }) {
    return { id_token: code, scope: 'openid profile phone telegram:bot_access' };
  }

  async validateIdToken(code) {
    if (code === 'invalid-nonce') throw new AppError(401, 'TELEGRAM_NONCE_INVALID', 'Telegram authorization failed');
    if (code === 'wrong-audience' || code === 'wrong-issuer') {
      throw new AppError(401, 'TELEGRAM_ID_TOKEN_INVALID', 'Telegram authorization failed');
    }
    return {
      iss: 'https://oauth.telegram.org', sub: code, id: 9000001,
      name: 'Verified Telegram User', preferred_username: 'verified_user',
    };
  }
}

class MockBotProvider {
  sent = 0;
  failUnavailable = false;
  async sendTestMessage() {
    if (this.failUnavailable) {
      const error = new AppError(502, 'TELEGRAM_MESSAGE_FAILED', 'Telegram test message could not be delivered');
      error.telegramAccessUnavailable = true;
      throw error;
    }
    this.sent += 1;
  }
}

async function createUser(client) {
  const user = await client.query(
    "INSERT INTO users (status) VALUES ('active') RETURNING id"
  );
  const userId = user.rows[0].id;
  fixtureUserIds.push(userId);
  await client.query('INSERT INTO user_passwords (user_id, password_hash) VALUES ($1, $2)', [userId, 'test-hash']);
  const expiresAt = new Date(Date.now() + 900000);
  const session = await client.query(
    'INSERT INTO auth_sessions (user_id, expires_at) VALUES ($1, $2) RETURNING id',
    [userId, expiresAt]
  );
  const sessionId = session.rows[0].id;
  const token = await createAccessToken({ userId, sessionId, expiresAt }, testConfig.jwtAccessSecret);
  return { userId, token };
}

async function request(port, path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
  return { response, body: await response.json() };
}

function stateFrom(body) {
  const state = new URL(body.data.authorizationUrl).searchParams.get('state');
  fixtureStateHashes.push(sha256Hex(state));
  return state;
}

test('Telegram start/callback/link/replay/validation/unlink integration', async (t) => {
  const client = new Client(env.database);
  const botProvider = new MockBotProvider();
  const service = createTelegramAuthTestService({
    config: testConfig, oidcProvider: new MockOidcProvider(), botProvider,
  });
  const app = createApp({ telegramAuth: service.dependencies });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const port = server.address().port;
  await client.connect();

  try {
    await t.test('start and unknown callback require linking', async () => {
      const started = await request(port, '/api/v1/auth/telegram/start');
      assert.equal(started.response.status, 200);
      const state = stateFrom(started.body);
      assert.ok(state);
      assert.equal(new URL(started.body.data.authorizationUrl).searchParams.get('code_challenge_method'), 'S256');
      const callback = await request(port, `/api/v1/auth/telegram/callback?code=unknown-sub&state=${encodeURIComponent(state)}`);
      assert.equal(callback.response.status, 200);
      assert.equal(callback.body.data.status, 'linking_required');
      assert.equal(callback.response.headers.get('set-cookie'), null);

      const replay = await request(port, `/api/v1/auth/telegram/callback?code=unknown-sub&state=${encodeURIComponent(state)}`);
      assert.equal(replay.response.status, 401);
      assert.equal(replay.body.error.code, 'TELEGRAM_STATE_INVALID');
    });

    await t.test('expired state is rejected', async () => {
      const started = await request(port, '/api/v1/auth/telegram/start');
      const state = stateFrom(started.body);
      await client.query(
        `UPDATE telegram_oidc_states
         SET created_at = CURRENT_TIMESTAMP - INTERVAL '2 seconds',
             expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
         WHERE state_hash = $1`,
        [sha256Hex(state)]
      );
      const callback = await request(port, `/api/v1/auth/telegram/callback?code=x&state=${encodeURIComponent(state)}`);
      assert.equal(callback.response.status, 401);
    });

    await t.test('authorization error consumes state exactly once', async () => {
      const started = await request(port, '/api/v1/auth/telegram/start');
      const state = stateFrom(started.body);
      const denied = await request(
        port,
        `/api/v1/auth/telegram/callback?error=access_denied&state=${encodeURIComponent(state)}`
      );
      assert.equal(denied.response.status, 401);
      assert.equal(denied.body.error.code, 'TELEGRAM_AUTHORIZATION_DENIED');

      const replay = await request(
        port,
        `/api/v1/auth/telegram/callback?error=access_denied&state=${encodeURIComponent(state)}`
      );
      assert.equal(replay.response.status, 401);
      assert.equal(replay.body.error.code, 'TELEGRAM_STATE_INVALID');
    });

    for (const [code, expected] of [
      ['invalid-nonce', 'TELEGRAM_NONCE_INVALID'],
      ['wrong-audience', 'TELEGRAM_ID_TOKEN_INVALID'],
      ['wrong-issuer', 'TELEGRAM_ID_TOKEN_INVALID'],
    ]) {
      await t.test(`${code} is rejected`, async () => {
        const started = await request(port, '/api/v1/auth/telegram/start');
        const callback = await request(
          port,
          `/api/v1/auth/telegram/callback?code=${code}&state=${encodeURIComponent(stateFrom(started.body))}`
        );
        assert.equal(callback.response.status, 401);
        assert.equal(callback.body.error.code, expected);
      });
    }

    const first = await createUser(client);
    const second = await createUser(client);
    await t.test('authenticated linking, login, test message, duplicate prevention, and unlinking', async () => {
      const linkStart = await request(port, '/api/v1/auth/telegram/link', {
        method: 'POST', headers: { authorization: `Bearer ${first.token}` },
      });
      assert.equal(linkStart.response.status, 200);
      const linkCallback = await request(
        port,
        `/api/v1/auth/telegram/callback?code=shared-subject&state=${encodeURIComponent(stateFrom(linkStart.body))}`
      );
      assert.equal(linkCallback.body.data.status, 'linked');
      assert.equal(linkCallback.body.data.messagingConnected, true);

      const loginStart = await request(port, '/api/v1/auth/telegram/start');
      const loginCallback = await request(
        port,
        `/api/v1/auth/telegram/callback?code=shared-subject&state=${encodeURIComponent(stateFrom(loginStart.body))}`
      );
      assert.equal(loginCallback.body.data.status, 'authenticated');
      assert.equal(loginCallback.body.data.user.id, first.userId);
      assert.match(loginCallback.body.data.user.id, /^[1-9][0-9]*$/);
      assert.match(loginCallback.response.headers.get('set-cookie'), /^everest_access=/);
      assert.match(loginCallback.response.headers.get('set-cookie'), /everest_refresh=/);
      assert.equal(JSON.stringify(loginCallback.body).includes('accessToken'), false);
      assert.equal(JSON.stringify(loginCallback.body).includes('refreshToken'), false);

      await client.query("UPDATE users SET status = 'blocked', blocked_at = CURRENT_TIMESTAMP WHERE id = $1", [first.userId]);
      const blockedLoginStart = await request(port, '/api/v1/auth/telegram/start');
      const blockedLogin = await request(
        port,
        `/api/v1/auth/telegram/callback?code=shared-subject&state=${encodeURIComponent(stateFrom(blockedLoginStart.body))}`
      );
      assert.equal(blockedLogin.response.status, 403);
      assert.equal(blockedLogin.body.error.code, 'ACCOUNT_NOT_ACTIVE');
      await client.query("UPDATE users SET status = 'active', blocked_at = NULL WHERE id = $1", [first.userId]);

      const message = await request(port, '/api/v1/auth/telegram/test-message', {
        method: 'POST', headers: { authorization: `Bearer ${first.token}` },
      });
      assert.equal(message.body.data.status, 'sent');
      assert.equal(botProvider.sent, 1);

      botProvider.failUnavailable = true;
      const blockedMessage = await request(port, '/api/v1/auth/telegram/test-message', {
        method: 'POST', headers: { authorization: `Bearer ${first.token}` },
      });
      assert.equal(blockedMessage.response.status, 502);
      assert.equal(blockedMessage.body.error.code, 'TELEGRAM_MESSAGE_FAILED');
      const blockedConnection = await client.query(
        'SELECT status FROM telegram_connections WHERE user_id = $1',
        [first.userId]
      );
      assert.equal(blockedConnection.rows[0].status, 'blocked');
      botProvider.failUnavailable = false;

      const duplicateStart = await request(port, '/api/v1/auth/telegram/link', {
        method: 'POST', headers: { authorization: `Bearer ${second.token}` },
      });
      const duplicate = await request(
        port,
        `/api/v1/auth/telegram/callback?code=shared-subject&state=${encodeURIComponent(stateFrom(duplicateStart.body))}`
      );
      assert.equal(duplicate.response.status, 409);
      assert.equal(duplicate.body.error.code, 'TELEGRAM_IDENTITY_ALREADY_LINKED');

      const unlink = await request(port, '/api/v1/auth/telegram/link', {
        method: 'DELETE', headers: { authorization: `Bearer ${first.token}` },
      });
      assert.equal(unlink.response.status, 200);
      assert.equal(unlink.body.data.status, 'unlinked');
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (fixtureUserIds.length) {
      await client.query('DELETE FROM audit_events WHERE actor_user_id = ANY($1::bigint[])', [fixtureUserIds]);
      await client.query('DELETE FROM telegram_connections WHERE user_id = ANY($1::bigint[])', [fixtureUserIds]);
      await client.query('DELETE FROM auth_identities WHERE user_id = ANY($1::bigint[])', [fixtureUserIds]);
      await client.query('DELETE FROM telegram_oidc_states WHERE state_hash = ANY($1::text[])', [fixtureStateHashes]);
      await client.query(
        'DELETE FROM auth_refresh_tokens WHERE session_id IN (SELECT id FROM auth_sessions WHERE user_id = ANY($1::bigint[]))',
        [fixtureUserIds]
      );
      await client.query('DELETE FROM auth_sessions WHERE user_id = ANY($1::bigint[])', [fixtureUserIds]);
      await client.query('DELETE FROM user_passwords WHERE user_id = ANY($1::bigint[])', [fixtureUserIds]);
      await client.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [fixtureUserIds]);
    } else {
      await client.query('DELETE FROM telegram_oidc_states WHERE state_hash = ANY($1::text[])', [fixtureStateHashes]);
    }
    await client.end();
    await pool.end();
  }
});
