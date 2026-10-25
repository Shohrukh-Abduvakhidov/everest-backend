import pool from '../configs/db.js'
import { normalizeInternalId } from '../utils/internal-id.js'

async function findRecoveryAccountForUpdate(phoneE164, telegramBotId, client) {
  const result = await client.query(
    `SELECT account.id AS user_id, account.status, phone.id AS user_phone_id,
       EXISTS (
         SELECT 1 FROM auth_identities AS identity
         WHERE identity.user_id = account.id AND identity.provider = 'telegram'
       ) AS has_telegram_identity,
       connection.chat_id AS telegram_chat_id
     FROM user_phones AS phone
     JOIN users AS account ON account.id = phone.user_id
     JOIN user_passwords AS credential ON credential.user_id = account.id
     LEFT JOIN telegram_connections AS connection
       ON connection.user_id = account.id AND connection.bot_id = $2
       AND connection.status = 'active'
     WHERE phone.phone_e164 = $1
     FOR UPDATE OF account, phone, credential`,
    [phoneE164, telegramBotId]
  )
  return result.rows[0] || null
}

async function getRecoveryRequestWindow(userId, channel, client) {
  const result = await client.query(
    `SELECT max(created_at) AS latest_created_at,
       count(*) FILTER (WHERE created_at > CURRENT_TIMESTAMP - INTERVAL '1 hour')::int AS hourly_count
     FROM auth_challenges
     WHERE user_id = $1 AND purpose = 'reset_password' AND channel = $2`,
    [normalizeInternalId(userId), channel]
  )
  return result.rows[0]
}

async function invalidateActiveRecoveryChallenges(userId, client) {
  await client.query(
    `UPDATE auth_challenges SET invalidated_at = CURRENT_TIMESTAMP
     WHERE user_id = $1 AND purpose = 'reset_password'
       AND consumed_at IS NULL AND invalidated_at IS NULL`,
    [normalizeInternalId(userId)]
  )
}

async function createRecoveryChallenge(challenge, client) {
  const result = await client.query(
    `INSERT INTO auth_challenges
      (user_id, user_phone_id, purpose, channel, target_phone_e164,
       secret_hash, max_attempts, expires_at, public_id_hash)
     VALUES ($1, $2, 'reset_password', $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [normalizeInternalId(challenge.userId), normalizeInternalId(challenge.userPhoneId),
      challenge.channel, challenge.phoneE164, challenge.secretHash, challenge.maxAttempts,
      challenge.expiresAt, challenge.publicIdHash]
  )
  return result.rows[0]
}

async function invalidateChallenge(challengeId, client) {
  await client.query(
    `UPDATE auth_challenges SET invalidated_at = COALESCE(invalidated_at, CURRENT_TIMESTAMP)
     WHERE id = $1`,
    [normalizeInternalId(challengeId)]
  )
}

async function findChallengeForUpdate(publicIdHash, client) {
  const result = await client.query(
    `SELECT challenge.id, challenge.user_id, challenge.secret_hash,
       challenge.attempts_count, challenge.max_attempts, challenge.expires_at,
       challenge.consumed_at, challenge.invalidated_at, account.status
     FROM auth_challenges AS challenge
     JOIN users AS account ON account.id = challenge.user_id
     WHERE challenge.public_id_hash = $1 AND challenge.purpose = 'reset_password'
     FOR UPDATE OF challenge, account`,
    [publicIdHash]
  )
  return result.rows[0] || null
}

async function recordFailedAttempt(challengeId, client) {
  const result = await client.query(
    `UPDATE auth_challenges
     SET attempts_count = attempts_count + 1,
       invalidated_at = CASE WHEN attempts_count + 1 >= max_attempts
         THEN CURRENT_TIMESTAMP ELSE invalidated_at END
     WHERE id = $1
     RETURNING attempts_count, max_attempts, invalidated_at`,
    [normalizeInternalId(challengeId)]
  )
  return result.rows[0]
}

async function authorizePasswordReset(challengeId, resetTokenHash, resetExpiresAt, client) {
  await client.query(
    `UPDATE auth_challenges
     SET consumed_at = CURRENT_TIMESTAMP, reset_token_hash = $2, reset_expires_at = $3
     WHERE id = $1`,
    [normalizeInternalId(challengeId), resetTokenHash, resetExpiresAt]
  )
}

async function findResetAuthorizationForUpdate(resetTokenHash, client) {
  const result = await client.query(
    `SELECT challenge.id, challenge.user_id, challenge.reset_expires_at,
       challenge.reset_consumed_at, challenge.invalidated_at, account.status
     FROM auth_challenges AS challenge
     JOIN users AS account ON account.id = challenge.user_id
     WHERE challenge.reset_token_hash = $1 AND challenge.purpose = 'reset_password'
     FOR UPDATE OF challenge, account`,
    [resetTokenHash]
  )
  return result.rows[0] || null
}

async function replacePassword(userId, passwordHash, client) {
  await client.query(
    `UPDATE user_passwords SET password_hash = $2, changed_at = CURRENT_TIMESTAMP
     WHERE user_id = $1`,
    [normalizeInternalId(userId), passwordHash]
  )
}

async function consumeResetAuthorization(challengeId, client) {
  await client.query(
    `UPDATE auth_challenges SET reset_consumed_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [normalizeInternalId(challengeId)]
  )
}

async function findChallengeByPublicHash(publicIdHash, db = pool) {
  const result = await db.query(
    `SELECT id, user_id, channel, secret_hash, attempts_count, max_attempts,
       expires_at, consumed_at, invalidated_at, reset_token_hash,
       reset_expires_at, reset_consumed_at
     FROM auth_challenges WHERE public_id_hash = $1`,
    [publicIdHash]
  )
  return result.rows[0] || null
}

export {
  authorizePasswordReset, consumeResetAuthorization, createRecoveryChallenge,
  findChallengeByPublicHash, findChallengeForUpdate, findRecoveryAccountForUpdate,
  findResetAuthorizationForUpdate, getRecoveryRequestWindow, invalidateActiveRecoveryChallenges,
  invalidateChallenge, recordFailedAttempt, replacePassword,
}
