import env from '../configs/env.js'
import * as authRepository from '../repositories/auth-repository.js'
import * as recoveryRepository from '../repositories/password-recovery-repository.js'
import * as sessionRepository from '../repositories/session-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import AppError from '../utils/app-error.js'
import { normalizePhone, validateBody, validatePassword } from '../utils/auth-input.js'
import { hashPassword } from '../utils/password.js'
import {
   createOpaqueToken,
   createVerificationCode,
   hashOpaqueToken,
   hashVerificationCode,
   secureHashEqual,
} from '../utils/recovery-token.js'
import { DisabledSmsProvider } from './auth/sms-provider.js'
import { TelegramBotProvider } from './auth/telegram-bot-provider.js'

function recoveryError(code, message) {
   return new AppError(401, code, message)
}

function validateChannel(value) {
   if (value !== 'telegram' && value !== 'sms') {
      throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [
         { field: 'channel', message: 'Channel must be telegram or sms' },
      ])
   }
   return value
}

function createPasswordRecoveryService({
   config = env,
   repository = recoveryRepository,
   sessions = sessionRepository,
   auth = authRepository,
   transaction = withTransaction,
   telegramProvider = new TelegramBotProvider(config.telegram),
   smsProvider = new DisabledSmsProvider(),
   passwordHasher = { hash: hashPassword },
   now = () => new Date(),
} = {}) {
   function hasVerifierConfiguration() {
      return typeof config.otpHmacSecret === 'string' && config.otpHmacSecret.length >= 32
   }

   async function requestPasswordRecoveryService(body) {
      validateBody(body, ['phone', 'channel'])
      const phoneE164 = normalizePhone(body.phone)
      const channel = validateChannel(body.channel)
      const challengeIdentifier = createOpaqueToken()
      const accepted = { status: 'accepted', challengeId: challengeIdentifier }
      if (!hasVerifierConfiguration() || (channel === 'sms' && !smsProvider.isAvailable())) {
         return accepted
      }

      const code = createVerificationCode()
      const publicIdHash = hashOpaqueToken(challengeIdentifier)
      const secretHash = hashVerificationCode(challengeIdentifier, code, config.otpHmacSecret)
      const created = await transaction(async (client) => {
         const account = await repository.findRecoveryAccountForUpdate(
            phoneE164,
            config.telegram.clientId,
            client,
         )
         if (!account || account.status === 'rejected') return null
         if (
            channel === 'telegram' &&
            (!account.has_telegram_identity || !account.telegram_chat_id)
         )
            return null

         const window = await repository.getRecoveryRequestWindow(account.user_id, channel, client)
         const currentTime = now()
         if (
            window.latest_created_at &&
            currentTime.getTime() - window.latest_created_at.getTime() <
               config.recoveryResendCooldownSeconds * 1000
         )
            return null
         if (window.hourly_count >= config.recoveryMaxRequestsPerHour) return null

         await repository.invalidateActiveRecoveryChallenges(account.user_id, client)
         const challenge = await repository.createRecoveryChallenge(
            {
               userId: account.user_id,
               userPhoneId: account.user_phone_id,
               channel,
               phoneE164,
               secretHash,
               maxAttempts: config.recoveryMaxAttempts,
               expiresAt: new Date(
                  currentTime.getTime() + config.recoveryChallengeTtlSeconds * 1000,
               ),
               publicIdHash,
            },
            client,
         )
         await auth.appendAuditEvent(
            {
               actorUserId: account.user_id,
               subjectUserId: account.user_id,
               code: 'auth.password_recovery.requested',
               entityType: 'auth_challenge',
               entityId: challenge.id,
               metadata: { channel },
            },
            client,
         )
         return {
            challengeId: challenge.id,
            chatId: account.telegram_chat_id,
         }
      })

      if (!created) return accepted
      try {
         const delivery =
            channel === 'telegram'
               ? await telegramProvider.sendRecoveryCode(created.chatId, code)
               : await smsProvider.sendRecoveryCode(phoneE164, code)
         if (delivery?.delivered === false) throw new Error('Recovery delivery unavailable')
      } catch {
         await transaction((client) => repository.invalidateChallenge(created.challengeId, client))
      }
      return accepted
   }

   async function verifyPasswordRecoveryService(body) {
      validateBody(body, ['challengeId', 'code'])
      const publicIdHash = hashOpaqueToken(body.challengeId)
      const suppliedHash = hashVerificationCode(body.challengeId, body.code, config.otpHmacSecret)
      if (!publicIdHash || !suppliedHash) {
         throw recoveryError(
            'INVALID_RECOVERY_CHALLENGE',
            'Recovery challenge is invalid or expired',
         )
      }
      const resetAuthorization = createOpaqueToken()
      const outcome = await transaction(async (client) => {
         const challenge = await repository.findChallengeForUpdate(publicIdHash, client)
         const currentTime = now()
         if (
            !challenge ||
            challenge.consumed_at ||
            challenge.invalidated_at ||
            challenge.expires_at <= currentTime ||
            challenge.status === 'rejected' ||
            challenge.attempts_count >= challenge.max_attempts
         )
            return { invalid: true }
         if (!secureHashEqual(challenge.secret_hash, suppliedHash)) {
            await repository.recordFailedAttempt(challenge.id, client)
            return { invalid: true }
         }
         const resetExpiresAt = new Date(
            currentTime.getTime() + config.recoveryResetTtlSeconds * 1000,
         )
         await repository.authorizePasswordReset(
            challenge.id,
            hashOpaqueToken(resetAuthorization),
            resetExpiresAt,
            client,
         )
         await auth.appendAuditEvent(
            {
               actorUserId: challenge.user_id,
               subjectUserId: challenge.user_id,
               code: 'auth.password_recovery.verified',
               entityType: 'auth_challenge',
               entityId: challenge.id,
               metadata: {},
            },
            client,
         )
         return { status: 'verified', resetAuthorization, expiresAt: resetExpiresAt }
      })
      if (outcome.invalid) {
         throw recoveryError(
            'INVALID_RECOVERY_CHALLENGE',
            'Recovery challenge is invalid or expired',
         )
      }
      return outcome
   }

   async function resetPasswordService(body) {
      validateBody(body, ['resetAuthorization', 'newPassword'])
      const resetTokenHash = hashOpaqueToken(body.resetAuthorization)
      if (!resetTokenHash) {
         throw recoveryError(
            'INVALID_RESET_AUTHORIZATION',
            'Reset authorization is invalid or expired',
         )
      }
      const password = validatePassword(body.newPassword)
      const outcome = await transaction(async (client) => {
         const authorization = await repository.findResetAuthorizationForUpdate(
            resetTokenHash,
            client,
         )
         const currentTime = now()
         if (
            !authorization ||
            authorization.reset_consumed_at ||
            authorization.invalidated_at ||
            authorization.reset_expires_at <= currentTime ||
            authorization.status === 'rejected'
         ) {
            return { invalid: true }
         }
         const passwordHash = await passwordHasher.hash(password)
         await repository.replacePassword(authorization.user_id, passwordHash, client)
         await repository.consumeResetAuthorization(authorization.id, client)
         const revoked = await sessions.revokeAllUserSessions(
            authorization.user_id,
            'password_reset',
            client,
         )
         await auth.appendAuditEvent(
            {
               actorUserId: authorization.user_id,
               subjectUserId: authorization.user_id,
               code: 'auth.password_recovery.completed',
               entityType: 'auth_challenge',
               entityId: authorization.id,
               metadata: { revokedSessions: revoked.sessions },
            },
            client,
         )
         return { status: 'password_reset' }
      })
      if (outcome.invalid) {
         throw recoveryError(
            'INVALID_RESET_AUTHORIZATION',
            'Reset authorization is invalid or expired',
         )
      }
      return outcome
   }

   return {
      request: requestPasswordRecoveryService,
      reset: resetPasswordService,
      verify: verifyPasswordRecoveryService,
   }
}

const passwordRecoveryService = createPasswordRecoveryService()

export { createPasswordRecoveryService, passwordRecoveryService }
