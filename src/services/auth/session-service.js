import env from '../../configs/env.js';
import * as authRepository from '../../repositories/auth-repository.js';
import { createAccessToken } from './session-token-service.js';

function createSessionService({
  config = env,
  repository = authRepository,
  now = () => new Date(),
} = {}) {
  async function issueSession({ userId, requestContext, client }) {
    const expiresAt = new Date(now().getTime() + config.authSessionTtlSeconds * 1000);
    const session = await repository.createSession({
      userId,
      expiresAt,
      userAgent: requestContext.userAgent?.slice(0, 1000) || null,
      ipAddress: requestContext.ipAddress || null,
    }, client);
    const sessionId = session.id;
    const accessToken = await createAccessToken({ userId, sessionId, expiresAt }, config.jwtAccessSecret);
    return { accessToken, expiresAt, sessionId };
  }

  return { issueSession };
}

const sessionService = createSessionService();

export { createSessionService, sessionService };
