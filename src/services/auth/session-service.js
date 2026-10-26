import env from '../../configs/env.js'
import * as authRepository from '../../repositories/auth-repository.js'
import * as sessionRepository from '../../repositories/session-repository.js'
import { createRefreshToken, hashRefreshToken } from '../../utils/refresh-token.js'
import { createCsrfToken, hashCsrfToken } from '../../utils/csrf-token.js'
import { createAccessToken } from './session-token-service.js'

async function issueSessionService(
   { userId, requestContext, client },
   {
      config = env,
      repository = authRepository,
      refreshRepository = sessionRepository,
      now = () => new Date(),
   } = {},
) {
   const expiresAt = new Date(now().getTime() + config.authSessionTtlSeconds * 1000)
   const refreshExpiresAt = new Date(now().getTime() + config.authRefreshTtlSeconds * 1000)
   const csrfToken = createCsrfToken()
   const session = await repository.createSession(
      {
         userId,
         expiresAt: refreshExpiresAt,
         userAgent: requestContext.userAgent?.slice(0, 1000) || null,
         ipAddress: requestContext.ipAddress || null,
         csrfTokenHash: hashCsrfToken(csrfToken),
      },
      client,
   )
   const sessionId = session.id
   const refreshToken = createRefreshToken()

   await refreshRepository.createRefreshToken(
      {
         sessionId,
         tokenHash: hashRefreshToken(refreshToken),
         expiresAt: refreshExpiresAt,
      },
      client,
   )

   const accessToken = await createAccessToken(
      { userId, sessionId, expiresAt },
      config.jwtAccessSecret,
   )

   return { accessToken, csrfToken, expiresAt, refreshExpiresAt, refreshToken, sessionId }
}

export { issueSessionService }
