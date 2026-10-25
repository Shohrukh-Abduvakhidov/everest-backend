import assert from 'node:assert/strict';
import test from 'node:test';

import { deviceSummary, parseSessionId } from '../../src/services/session-lifecycle-service.js';
import { createRefreshToken, hashRefreshToken } from '../../src/utils/refresh-token.js';

test('creates opaque refresh tokens and hashes only canonical token input', () => {
  const first = createRefreshToken();
  const second = createRefreshToken();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
  assert.match(hashRefreshToken(first), /^[a-f0-9]{64}$/);
  assert.equal(hashRefreshToken('malformed'), null);
});

test('validates session IDs and derives bounded device summaries', () => {
  assert.equal(parseSessionId('9223372036854775807'), '9223372036854775807');
  for (const value of ['0', '-1', '01', '1.5', '1e2', '9223372036854775808']) {
    assert.throws(() => parseSessionId(value), (error) => error.code === 'INVALID_SESSION_ID');
  }
  assert.deepEqual(
    deviceSummary('Mozilla/5.0 (Windows NT 10.0) Chrome/120.0'),
    { browser: 'Chrome', operatingSystem: 'Windows', deviceType: 'desktop' }
  );
});
