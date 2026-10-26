import env from '../configs/env.js'
import * as authRepository from '../repositories/auth-repository.js'
import * as sessionRepository from '../repositories/session-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import AppError from '../utils/app-error.js'
import { normalizeInternalId } from '../utils/internal-id.js'
import { createRefreshToken, hashRefreshToken } from '../utils/refresh-token.js'
import { createAccessToken, verifyAccessToken } from './auth/session-token-service.js'

function invalidRefreshToken(code = 'INVALID_REFRESH_TOKEN') {
   return new AppError(401, code, 'Refresh token is invalid or expired')
}

function parseSessionId(value) {
   try {
      return normalizeInternalId(value)
   } catch {
      throw new AppError(400, 'INVALID_SESSION_ID', 'Session identifier is invalid')
   }
}

function deviceSummary(userAgent) {
   const value = typeof userAgent === 'string' ? userAgent.slice(0, 1000) : ''
   const browser = /Edg\//.test(value)
      ? 'Edge'
      : /Firefox\//.test(value)
        ? 'Firefox'
        : /Chrome\//.test(value)
          ? 'Chrome'
          : /Safari\//.test(value)
            ? 'Safari'
            : 'Other'
   const operatingSystem = /Windows/.test(value)
      ? 'Windows'
      : /Android/.test(value)
        ? 'Android'
        : /iPhone|iPad/.test(value)
          ? 'iOS'
          : /Mac OS/.test(value)
            ? 'macOS'
            : /Linux/.test(value)
              ? 'Linux'
              : 'Other'
   const deviceType = /Mobile|Android|iPhone|iPad/.test(value) ? 'mobile' : 'desktop'
   return { browser, operatingSystem, deviceType }
}

function dependencies(overrides = {}) {
   return {
      config: overrides.config || env,
      repository: overrides.repository || sessionRepository,
      auth: overrides.auth || authRepository,
      transaction: overrides.transaction || withTransaction,
      now: overrides.now || (() => new Date()),
   }
}

async function refreshSessionService(rawToken, overrides) {
   const { config, repository, auth, transaction, now } = dependencies(overrides)
   const tokenHash = hashRefreshToken(rawToken)
   if (!tokenHash)
      throw invalidRefreshToken(rawToken ? 'INVALID_REFRESH_TOKEN' : 'REFRESH_TOKEN_REQUIRED')
   const replacementToken = createRefreshToken()
   const outcome = await transaction(async (client) => {
      const token = await repository.findRefreshTokenForUpdate(tokenHash, client)
      if (!token) return { invalid: true }
      if (token.used_at || token.token_revoked_at) {
         await repository.revokeSession(token.session_id, 'refresh_token_reuse', client)
         await repository.revokeSessionRefreshTokens(token.session_id, client)
         await auth.appendAuditEvent(
            {
               actorUserId: token.user_id,
               subjectUserId: token.user_id,
               code: 'auth.refresh.reuse_detected',
               entityType: 'auth_session',
               entityId: token.session_id,
               metadata: {},
            },
            client,
         )
         return { reuse: true }
      }
      const currentTime = now()
      if (
         token.token_expires_at <= currentTime ||
         token.session_expires_at <= currentTime ||
         token.session_revoked_at ||
         token.status !== 'active'
      )
         return { invalid: true }
      await repository.markRefreshTokenUsed(token.token_id, client)
      await repository.createRefreshToken(
         {
            sessionId: token.session_id,
            tokenHash: hashRefreshToken(replacementToken),
            expiresAt: token.token_expires_at,
         },
         client,
      )
      await repository.touchSessionLastUsedNow(token.session_id, client)
      const expiresAt = new Date(currentTime.getTime() + config.authSessionTtlSeconds * 1000)
      return {
         status: 'refreshed',
         accessToken: await createAccessToken(
            {
               userId: token.user_id,
               sessionId: token.session_id,
               expiresAt,
            },
            config.jwtAccessSecret,
         ),
         expiresAt,
         refreshToken: replacementToken,
         refreshExpiresAt: token.token_expires_at,
         user: { id: token.user_id },
      }
   })
   if (outcome.reuse) throw invalidRefreshToken('REFRESH_TOKEN_REUSE_DETECTED')
   if (outcome.invalid) throw invalidRefreshToken()
   return outcome
}

async function logoutService({ accessToken, refreshToken }, overrides) {
   const { config, repository, auth, transaction } = dependencies(overrides)
   let claims = null
   try {
      if (accessToken) claims = await verifyAccessToken(accessToken, config.jwtAccessSecret)
   } catch {}
   const tokenHash = hashRefreshToken(refreshToken)
   await transaction(async (client) => {
      let userId = claims?.userId
      let sessionId = claims?.sessionId
      if (!sessionId && tokenHash) {
         const token = await repository.findRefreshTokenForUpdate(tokenHash, client)
         userId = token?.user_id
         sessionId = token?.session_id
      }
      if (!sessionId || !userId) return
      const session = await repository.lockOwnedSession(userId, sessionId, client)
      if (!session || session.revoked_at) return
      await repository.revokeSession(sessionId, 'user_logout', client)
      await repository.revokeSessionRefreshTokens(sessionId, client)
      await auth.appendAuditEvent(
         {
            actorUserId: userId,
            subjectUserId: userId,
            code: 'auth.session.logged_out',
            entityType: 'auth_session',
            entityId: sessionId,
            metadata: {},
         },
         client,
      )
   })
   return { status: 'logged_out' }
}

async function logoutAllService(userId, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const normalizedUserId = normalizeInternalId(userId)
   return transaction(async (client) => {
      const revoked = await repository.revokeAllUserSessions(
         normalizedUserId,
         'user_logout_all',
         client,
      )
      await auth.appendAuditEvent(
         {
            actorUserId: normalizedUserId,
            subjectUserId: normalizedUserId,
            code: 'auth.session.logged_out_all',
            entityType: 'user',
            entityId: normalizedUserId,
            metadata: { revokedSessions: revoked.sessions },
         },
         client,
      )
      return { status: 'logged_out_all', revokedSessions: revoked.sessions }
   })
}

async function listSessionsService(userId, currentSessionId, overrides) {
   const { repository } = dependencies(overrides)
   const sessions = await repository.listUserSessions(normalizeInternalId(userId))
   return {
      sessions: sessions.map((session) => ({
         id: session.id,
         createdAt: session.created_at,
         lastUsedAt: session.last_used_at,
         expiresAt: session.expires_at,
         revokedAt: session.revoked_at,
         current: session.id === currentSessionId,
         device: deviceSummary(session.user_agent),
      })),
   }
}

async function revokeOwnedSessionService(userId, currentSessionId, sessionIdValue, overrides) {
   const { repository, auth, transaction } = dependencies(overrides)
   const normalizedUserId = normalizeInternalId(userId)
   const sessionId = parseSessionId(sessionIdValue)
   return transaction(async (client) => {
      const session = await repository.lockOwnedSession(normalizedUserId, sessionId, client)
      if (!session) throw new AppError(404, 'SESSION_NOT_FOUND', 'Session was not found')
      if (!session.revoked_at) {
         await repository.revokeSession(sessionId, 'user_session_revoked', client)
         await repository.revokeSessionRefreshTokens(sessionId, client)
         await auth.appendAuditEvent(
            {
               actorUserId: normalizedUserId,
               subjectUserId: normalizedUserId,
               code: 'auth.session.revoked',
               entityType: 'auth_session',
               entityId: sessionId,
               metadata: { currentSession: sessionId === currentSessionId },
            },
            client,
         )
      }
      return { status: 'revoked', sessionId, currentSession: sessionId === currentSessionId }
   })
}

export {
   deviceSummary,
   listSessionsService,
   logoutAllService,
   logoutService,
   parseSessionId,
   refreshSessionService,
   revokeOwnedSessionService,
}
