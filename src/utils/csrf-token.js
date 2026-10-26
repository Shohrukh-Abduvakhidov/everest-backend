import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

function createCsrfToken() {
   return randomBytes(32).toString('base64url')
}

function hashCsrfToken(token) {
   if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null
   return createHash('sha256').update(token).digest('hex')
}

function csrfTokenMatches(token, expectedHash) {
   const actualHash = hashCsrfToken(token)
   if (!actualHash || typeof expectedHash !== 'string' || expectedHash.length !== 64) return false
   return timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(expectedHash, 'hex'))
}

export { createCsrfToken, csrfTokenMatches, hashCsrfToken }
