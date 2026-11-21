import env from '../configs/env.js'
import * as authRepository from '../repositories/auth-repository.js'
import * as telegramDeliveryRepository from '../repositories/telegram-delivery-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import * as sessionRepository from '../repositories/session-repository.js'
import AppError from '../utils/app-error.js'
import {
   createPkcePair,
   decryptStateSecret,
   encryptStateSecret,
   randomBase64Url,
   sha256Hex,
} from '../utils/telegram-crypto.js'
import { TelegramBotProvider } from './auth/telegram-bot-provider.js'
import { expectedIssuer, TelegramOidcProvider } from './auth/telegram-oidc-provider.js'
import { issueSessionService } from './auth/session-service.js'
import { blockTelegramConnectionService } from './telegram-delivery-service.js'
import { verifyAccessToken } from './auth/session-token-service.js'

function requireConfiguration(config) {
   const values = [
      config.telegram.clientId,
      config.telegram.clientSecret,
      config.telegram.redirectUri,
      config.telegram.botUsername,
      config.telegram.botToken,
      config.telegram.webhookSecret,
      config.jwtAccessSecret,
   ]
   if (values.some((value) => typeof value !== 'string' || value.length === 0)) {
      throw new AppError(
         503,
         'TELEGRAM_AUTH_NOT_CONFIGURED',
         'Telegram authentication is not configured',
      )
   }
}

function safeProfile(claims) {
   return Object.fromEntries(
      ['name', 'given_name', 'family_name', 'preferred_username', 'picture']
         .filter((key) => typeof claims[key] === 'string')
         .map((key) => [key, claims[key]]),
   )
}

const botAccessScope = 'telegram:bot_access'
const safeScopePattern = /^[A-Za-z0-9_.:-]{1,64}$/
const safeClaimNamePattern = /^[A-Za-z0-9_.:-]{1,64}$/

function numericTelegramId(value) {
   if (typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value)) return value
   if (Number.isSafeInteger(value) && value > 0) return String(value)
   return null
}

function claimType(value) {
   if (value === undefined) return 'absent'
   if (value === null) return 'null'
   if (Array.isArray(value)) return 'array'
   return typeof value
}

function grantedScopes(tokenSet) {
   if (typeof tokenSet.scope !== 'string') return null
   return tokenSet.scope.split(/\s+/).filter(Boolean)
}

// Describes the grant without values: no tokens, phones, names or identifiers.
function inspectTelegramGrant(claims, tokenSet) {
   const scopes = grantedScopes(tokenSet)
   const numericId = numericTelegramId(claims.id)
   const numericSub = numericTelegramId(claims.sub)
   const chatId = numericId || numericSub
   return {
      chatId,
      botAccessInScope: Boolean(scopes && scopes.includes(botAccessScope)),
      diagnostics: {
         scopePresent: scopes !== null,
         scopes: (scopes || []).filter((scope) => safeScopePattern.test(scope)).slice(0, 20),
         claimNames: Object.keys(claims)
            .filter((name) => safeClaimNamePattern.test(name))
            .sort()
            .slice(0, 50),
         idPresent: claims.id !== undefined && claims.id !== null,
         idType: claimType(claims.id),
         idNumeric: numericId !== null,
         subNumeric: numericSub !== null,
         subMatchesId: numericId !== null && numericSub !== null ? numericId === numericSub : null,
         chatIdSource: numericId ? 'id' : numericSub ? 'sub' : null,
      },
   }
}

function logTelegramGrant(context, fields) {
   try {
      context.logger.info(JSON.stringify({ event: 'auth.telegram.messaging_grant', ...fields }))
   } catch {
      // Logging must never break authentication.
   }
}

function dependencies(overrides = {}) {
   const config = overrides.config || env
   const repository = overrides.repository || authRepository
   const now = overrides.now || (() => new Date())
   return {
      config,
      repository,
      transaction: overrides.transaction || withTransaction,
      oidcProvider: overrides.oidcProvider || new TelegramOidcProvider(config.telegram),
      botProvider: overrides.botProvider || new TelegramBotProvider(config.telegram),
      deliveries: overrides.deliveries || telegramDeliveryRepository,
      blockConnection: overrides.blockConnection || blockTelegramConnectionService,
      logger: overrides.logger || console,
      now,
      sessions: overrides.sessions || {
         issueSession: (input) =>
            issueSessionService(input, {
               config,
               repository,
               now,
            }),
      },
   }
}

async function beginTelegramAuthorizationService({ intent, userId = null }, overrides) {
   const { config, repository, oidcProvider, now } = dependencies(overrides)
   requireConfiguration(config)
   if (intent !== 'login' && intent !== 'link')
      throw new AppError(400, 'INVALID_AUTH_INTENT', 'Invalid authentication intent')
   if (intent === 'link' && !userId)
      throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required')

   const state = randomBase64Url()
   const nonce = randomBase64Url()
   const { verifier, challenge } = createPkcePair()
   const expiresAt = new Date(now().getTime() + config.telegramOidcStateTtlSeconds * 1000)
   await repository.createTelegramOidcState({
      stateHash: sha256Hex(state),
      nonceHash: sha256Hex(nonce),
      codeVerifierCiphertext: encryptStateSecret(verifier, config.telegram.clientSecret),
      intent,
      initiatingUserId: userId,
      expiresAt,
   })
   const authorizationUrl = await oidcProvider.buildAuthorizationUrl({
      state,
      nonce,
      codeChallenge: challenge,
   })
   if (intent !== 'link') return { authorizationUrl, expiresAt }
   const connection = await repository.findActiveTelegramConnection(
      userId,
      config.telegram.clientId,
   )
   return { authorizationUrl, expiresAt, messagingConnected: Boolean(connection) }
}

// Bot access is confirmed by the token scope, or, when the scope does not list it,
// by a confirmation message: 2xx connects, 403 (or blocked/not found) leaves it disconnected.
async function connectMessagingService({ userId, grant, client }, context) {
   const { config, repository, botProvider } = context
   if (!grant.chatId) return { connected: false, method: 'no_chat_id' }
   const botId = config.telegram.clientId
   const save = () =>
      repository.upsertTelegramConnection({ userId, botId, chatId: grant.chatId }, client)
   if (grant.botAccessInScope) {
      await save()
      return { connected: true, method: 'scope' }
   }
   const existing = await repository.findActiveTelegramConnection(userId, botId, client)
   if (existing && String(existing.chat_id) === grant.chatId) {
      return { connected: true, method: 'existing' }
   }
   try {
      await botProvider.sendConnectionConfirmation(grant.chatId)
   } catch (error) {
      return {
         connected: false,
         method: error.telegramAccessUnavailable ? 'probe_forbidden' : 'probe_failed',
      }
   }
   await save()
   return { connected: true, method: 'probe' }
}

async function completeLinkService(stateRow, claims, tokenSet, context) {
   const { config, repository, transaction } = context
   try {
      return await transaction(async (client) => {
         const linkedIdentity = await repository.findTelegramIdentityForUpdate(
            expectedIssuer,
            claims.sub,
            client,
         )
         if (linkedIdentity && linkedIdentity.user_id !== stateRow.initiating_user_id) {
            throw new AppError(
               409,
               'TELEGRAM_IDENTITY_ALREADY_LINKED',
               'Telegram identity is already linked',
            )
         }
         const currentIdentity = await repository.findUserTelegramIdentityForUpdate(
            stateRow.initiating_user_id,
            expectedIssuer,
            client,
         )
         if (currentIdentity && currentIdentity.provider_subject !== claims.sub) {
            throw new AppError(
               409,
               'TELEGRAM_IDENTITY_CONFLICT',
               'A different Telegram identity is already linked',
            )
         }

         const identity =
            linkedIdentity ||
            currentIdentity ||
            (await repository.createTelegramIdentity(
               {
                  userId: stateRow.initiating_user_id,
                  issuer: expectedIssuer,
                  subject: claims.sub,
                  profile: safeProfile(claims),
               },
               client,
            ))
         await repository.touchTelegramIdentity(identity.id, safeProfile(claims), client)
         const grant = inspectTelegramGrant(claims, tokenSet)
         const messaging = await connectMessagingService(
            { userId: stateRow.initiating_user_id, grant, client },
            context,
         )
         const grantSummary = {
            messagingConnected: messaging.connected,
            messagingMethod: messaging.method,
            ...grant.diagnostics,
         }
         logTelegramGrant(context, {
            flow: 'link',
            userId: String(stateRow.initiating_user_id),
            ...grantSummary,
         })
         await repository.appendAuditEvent(
            {
               actorUserId: stateRow.initiating_user_id,
               subjectUserId: stateRow.initiating_user_id,
               code: 'auth.telegram.linked',
               entityType: 'auth_identity',
               entityId: identity.id,
               metadata: grantSummary,
            },
            client,
         )
         return { status: 'linked', messagingConnected: messaging.connected }
      })
   } catch (error) {
      if (error.code === '23505') {
         const subjectConflict =
            error.constraint === 'identities_subject_unique' ||
            error.constraint === 'telegram_connections_bot_id_chat_id_key'
         throw new AppError(
            409,
            subjectConflict ? 'TELEGRAM_IDENTITY_ALREADY_LINKED' : 'TELEGRAM_IDENTITY_CONFLICT',
            subjectConflict
               ? 'Telegram identity is already linked'
               : 'A different Telegram identity is already linked',
         )
      }
      throw error
   }
}

async function completeLoginService(claims, tokenSet, requestContext, context) {
   const { config, repository, transaction, sessions } = context
   return transaction(async (client) => {
      const identity = await repository.findTelegramIdentityForUpdate(
         expectedIssuer,
         claims.sub,
         client,
      )
      const grant = inspectTelegramGrant(claims, tokenSet)
      if (!identity) {
         logTelegramGrant(context, {
            flow: 'login',
            userId: null,
            messagingConnected: false,
            messagingMethod: 'linking_required',
            ...grant.diagnostics,
         })
         return { status: 'linking_required', messagingConnected: false }
      }
      if (identity.status !== 'active') {
         throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'Account is not active')
      }
      await repository.touchTelegramIdentity(identity.id, safeProfile(claims), client)
      const messaging = await connectMessagingService(
         { userId: identity.user_id, grant, client },
         context,
      )
      const messagingConnected = messaging.connected
      logTelegramGrant(context, {
         flow: 'login',
         userId: String(identity.user_id),
         messagingConnected,
         messagingMethod: messaging.method,
         ...grant.diagnostics,
      })
      const session = await sessions.issueSession({
         userId: identity.user_id,
         requestContext,
         client,
      })
      return {
         status: 'authenticated',
         accessToken: session.accessToken,
         expiresAt: session.expiresAt,
         refreshToken: session.refreshToken,
         csrfToken: session.csrfToken,
         refreshExpiresAt: session.refreshExpiresAt,
         user: { id: identity.user_id },
         messagingConnected,
      }
   })
}

async function handleTelegramCallbackService({ code, state, error, requestContext }, overrides) {
   const context = dependencies(overrides)
   const { config, repository, oidcProvider, now } = context
   requireConfiguration(config)
   if (typeof state !== 'string' || !state) {
      throw new AppError(400, 'TELEGRAM_CALLBACK_INVALID', 'Telegram callback is invalid')
   }
   const stateRow = await repository.consumeTelegramOidcState(sha256Hex(state))
   if (!stateRow)
      throw new AppError(
         401,
         'TELEGRAM_STATE_INVALID',
         'Telegram authorization state is invalid or expired',
      )
   if (error)
      throw new AppError(
         401,
         'TELEGRAM_AUTHORIZATION_DENIED',
         'Telegram authorization was not completed',
      )
   if (typeof code !== 'string' || !code) {
      throw new AppError(400, 'TELEGRAM_CALLBACK_INVALID', 'Telegram callback is invalid')
   }

   let verifier
   try {
      verifier = decryptStateSecret(stateRow.code_verifier_ciphertext, config.telegram.clientSecret)
   } catch {
      throw new AppError(
         401,
         'TELEGRAM_STATE_INVALID',
         'Telegram authorization state is invalid or expired',
      )
   }
   const tokenSet = await oidcProvider.exchangeCode({ code, codeVerifier: verifier })
   const claims = await oidcProvider.validateIdToken(tokenSet.id_token, stateRow.nonce_hash)
   if (stateRow.intent === 'link') {
      return completeLinkService(stateRow, claims, tokenSet, context)
   }
   return completeLoginService(claims, tokenSet, requestContext, context)
}

async function authenticateService(token, overrides) {
   const { config, repository } = dependencies(overrides)
   requireConfiguration(config)
   if (!token) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required')
   const claims = await verifyAccessToken(token, config.jwtAccessSecret)
   const session = await repository.findLiveSession(claims.userId, claims.sessionId)
   if (!session || session.status !== 'active') {
      throw new AppError(401, 'SESSION_INVALID', 'Session is invalid or expired')
   }
   await sessionRepository.touchSessionLastUsed(session.id)
   return { userId: session.user_id, sessionId: session.id }
}

async function unlinkTelegramService(userId, overrides) {
   const { config, repository, deliveries, transaction } = dependencies(overrides)
   requireConfiguration(config)
   return transaction(async (client) => {
      const identity = await repository.findUserTelegramIdentityForUpdate(
         userId,
         expectedIssuer,
         client,
      )
      if (!identity)
         throw new AppError(404, 'TELEGRAM_IDENTITY_NOT_LINKED', 'Telegram identity is not linked')
      if (!(await repository.hasAlternativeLogin(userId, identity.id, client))) {
         throw new AppError(409, 'LAST_LOGIN_METHOD', 'Cannot remove the last login method')
      }
      await repository.disconnectTelegramConnection(userId, config.telegram.clientId, client)
      // Queued notifications must not reach a chat the user disconnected (decisions.md 2026-11-21).
      const cancelledDeliveries = await deliveries.cancelPendingForUser(
         userId,
         config.telegram.clientId,
         'TELEGRAM_UNLINKED',
         client,
      )
      await repository.deleteTelegramIdentity(identity.id, client)
      await repository.appendAuditEvent(
         {
            actorUserId: userId,
            subjectUserId: userId,
            code: 'auth.telegram.unlinked',
            entityType: 'auth_identity',
            entityId: identity.id,
            metadata: { cancelledDeliveries },
         },
         client,
      )
      return { status: 'unlinked' }
   })
}

async function sendTelegramTestMessageService(userId, overrides) {
   const { config, repository, botProvider, blockConnection } = dependencies(overrides)
   requireConfiguration(config)
   const connection = await repository.findActiveTelegramConnection(
      userId,
      config.telegram.clientId,
   )
   if (!connection)
      throw new AppError(
         409,
         'TELEGRAM_CONNECTION_UNAVAILABLE',
         'Telegram messaging is not connected',
      )
   try {
      await botProvider.sendTestMessage(connection.chat_id)
      return { status: 'sent' }
   } catch (error) {
      // Same handling as a failed notification (D6): blocked, pending deliveries cancelled,
      // one in-app notice.
      if (error.telegramAccessUnavailable) await blockConnection(connection.id)
      throw error
   }
}

export {
   authenticateService,
   beginTelegramAuthorizationService,
   handleTelegramCallbackService,
   sendTelegramTestMessageService,
   unlinkTelegramService,
}
