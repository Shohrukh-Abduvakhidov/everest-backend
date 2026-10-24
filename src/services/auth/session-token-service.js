import { SignJWT, jwtVerify } from 'jose';

import AppError from '../../utils/app-error.js';

function getKey(secret) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new AppError(503, 'AUTH_NOT_CONFIGURED', 'Authentication is not configured');
  }
  return new TextEncoder().encode(secret);
}

async function createAccessToken({ userId, sessionId, expiresAt }, secret) {
  return new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(getKey(secret));
}

async function verifyAccessToken(token, secret) {
  try {
    const { payload } = await jwtVerify(token, getKey(secret), { algorithms: ['HS256'] });
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') throw new Error('Missing claims');
    return { userId: payload.sub, sessionId: payload.sid };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required');
  }
}

export { createAccessToken, verifyAccessToken };
