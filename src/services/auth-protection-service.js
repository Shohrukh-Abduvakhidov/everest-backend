import { createHmac } from 'node:crypto'

import env from '../configs/env.js'
import * as authProtectionRepository from '../repositories/auth-protection-repository.js'
import AppError from '../utils/app-error.js'
import { csrfTokenMatches } from '../utils/csrf-token.js'
import { hashRefreshToken } from '../utils/refresh-token.js'

function dependencies(overrides = {}) {
   return {
      config: overrides.config || env,
      repository: overrides.repository || authProtectionRepository,
   }
}

function securityKey(value, config = env) {
   const secret = config.otpHmacSecret || config.jwtAccessSecret
   if (typeof secret !== 'string' || secret.length < 32) {
      throw new AppError(503, 'AUTH_PROTECTION_UNAVAILABLE', 'Authentication protection is unavailable')
   }
   return createHmac('sha256', secret).update(String(value || 'unknown')).digest('hex')
}

async function consumeRateLimitService(input, overrides) {
   const { config, repository } = dependencies(overrides)
   const keyHash = securityKey(input.key, config)
   const state = await repository.consumeCounter({ ...input, keyHash })
   if (state.blocked_until) {
      const error = new AppError(429, 'AUTH_RATE_LIMITED', 'Too many requests')
      error.retryAfter = state.retry_after_seconds
      throw error
   }
}

async function clearRateLimitService(scope, key, overrides) {
   const { config, repository } = dependencies(overrides)
   await repository.clearCounter(scope, securityKey(key, config))
}

function validateOrigin(origin, config) {
   if (!origin || !config.corsOrigins.includes(origin)) {
      throw new AppError(403, 'CSRF_ORIGIN_REJECTED', 'Request origin is not allowed')
   }
}

async function validateSessionCsrfService({ sessionId, token, origin }, overrides) {
   const { config, repository } = dependencies(overrides)
   validateOrigin(origin, config)
   const expectedHash = await repository.findSessionCsrfHash(sessionId)
   if (!csrfTokenMatches(token, expectedHash)) {
      throw new AppError(403, 'CSRF_TOKEN_INVALID', 'CSRF token is missing or invalid')
   }
}

async function validateRefreshCsrfService({ refreshToken, token, origin }, overrides) {
   const { config, repository } = dependencies(overrides)
   const tokenHash = hashRefreshToken(refreshToken)
   const expectedHash = tokenHash
      ? await repository.findRefreshSessionCsrfHash(tokenHash)
      : null
   if (!expectedHash) return
   validateOrigin(origin, config)
   if (!csrfTokenMatches(token, expectedHash)) {
      throw new AppError(403, 'CSRF_TOKEN_INVALID', 'CSRF token is missing or invalid')
   }
}

export {
   clearRateLimitService,
   consumeRateLimitService,
   securityKey,
   validateRefreshCsrfService,
   validateSessionCsrfService,
}
