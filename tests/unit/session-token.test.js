import assert from 'node:assert/strict';
import test from 'node:test';

import { SignJWT } from 'jose';

import {
  createAccessToken,
  verifyAccessToken,
} from '../../src/services/auth/session-token-service.js';

const secret = 'session-token-unit-secret-longer-than-32-characters';
const key = new TextEncoder().encode(secret);

test('session tokens preserve numeric identifiers as decimal strings', async () => {
  const expiresAt = new Date(Date.now() + 60_000);
  const token = await createAccessToken({
    userId: '9223372036854775806',
    sessionId: '9223372036854775807',
    expiresAt,
  }, secret);

  assert.deepEqual(await verifyAccessToken(token, secret), {
    userId: '9223372036854775806',
    sessionId: '9223372036854775807',
  });
});

test('session tokens reject malformed or non-string internal identifiers', async () => {
  for (const [userId, sessionId] of [
    ['1', 'not-an-id'],
    ['01', '2'],
    ['0', '2'],
    ['9223372036854775808', '2'],
  ]) {
    const malformed = await new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setExpirationTime('1m')
      .sign(key);

    await assert.rejects(
      verifyAccessToken(malformed, secret),
      (error) => error.code === 'AUTHENTICATION_REQUIRED'
    );
  }
  await assert.rejects(
    createAccessToken({ userId: 1, sessionId: '2', expiresAt: new Date(Date.now() + 60_000) }, secret),
    /Invalid internal identifier/
  );
});
