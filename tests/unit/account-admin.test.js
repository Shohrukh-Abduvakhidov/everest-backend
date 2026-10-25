import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePagination, parseUserId } from '../../src/services/account-admin-service.js';

test('validates canonical BIGINT route identifiers', () => {
  assert.equal(parseUserId('9223372036854775807'), '9223372036854775807');
  for (const value of ['0', '-1', '1.5', '01', ' 1', '1e2', '9223372036854775808', 1]) {
    assert.throws(() => parseUserId(value), (error) => error.code === 'INVALID_USER_ID');
  }
});

test('validates pending-user pagination', () => {
  assert.deepEqual(parsePagination({}), { limit: 20, offset: 0 });
  assert.deepEqual(parsePagination({ limit: '100', offset: '2' }), { limit: 100, offset: 2 });
  for (const query of [{ limit: '0' }, { limit: '101' }, { limit: '01' }, { offset: '-1' }]) {
    assert.throws(() => parsePagination(query), (error) => error.code === 'VALIDATION_ERROR');
  }
});
