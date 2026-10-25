import env from '../configs/env.js';
import * as authRepository from '../repositories/auth-repository.js';
import { withTransaction } from '../repositories/transaction-repository.js';
import * as sessionRepository from '../repositories/session-repository.js';
import AppError from '../utils/app-error.js';
import {
  createPkcePair,
  decryptStateSecret,
  encryptStateSecret,
  randomBase64Url,
  sha256Hex,
} from '../utils/telegram-crypto.js';
import { TelegramBotProvider } from './auth/telegram-bot-provider.js';
import { expectedIssuer, TelegramOidcProvider } from './auth/telegram-oidc-provider.js';
import { createSessionService } from './auth/session-service.js';
import { verifyAccessToken } from './auth/session-token-service.js';

function requireConfiguration(config) {
  const values = [config.telegram.clientId, config.telegram.clientSecret,
    config.telegram.redirectUri, config.telegram.botUsername,
    config.telegram.botToken, config.telegram.webhookSecret, config.jwtAccessSecret];
  if (values.some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new AppError(503, 'TELEGRAM_AUTH_NOT_CONFIGURED', 'Telegram authentication is not configured');
  }
}

function safeProfile(claims) {
  return Object.fromEntries(
    ['name', 'given_name', 'family_name', 'preferred_username', 'picture']
      .filter((key) => typeof claims[key] === 'string')
      .map((key) => [key, claims[key]])
  );
}

function verifiedChatId(claims) {
  if (typeof claims.id === 'string' && /^-?[1-9][0-9]*$/.test(claims.id)) return claims.id;
  if (Number.isSafeInteger(claims.id)) return String(claims.id);
  return null;
}

function botAccessGranted(tokenSet) {
  return typeof tokenSet.scope === 'string'
    && tokenSet.scope.split(/\s+/).includes('telegram:bot_access');
}

function createTelegramAuthService({
  config = env,
  repository = authRepository,
  transaction = withTransaction,
  oidcProvider = new TelegramOidcProvider(config.telegram),
  botProvider = new TelegramBotProvider(config.telegram),
  now = () => new Date(),
  sessions = createSessionService({ config, repository, now }),
} = {}) {
  async function beginTelegramAuthorization({ intent, userId = null }) {
    requireConfiguration(config);
    if (intent !== 'login' && intent !== 'link') throw new AppError(400, 'INVALID_AUTH_INTENT', 'Invalid authentication intent');
    if (intent === 'link' && !userId) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required');

    const state = randomBase64Url();
    const nonce = randomBase64Url();
    const { verifier, challenge } = createPkcePair();
    const expiresAt = new Date(now().getTime() + config.telegramOidcStateTtlSeconds * 1000);
    await repository.createTelegramOidcState({
      stateHash: sha256Hex(state),
      nonceHash: sha256Hex(nonce),
      codeVerifierCiphertext: encryptStateSecret(verifier, config.telegram.clientSecret),
      intent,
      initiatingUserId: userId,
      expiresAt,
    });
    const authorizationUrl = await oidcProvider.buildAuthorizationUrl({ state, nonce, codeChallenge: challenge });
    return { authorizationUrl, expiresAt };
  }

  async function saveConnectionIfGranted({ userId, claims, tokenSet, client }) {
    const chatId = verifiedChatId(claims);
    if (!botAccessGranted(tokenSet) || !chatId) return false;
    await repository.upsertTelegramConnection({
      userId, botId: config.telegram.clientId, chatId,
    }, client);
    return true;
  }

  async function completeLink(stateRow, claims, tokenSet) {
    try {
      return await transaction(async (client) => {
        const linkedIdentity = await repository.findTelegramIdentityForUpdate(
          expectedIssuer, claims.sub, client
        );
        if (linkedIdentity && linkedIdentity.user_id !== stateRow.initiating_user_id) {
          throw new AppError(409, 'TELEGRAM_IDENTITY_ALREADY_LINKED', 'Telegram identity is already linked');
        }
        const currentIdentity = await repository.findUserTelegramIdentityForUpdate(
          stateRow.initiating_user_id, expectedIssuer, client
        );
        if (currentIdentity && currentIdentity.provider_subject !== claims.sub) {
          throw new AppError(409, 'TELEGRAM_IDENTITY_CONFLICT', 'A different Telegram identity is already linked');
        }

        const identity = linkedIdentity || currentIdentity || await repository.createTelegramIdentity({
          userId: stateRow.initiating_user_id,
          issuer: expectedIssuer,
          subject: claims.sub,
          profile: safeProfile(claims),
        }, client);
        await repository.touchTelegramIdentity(identity.id, safeProfile(claims), client);
        const messagingConnected = await saveConnectionIfGranted({
          userId: stateRow.initiating_user_id, claims, tokenSet, client,
        });
        await repository.appendAuditEvent({
          actorUserId: stateRow.initiating_user_id,
          subjectUserId: stateRow.initiating_user_id,
          code: 'auth.telegram.linked',
          entityType: 'auth_identity',
          entityId: identity.id,
          metadata: { messagingConnected },
        }, client);
        return { status: 'linked', messagingConnected };
      });
    } catch (error) {
      if (error.code === '23505') {
        const subjectConflict = error.constraint === 'identities_subject_unique'
          || error.constraint === 'telegram_connections_bot_id_chat_id_key';
        throw new AppError(
          409,
          subjectConflict ? 'TELEGRAM_IDENTITY_ALREADY_LINKED' : 'TELEGRAM_IDENTITY_CONFLICT',
          subjectConflict ? 'Telegram identity is already linked' : 'A different Telegram identity is already linked'
        );
      }
      throw error;
    }
  }

  async function completeLogin(claims, tokenSet, requestContext) {
    return transaction(async (client) => {
      const identity = await repository.findTelegramIdentityForUpdate(expectedIssuer, claims.sub, client);
      if (!identity) return { status: 'linking_required' };
      if (identity.status !== 'active') {
        throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'Account is not active');
      }
      await repository.touchTelegramIdentity(identity.id, safeProfile(claims), client);
      const messagingConnected = await saveConnectionIfGranted({
        userId: identity.user_id, claims, tokenSet, client,
      });
      const session = await sessions.issueSession({
        userId: identity.user_id, requestContext, client,
      });
      return {
        status: 'authenticated', accessToken: session.accessToken, expiresAt: session.expiresAt,
        refreshToken: session.refreshToken, refreshExpiresAt: session.refreshExpiresAt,
        user: { id: identity.user_id }, messagingConnected,
      };
    });
  }

  async function handleTelegramCallback({ code, state, error, requestContext }) {
    requireConfiguration(config);
    if (typeof state !== 'string' || !state) {
      throw new AppError(400, 'TELEGRAM_CALLBACK_INVALID', 'Telegram callback is invalid');
    }
    const stateRow = await repository.consumeTelegramOidcState(sha256Hex(state));
    if (!stateRow) throw new AppError(401, 'TELEGRAM_STATE_INVALID', 'Telegram authorization state is invalid or expired');
    if (error) throw new AppError(401, 'TELEGRAM_AUTHORIZATION_DENIED', 'Telegram authorization was not completed');
    if (typeof code !== 'string' || !code) {
      throw new AppError(400, 'TELEGRAM_CALLBACK_INVALID', 'Telegram callback is invalid');
    }

    let verifier;
    try {
      verifier = decryptStateSecret(stateRow.code_verifier_ciphertext, config.telegram.clientSecret);
    } catch {
      throw new AppError(401, 'TELEGRAM_STATE_INVALID', 'Telegram authorization state is invalid or expired');
    }
    const tokenSet = await oidcProvider.exchangeCode({ code, codeVerifier: verifier });
    const claims = await oidcProvider.validateIdToken(tokenSet.id_token, stateRow.nonce_hash);
    if (stateRow.intent === 'link') return completeLink(stateRow, claims, tokenSet);
    return completeLogin(claims, tokenSet, requestContext);
  }

  async function authenticate(token) {
    requireConfiguration(config);
    if (!token) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required');
    const claims = await verifyAccessToken(token, config.jwtAccessSecret);
    const session = await repository.findLiveSession(claims.userId, claims.sessionId);
    if (!session || session.status !== 'active') {
      throw new AppError(401, 'SESSION_INVALID', 'Session is invalid or expired');
    }
    await sessionRepository.touchSessionLastUsed(session.id);
    return { userId: session.user_id, sessionId: session.id };
  }

  async function unlinkTelegram(userId) {
    requireConfiguration(config);
    return transaction(async (client) => {
      const identity = await repository.findUserTelegramIdentityForUpdate(userId, expectedIssuer, client);
      if (!identity) throw new AppError(404, 'TELEGRAM_IDENTITY_NOT_LINKED', 'Telegram identity is not linked');
      if (!await repository.hasAlternativeLogin(userId, identity.id, client)) {
        throw new AppError(409, 'LAST_LOGIN_METHOD', 'Cannot remove the last login method');
      }
      await repository.disconnectTelegramConnection(userId, config.telegram.clientId, client);
      await repository.deleteTelegramIdentity(identity.id, client);
      await repository.appendAuditEvent({
        actorUserId: userId, subjectUserId: userId,
        code: 'auth.telegram.unlinked', entityType: 'auth_identity',
        entityId: identity.id, metadata: {},
      }, client);
      return { status: 'unlinked' };
    });
  }

  async function sendTelegramTestMessage(userId) {
    requireConfiguration(config);
    const connection = await repository.findActiveTelegramConnection(userId, config.telegram.clientId);
    if (!connection) throw new AppError(409, 'TELEGRAM_CONNECTION_UNAVAILABLE', 'Telegram messaging is not connected');
    try {
      await botProvider.sendTestMessage(connection.chat_id);
      return { status: 'sent' };
    } catch (error) {
      if (error.telegramAccessUnavailable) {
        await repository.markTelegramConnectionBlocked(connection.id);
      }
      throw error;
    }
  }

  return {
    authenticate,
    beginTelegramAuthorization,
    handleTelegramCallback,
    sendTelegramTestMessage,
    unlinkTelegram,
  };
}

const telegramAuthService = createTelegramAuthService();

export { createTelegramAuthService, telegramAuthService };
