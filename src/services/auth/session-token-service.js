import { SignJWT, jwtVerify } from 'jose'

import AppError from '../../utils/app-error.js'
import { normalizeInternalId } from '../../utils/internal-id.js'

function getKey(secret) {
   if (typeof secret !== 'string' || secret.length < 32) {
      throw new AppError(503, 'AUTH_NOT_CONFIGURED', 'Authentication is not configured')
   }
   return new TextEncoder().encode(secret)
}

async function createAccessToken({ userId, sessionId, expiresAt }, secret) {
   const normalizedUserId = normalizeInternalId(userId)
   const normalizedSessionId = normalizeInternalId(sessionId)
   return new SignJWT({ sid: normalizedSessionId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(normalizedUserId)
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(getKey(secret))
}

async function verifyAccessToken(token, secret) {
   try {
      const { payload } = await jwtVerify(token, getKey(secret), { algorithms: ['HS256'] })
      return {
         userId: normalizeInternalId(payload.sub),
         sessionId: normalizeInternalId(payload.sid),
      }
   } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required')
   }
}

export { createAccessToken, verifyAccessToken }
