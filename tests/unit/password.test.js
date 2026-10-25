import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizePhone, validatePassword } from '../../src/utils/auth-input.js';
import { hashPassword, verifyPassword } from '../../src/utils/password.js';

test('normalizes E.164 input and rejects invalid phone numbers', () => {
  assert.equal(normalizePhone('+992 (900) 00-00-00'), '+992900000000');
  assert.throws(() => normalizePhone('992900000000'), { code: 'VALIDATION_ERROR' });
  assert.throws(() => normalizePhone('+01234567890'), { code: 'VALIDATION_ERROR' });
  assert.throws(() => normalizePhone('+992abc123456'), { code: 'VALIDATION_ERROR' });
});

test('validates registration passwords', () => {
  assert.equal(validatePassword('correct horse 9'), 'correct horse 9');
  assert.throws(() => validatePassword('short9'), { code: 'VALIDATION_ERROR' });
  assert.throws(() => validatePassword('letters without digits'), { code: 'VALIDATION_ERROR' });
});

test('hashes passwords with random salts and verifies them safely', async () => {
  const password = 'a secure password 9';
  const first = await hashPassword(password);
  const second = await hashPassword(password);

  assert.notEqual(first, second);
  assert.ok(first.startsWith('scrypt$'));
  assert.equal(first.includes(password), false);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword('a different password 9', first), false);
  assert.equal(await verifyPassword(password, 'not-a-valid-hash'), false);
});
