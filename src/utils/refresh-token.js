import { createHash, randomBytes } from 'node:crypto';

function createRefreshToken() {
  return randomBytes(32).toString('base64url');
}

function hashRefreshToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return createHash('sha256').update(token).digest('hex');
}

export { createRefreshToken, hashRefreshToken };
