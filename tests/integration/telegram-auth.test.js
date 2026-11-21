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

const fullScope = 'openid profile phone telegram:bot_access';
const secretIdToken = 'id-token-secret-value-must-not-leak';
const secretPhone = '+992900000777';
const runSeed = 7000000000 + (Date.now() % 1000000000);

class MockOidcProvider {
  // When set, the next callback uses this grant: { sub, id?, scope? } (undefined fields are omitted).
  grant = null;

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
    if (!this.grant) return { id_token: code, scope: fullScope };
    const tokenSet = { id_token: secretIdToken, access_token: 'access-token-secret-value' };
    if (this.grant.scope !== undefined) tokenSet.scope = this.grant.scope;
    return tokenSet;
  }

  async validateIdToken(code) {
    if (code === 'invalid-nonce') throw new AppError(401, 'TELEGRAM_NONCE_INVALID', 'Telegram authorization failed');
    if (code === 'wrong-audience' || code === 'wrong-issuer') {
      throw new AppError(401, 'TELEGRAM_ID_TOKEN_INVALID', 'Telegram authorization failed');
    }
    if (this.grant) {
      const claims = {
        iss: 'https://oauth.telegram.org', sub: this.grant.sub, nonce: 'n', iat: 1, exp: 2,
        name: 'Grant Test User', phone_number: secretPhone,
      };
      if (this.grant.id !== undefined) claims.id = this.grant.id;
      return claims;
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
  confirmations = [];
  confirmationStatus = 200;
  async sendConnectionConfirmation(chatId) {
    this.confirmations.push(chatId);
    if (this.confirmationStatus === 200) return;
    const error = new AppError(502, 'TELEGRAM_MESSAGE_FAILED', 'Telegram test message could not be delivered');
    error.telegramAccessUnavailable = this.confirmationStatus === 403;
    throw error;
  }

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
  const oidcProvider = new MockOidcProvider();
  const logLines = [];
  const logger = { info: (line) => logLines.push(line) };
  const service = createTelegramAuthTestService({
    config: testConfig, oidcProvider, botProvider, logger,
  });
  const app = createApp({
    telegramAuth: service.dependencies,
    authProtection: { config: testConfig },
    profile: { config: testConfig },
  });
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
      const disconnected = await client.query(
        "SELECT target_path FROM notifications WHERE user_id = $1 AND event_code = 'telegram.disconnected'",
        [first.userId]
      );
      assert.deepEqual(disconnected.rows, [{ target_path: '/profile' }]);
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
      assert.equal(botProvider.confirmations.length, 0, 'scope grant needs no confirmation message');
    });

    const auth = (user) => ({ authorization: `Bearer ${user.token}` });
    async function linkWith(user, grant) {
      const start = await request(port, '/api/v1/auth/telegram/link', { method: 'POST', headers: auth(user) });
      assert.equal(start.response.status, 200);
      oidcProvider.grant = grant;
      try {
        return await request(
          port,
          `/api/v1/auth/telegram/callback?code=grant&state=${encodeURIComponent(stateFrom(start.body))}`
        );
      } finally {
        oidcProvider.grant = null;
      }
    }
    async function loginWith(grant) {
      const start = await request(port, '/api/v1/auth/telegram/start');
      oidcProvider.grant = grant;
      try {
        return await request(
          port,
          `/api/v1/auth/telegram/callback?code=grant&state=${encodeURIComponent(stateFrom(start.body))}`
        );
      } finally {
        oidcProvider.grant = null;
      }
    }
    async function connectionOf(userId) {
      const result = await client.query(
        'SELECT status, chat_id::text AS chat_id FROM telegram_connections WHERE user_id = $1',
        [userId]
      );
      return result.rows[0] || null;
    }
    async function lastLinkAudit(userId) {
      const result = await client.query(
        `SELECT metadata FROM audit_events
         WHERE subject_user_id = $1 AND event_code = 'auth.telegram.linked'
         ORDER BY id DESC LIMIT 1`,
        [userId]
      );
      return result.rows[0].metadata;
    }
    const lastLog = () => JSON.parse(logLines.at(-1));

    const chat = (n) => String(runSeed + n);
    const cases = [
      {
        name: 'scope lists bot_access and id is present',
        grant: { sub: `grant-sub-${runSeed}-1`, id: runSeed + 1, scope: fullScope },
        expect: {
          connected: true, method: 'scope', chatId: chat(1), confirmation: false,
          diagnostics: { scopePresent: true, idPresent: true, idType: 'number', subNumeric: false, subMatchesId: null, chatIdSource: 'id' },
        },
      },
      {
        name: 'scope missing, id present, sendMessage 200',
        grant: { sub: `grant-sub-${runSeed}-2`, id: chat(2) },
        expect: {
          connected: true, method: 'probe', chatId: chat(2), confirmation: true,
          diagnostics: { scopePresent: false, idPresent: true, idType: 'string', chatIdSource: 'id' },
        },
      },
      {
        name: 'scope missing, id present, sendMessage 403',
        grant: { sub: `grant-sub-${runSeed}-3`, id: runSeed + 3 },
        status: 403,
        expect: {
          connected: false, method: 'probe_forbidden', chatId: null, confirmation: true,
          diagnostics: { scopePresent: false, idType: 'number' },
        },
      },
      {
        name: 'scope present without bot_access, sendMessage 200',
        grant: { sub: `grant-sub-${runSeed}-4`, id: runSeed + 4, scope: 'openid profile phone' },
        expect: {
          connected: true, method: 'probe', chatId: chat(4), confirmation: true,
          diagnostics: { scopePresent: true },
        },
      },
      {
        name: 'id missing, numeric sub is used as chat id',
        grant: { sub: chat(5), scope: fullScope },
        expect: {
          connected: true, method: 'scope', chatId: chat(5), confirmation: false,
          diagnostics: { idPresent: false, idType: 'absent', subNumeric: true, subMatchesId: null, chatIdSource: 'sub' },
        },
      },
      {
        name: 'id missing and sub not numeric: no chat id',
        grant: { sub: `grant-sub-${runSeed}-6`, scope: fullScope },
        expect: {
          connected: false, method: 'no_chat_id', chatId: null, confirmation: false,
          diagnostics: { idPresent: false, subNumeric: false, chatIdSource: null },
        },
      },
      {
        name: 'numeric sub differs from id: id wins',
        grant: { sub: chat(7), id: runSeed + 70, scope: fullScope },
        expect: {
          connected: true, method: 'scope', chatId: chat(70), confirmation: false,
          diagnostics: { subNumeric: true, subMatchesId: false, chatIdSource: 'id' },
        },
      },
      {
        name: 'numeric sub equals id',
        grant: { sub: chat(8), id: runSeed + 8 },
        expect: {
          connected: true, method: 'probe', chatId: chat(8), confirmation: true,
          diagnostics: { subNumeric: true, subMatchesId: true, scopePresent: false },
        },
      },
      {
        name: 'scope missing, sendMessage fails with 5xx',
        grant: { sub: `grant-sub-${runSeed}-9`, id: runSeed + 9 },
        status: 500,
        expect: {
          connected: false, method: 'probe_failed', chatId: null, confirmation: true,
          diagnostics: { scopePresent: false },
        },
      },
    ];

    const linkedUsers = {};
    for (const scenario of cases) {
      await t.test(`messaging grant: ${scenario.name}`, async () => {
        const user = await createUser(client);
        linkedUsers[scenario.name] = { user, grant: scenario.grant };
        botProvider.confirmationStatus = scenario.status ?? 200;
        const sentBefore = botProvider.confirmations.length;
        try {
          const callback = await linkWith(user, scenario.grant);
          assert.equal(callback.response.status, 200, JSON.stringify(callback.body));
          assert.equal(callback.body.data.status, 'linked');
          assert.equal(callback.body.data.messagingConnected, scenario.expect.connected);
        } finally {
          botProvider.confirmationStatus = 200;
        }

        const expectedChat = scenario.grant.id !== undefined ? String(scenario.grant.id) : scenario.grant.sub;
        if (scenario.expect.confirmation) {
          assert.deepEqual(botProvider.confirmations.slice(sentBefore), [expectedChat]);
        } else {
          assert.equal(botProvider.confirmations.length, sentBefore);
        }

        const connection = await connectionOf(user.userId);
        if (scenario.expect.chatId) {
          assert.deepEqual(connection, { status: 'active', chat_id: scenario.expect.chatId });
        } else {
          assert.equal(connection, null);
        }

        const metadata = await lastLinkAudit(user.userId);
        assert.equal(metadata.messagingConnected, scenario.expect.connected);
        assert.equal(metadata.messagingMethod, scenario.expect.method);
        for (const [key, value] of Object.entries(scenario.expect.diagnostics)) {
          assert.deepEqual(metadata[key], value, key);
        }
        assert.deepEqual(metadata.claimNames, [...metadata.claimNames].sort());
        assert.ok(metadata.claimNames.includes('sub'));
        assert.equal(metadata.claimNames.includes('id'), scenario.grant.id !== undefined);
        assert.deepEqual(
          metadata.scopes,
          scenario.grant.scope === undefined ? [] : scenario.grant.scope.split(' ')
        );

        const log = lastLog();
        assert.equal(log.event, 'auth.telegram.messaging_grant');
        assert.equal(log.flow, 'link');
        assert.equal(log.userId, String(user.userId));
        assert.equal(log.messagingMethod, scenario.expect.method);
      });
    }

    await t.test('profile and link start expose messagingConnected', async () => {
      const connected = linkedUsers['scope missing, id present, sendMessage 200'].user;
      const forbidden = linkedUsers['scope missing, id present, sendMessage 403'].user;
      const unlinked = await createUser(client);
      for (const user of [connected, forbidden, unlinked]) {
        await client.query(
          'INSERT INTO user_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
          [user.userId]
        );
      }

      const connectedProfile = await request(port, '/api/v1/profile', { headers: auth(connected) });
      assert.equal(connectedProfile.response.status, 200, JSON.stringify(connectedProfile.body));
      assert.equal(connectedProfile.body.data.telegramLinked, true);
      assert.equal(connectedProfile.body.data.messagingConnected, true);

      const forbiddenProfile = await request(port, '/api/v1/profile', { headers: auth(forbidden) });
      assert.equal(forbiddenProfile.body.data.telegramLinked, true);
      assert.equal(forbiddenProfile.body.data.messagingConnected, false);

      const unlinkedProfile = await request(port, '/api/v1/profile', { headers: auth(unlinked) });
      assert.equal(unlinkedProfile.body.data.telegramLinked, false);
      assert.equal(unlinkedProfile.body.data.messagingConnected, false);

      for (const [user, expected] of [[connected, true], [forbidden, false]]) {
        const start = await request(port, '/api/v1/auth/telegram/link', { method: 'POST', headers: auth(user) });
        stateFrom(start.body);
        assert.equal(start.body.data.messagingConnected, expected);
      }

      const test = await request(port, '/api/v1/auth/telegram/test-message', {
        method: 'POST', headers: auth(forbidden),
      });
      assert.equal(test.response.status, 409);
      assert.equal(test.body.error.code, 'TELEGRAM_CONNECTION_UNAVAILABLE');
    });

    await t.test('login without scope confirms once, then reuses the active connection', async () => {
      const { user, grant } = linkedUsers['scope missing, id present, sendMessage 403'];
      const sentBefore = botProvider.confirmations.length;

      const first = await loginWith(grant);
      assert.equal(first.body.data.status, 'authenticated');
      assert.equal(first.body.data.messagingConnected, true);
      assert.deepEqual(botProvider.confirmations.slice(sentBefore), [String(grant.id)]);
      assert.deepEqual(await connectionOf(user.userId), { status: 'active', chat_id: String(grant.id) });
      assert.equal(lastLog().flow, 'login');
      assert.equal(lastLog().messagingMethod, 'probe');

      const second = await loginWith(grant);
      assert.equal(second.body.data.messagingConnected, true);
      assert.equal(botProvider.confirmations.length, sentBefore + 1, 'no repeated confirmation');
      assert.equal(lastLog().messagingMethod, 'existing');

      const unknown = await loginWith({ sub: `grant-sub-${runSeed}-unknown` });
      assert.equal(unknown.body.data.status, 'linking_required');
      assert.equal(unknown.body.data.messagingConnected, false);
      assert.equal(lastLog().messagingMethod, 'linking_required');
    });

    await t.test('diagnostics never contain tokens, phones, names or Telegram identifiers', async () => {
      const audits = await client.query(
        "SELECT metadata FROM audit_events WHERE event_code = 'auth.telegram.linked' AND subject_user_id = ANY($1::bigint[])",
        [fixtureUserIds]
      );
      const haystack = [...logLines, ...audits.rows.map((row) => JSON.stringify(row.metadata))].join('\n');
      assert.ok(logLines.length >= cases.length);
      for (const secret of [secretIdToken, 'access-token-secret-value', secretPhone, 'Grant Test User', 'grant-sub-']) {
        assert.equal(haystack.includes(secret), false, `leaked ${secret}`);
      }
      for (const n of [1, 2, 3, 4, 5, 7, 8, 9, 70]) {
        assert.equal(haystack.includes(chat(n)), false, `leaked identifier ${n}`);
      }
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (fixtureUserIds.length) {
      await client.query('DELETE FROM audit_events WHERE actor_user_id = ANY($1::bigint[])', [fixtureUserIds]);
      await client.query(
        `DELETE FROM notification_deliveries WHERE telegram_connection_id IN (
           SELECT id FROM telegram_connections WHERE user_id = ANY($1::bigint[]))`,
        [fixtureUserIds]
      );
      await client.query('DELETE FROM notifications WHERE user_id = ANY($1::bigint[])', [fixtureUserIds]);
      await client.query('DELETE FROM telegram_connections WHERE user_id = ANY($1::bigint[])', [fixtureUserIds]);
      await client.query('DELETE FROM auth_identities WHERE user_id = ANY($1::bigint[])', [fixtureUserIds]);
      await client.query('DELETE FROM telegram_oidc_states WHERE state_hash = ANY($1::text[])', [fixtureStateHashes]);
      await client.query(
        'DELETE FROM auth_refresh_tokens WHERE session_id IN (SELECT id FROM auth_sessions WHERE user_id = ANY($1::bigint[]))',
        [fixtureUserIds]
      );
      await client.query('DELETE FROM auth_sessions WHERE user_id = ANY($1::bigint[])', [fixtureUserIds]);
      await client.query('DELETE FROM user_passwords WHERE user_id = ANY($1::bigint[])', [fixtureUserIds]);
      await client.query('DELETE FROM user_profiles WHERE user_id = ANY($1::bigint[])', [fixtureUserIds]);
      await client.query('DELETE FROM users WHERE id = ANY($1::bigint[])', [fixtureUserIds]);
    } else {
      await client.query('DELETE FROM telegram_oidc_states WHERE state_hash = ANY($1::text[])', [fixtureStateHashes]);
    }
    await client.end();
    await pool.end();
  }
});
