import env from '../configs/env.js';
import * as authRepository from '../repositories/auth-repository.js';
import { withTransaction } from '../repositories/transaction-repository.js';
import * as userRepository from '../repositories/user-repository.js';
import AppError from '../utils/app-error.js';
import { normalizePhone, validateBody, validateName, validatePassword } from '../utils/auth-input.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { createSessionService } from './auth/session-service.js';

const dummyPasswordHash = 'scrypt$16384$8$1$YPIwZaby56dLwoJeEAVCKQ$WmyiT5x22N7vIWUPlYs8wJTOB3XsvKr3RBultfXmx-FwcIYNQJkBaoVibAGfr3D86KtJWqKzbG91FNdWa4D0Jw';

function createPasswordAuthService({
  config = env,
  users = userRepository,
  auth = authRepository,
  transaction = withTransaction,
  passwordHasher = { hash: hashPassword, verify: verifyPassword },
  now = () => new Date(),
  sessions = createSessionService({ config, repository: auth, now }),
} = {}) {
  async function register(body) {
    validateBody(body, ['phone', 'password', 'firstName', 'lastName']);
    const phoneE164 = normalizePhone(body.phone);
    const password = validatePassword(body.password);
    const firstName = validateName(body.firstName, 'firstName');
    const lastName = validateName(body.lastName, 'lastName');
    const passwordHash = await passwordHasher.hash(password);
    try {
      return await transaction(async (client) => {
        const user = await users.createPendingUser(client);
        const userId = user.id;
        await users.createProfile({ userId, firstName, lastName }, client);
        await users.createPhone({ userId, phoneE164 }, client);
        await users.createPassword(userId, passwordHash, client);
        await users.assignRole(userId, 'student', client);
        await auth.appendAuditEvent({
          actorUserId: null,
          subjectUserId: userId,
          code: 'auth.password.registered',
          entityType: 'user',
          entityId: userId,
          metadata: {},
        }, client);
        return {
          status: 'pending',
          user: { id: user.id, status: user.status, firstName, lastName, phone: phoneE164 },
        };
      });
    } catch (error) {
      if (error.code === '23505' && error.constraint === 'user_phones_phone_e164_key') {
        throw new AppError(409, 'PHONE_ALREADY_REGISTERED', 'Phone is already registered');
      }
      throw error;
    }
  }

  async function login(body, requestContext) {
    validateBody(body, ['phone', 'password']);
    const phoneE164 = normalizePhone(body.phone);
    const password = body.password;
    if (typeof password !== 'string' || password.length === 0 || [...password].length > 128) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Phone or password is invalid');
    }
    const account = await users.findPasswordAccountByPhone(phoneE164);
    const passwordMatches = await passwordHasher.verify(
      password,
      account?.password_hash || dummyPasswordHash
    );
    if (!account || !passwordMatches) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Phone or password is invalid');
    }

    return transaction(async (client) => {
      const locked = await users.findPasswordAccountForUpdate(phoneE164, client);
      if (!locked || locked.user_id !== account.user_id
          || locked.password_hash !== account.password_hash) {
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Phone or password is invalid');
      }
      if (locked.status !== 'active') {
        throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'Account is not active');
      }

      const session = await sessions.issueSession({
        userId: locked.user_id,
        requestContext,
        client,
      });
      await users.touchLastLogin(locked.user_id, client);
      await auth.appendAuditEvent({
        actorUserId: locked.user_id,
        subjectUserId: locked.user_id,
        code: 'auth.password.login_succeeded',
        entityType: 'auth_session',
        entityId: session.sessionId,
        metadata: {},
      }, client);
      return {
        status: 'authenticated',
        accessToken: session.accessToken,
        expiresAt: session.expiresAt,
        user: { id: locked.user_id },
      };
    });
  }

  return { login, register };
}

const passwordAuthService = createPasswordAuthService();

export { createPasswordAuthService, passwordAuthService };
