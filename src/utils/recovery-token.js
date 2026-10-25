import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

const opaquePattern = /^[A-Za-z0-9_-]{43}$/

function createOpaqueToken() {
  return randomBytes(32).toString('base64url')
}

function createVerificationCode() {
  return String(randomInt(0, 1000000)).padStart(6, '0')
}

function hashOpaqueToken(value) {
  if (typeof value !== 'string' || !opaquePattern.test(value)) return null
  return createHash('sha256').update(value).digest('hex')
}

function hashVerificationCode(challengeIdentifier, code, secret) {
  if (!hashOpaqueToken(challengeIdentifier) || !/^\d{6}$/.test(String(code))
      || typeof secret !== 'string' || secret.length < 32) return null
  return createHmac('sha256', secret).update(`${challengeIdentifier}:${code}`).digest('hex')
}

function secureHashEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const leftBuffer = Buffer.from(left, 'hex')
  const rightBuffer = Buffer.from(right, 'hex')
  return leftBuffer.length > 0 && leftBuffer.length === rightBuffer.length
    && timingSafeEqual(leftBuffer, rightBuffer)
}

export {
  createOpaqueToken, createVerificationCode, hashOpaqueToken,
  hashVerificationCode, secureHashEqual,
}
