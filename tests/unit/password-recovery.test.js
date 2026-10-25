import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createOpaqueToken, createVerificationCode, hashOpaqueToken,
  hashVerificationCode, secureHashEqual,
} from '../../src/utils/recovery-token.js'

test('creates opaque recovery identifiers and keyed verification-code hashes', () => {
  const identifier = createOpaqueToken()
  const code = createVerificationCode()
  const secret = 'unit-test-recovery-secret-longer-than-32-characters'
  const hash = hashVerificationCode(identifier, code, secret)

  assert.match(identifier, /^[A-Za-z0-9_-]{43}$/)
  assert.match(code, /^\d{6}$/)
  assert.match(hashOpaqueToken(identifier), /^[a-f0-9]{64}$/)
  assert.match(hash, /^[a-f0-9]{64}$/)
  assert.equal(hash.includes(code), false)
  assert.equal(secureHashEqual(hash, hashVerificationCode(identifier, code, secret)), true)
  assert.equal(secureHashEqual(hash, hashVerificationCode(identifier, '000000', secret)), false)
})

test('rejects malformed recovery identifiers, codes, secrets, and hashes', () => {
  assert.equal(hashOpaqueToken('bad'), null)
  assert.equal(hashVerificationCode(createOpaqueToken(), '12345', 'short'), null)
  assert.equal(secureHashEqual('not-hex', 'also-not-hex'), false)
})
