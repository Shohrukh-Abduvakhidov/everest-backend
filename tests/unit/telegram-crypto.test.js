import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPkcePair,
  decryptStateSecret,
  encryptStateSecret,
  randomBase64Url,
  safeHashEquals,
  sha256Hex,
} from '../../src/utils/telegram-crypto.js';

test('PKCE, state, nonce, hashing, and encrypted verifier helpers', () => {
  const state = randomBase64Url();
  const nonce = randomBase64Url();
  const { verifier, challenge } = createPkcePair();

  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  assert.match(nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.match(verifier, /^[A-Za-z0-9_-]{64}$/);
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(safeHashEquals(nonce, sha256Hex(nonce)), true);
  assert.equal(safeHashEquals(`${nonce}x`, sha256Hex(nonce)), false);

  const secret = 'unit-test-client-secret-at-least-32-characters';
  const encrypted = encryptStateSecret(verifier, secret);
  assert.notEqual(encrypted, verifier);
  assert.equal(decryptStateSecret(encrypted, secret), verifier);
  assert.throws(() => decryptStateSecret(encrypted, `${secret}x`));
});
