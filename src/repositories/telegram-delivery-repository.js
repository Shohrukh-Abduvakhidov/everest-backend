import pool from '../configs/db.js'
import { normalizeInternalId as normalizeId } from '../utils/internal-id.js'

const normalizeInternalId = (value) => normalizeId(String(value))

// No notification_settings row means the defaults: Telegram on, quiet hours 22:00–08:00.
const settingsColumns = `COALESCE(settings.telegram_enabled, TRUE) AS telegram_enabled,
   CASE WHEN settings.user_id IS NULL THEN TIME '22:00' ELSE settings.quiet_start END AS quiet_start,
   CASE WHEN settings.user_id IS NULL THEN TIME '08:00' ELSE settings.quiet_end END AS quiet_end,
   COALESCE(profile.timezone, 'Asia/Dushanbe') AS timezone`

// ---------------------------------------------------------------- creation (inside the fan-out transaction)

// Recipients that can get this event on Telegram: active account, linked Telegram identity and an
// active connection to the configured bot. The switches are returned, not filtered, so the caller
// decides (and tests can see why a row was skipped).
async function findTelegramTargets(userIds, botId, eventCode, db = pool) {
   if (!userIds.length) return []
   const result = await db.query(
      `SELECT account.id AS user_id, connection.id AS connection_id, ${settingsColumns},
          COALESCE(preference.enabled, TRUE) AS event_enabled
       FROM users AS account
       JOIN telegram_connections AS connection
         ON connection.user_id = account.id AND connection.bot_id = $2 AND connection.status = 'active'
       LEFT JOIN notification_settings AS settings ON settings.user_id = account.id
       LEFT JOIN user_profiles AS profile ON profile.user_id = account.id
       LEFT JOIN notification_preferences AS preference
         ON preference.user_id = account.id AND preference.event_code = $3 AND preference.channel = 'telegram'
       WHERE account.id = ANY($1::bigint[]) AND account.status = 'active'
         AND EXISTS (
            SELECT 1 FROM auth_identities AS identity
            WHERE identity.user_id = account.id AND identity.provider = 'telegram'
         )`,
      [userIds.map(normalizeInternalId), botId, eventCode],
   )
   return result.rows
}

async function insertTelegramDeliveries(rows, client) {
   if (!rows.length) return 0
   const result = await client.query(
      `INSERT INTO notification_deliveries
          (notification_id, channel, telegram_connection_id, destination_key, next_attempt_at)
       SELECT notification_id, 'telegram', connection_id, 'telegram:' || connection_id, next_attempt_at
       FROM unnest($1::bigint[], $2::bigint[], $3::timestamptz[])
          AS input(notification_id, connection_id, next_attempt_at)
       ON CONFLICT (notification_id, channel, destination_key) DO NOTHING`,
      [
         rows.map((row) => normalizeInternalId(row.notificationId)),
         rows.map((row) => normalizeInternalId(row.connectionId)),
         rows.map((row) => row.nextAttemptAt),
      ],
   )
   return result.rowCount
}

// ---------------------------------------------------------------- sender

// At most once: a delivery still "sending" after its lease may already have reached Telegram,
// so it becomes "unknown" and is never sent again.
async function markStaleSendingUnknown(db = pool) {
   const result = await db.query(
      `UPDATE notification_deliveries
       SET status = 'unknown', last_error_code = 'LEASE_EXPIRED', lease_expires_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE channel = 'telegram' AND status = 'sending' AND lease_expires_at < CURRENT_TIMESTAMP`,
   )
   return result.rowCount
}

// Claims due deliveries (SKIP LOCKED) and returns everything the sender re-checks before sending.
async function claimTelegramDeliveries({ limit, leaseSeconds }, db = pool) {
   const result = await db.query(
      `WITH claimed AS (
          UPDATE notification_deliveries AS delivery
          SET status = 'sending', attempt_count = delivery.attempt_count + 1,
              lease_expires_at = CURRENT_TIMESTAMP + make_interval(secs => $2),
              updated_at = CURRENT_TIMESTAMP
          WHERE delivery.id IN (
             SELECT id FROM notification_deliveries
             WHERE channel = 'telegram' AND status = 'pending'
               AND next_attempt_at <= CURRENT_TIMESTAMP
             ORDER BY next_attempt_at, id
             FOR UPDATE SKIP LOCKED
             LIMIT $1
          )
          RETURNING delivery.id, delivery.notification_id, delivery.telegram_connection_id,
             delivery.attempt_count, delivery.next_attempt_at
       )
       SELECT claimed.id, claimed.attempt_count, claimed.telegram_connection_id AS connection_id,
          connection.chat_id, connection.status AS connection_status, connection.connected_at,
          notification.user_id, notification.event_code, notification.title, notification.body,
          notification.target_path, account.status AS account_status, ${settingsColumns},
          COALESCE(preference.enabled, TRUE) AS event_enabled
       FROM claimed
       JOIN telegram_connections AS connection ON connection.id = claimed.telegram_connection_id
       JOIN notifications AS notification ON notification.id = claimed.notification_id
       JOIN users AS account ON account.id = notification.user_id
       LEFT JOIN notification_settings AS settings ON settings.user_id = account.id
       LEFT JOIN user_profiles AS profile ON profile.user_id = account.id
       LEFT JOIN notification_preferences AS preference
         ON preference.user_id = account.id AND preference.event_code = notification.event_code
         AND preference.channel = 'telegram'
       ORDER BY claimed.next_attempt_at, claimed.id`,
      [limit, leaseSeconds],
   )
   return result.rows
}

async function markDeliverySent(deliveryId, messageId, db = pool) {
   await db.query(
      `UPDATE notification_deliveries
       SET status = 'sent', sent_at = CURRENT_TIMESTAMP, provider_message_id = $2,
           last_error_code = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'sending'`,
      [normalizeInternalId(deliveryId), messageId],
   )
}

// Back to pending. consumeAttempt false gives back the attempt counted by the claim (quiet hours,
// 429, a batch stopped by a 429): those are not failures.
async function rescheduleDelivery(deliveryId, { nextAttemptAt, errorCode, consumeAttempt }, db = pool) {
   await db.query(
      `UPDATE notification_deliveries
       SET status = 'pending', next_attempt_at = $2, last_error_code = $3,
           attempt_count = CASE WHEN $4::boolean THEN attempt_count ELSE GREATEST(attempt_count - 1, 0) END,
           lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'sending'`,
      [normalizeInternalId(deliveryId), nextAttemptAt, errorCode, consumeAttempt],
   )
}

async function finishDelivery(deliveryId, status, errorCode, db = pool) {
   await db.query(
      `UPDATE notification_deliveries
       SET status = $2, last_error_code = $3, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'sending'`,
      [normalizeInternalId(deliveryId), status, errorCode],
   )
}

// ---------------------------------------------------------------- blocked bot / unlink

// Only the first caller sees the row (active → blocked), so the in-app notice is written once.
async function blockConnection(connectionId, client) {
   const result = await client.query(
      `UPDATE telegram_connections
       SET status = 'blocked', blocked_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'active'
       RETURNING id, user_id, connected_at`,
      [normalizeInternalId(connectionId)],
   )
   return result.rows[0] || null
}

async function cancelPendingForConnection(connectionId, errorCode, db = pool) {
   const result = await db.query(
      `UPDATE notification_deliveries
       SET status = 'cancelled', last_error_code = $2, lease_expires_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE telegram_connection_id = $1 AND status = 'pending'`,
      [normalizeInternalId(connectionId), errorCode],
   )
   return result.rowCount
}

async function cancelPendingForUser(userId, botId, errorCode, db = pool) {
   const result = await db.query(
      `UPDATE notification_deliveries
       SET status = 'cancelled', last_error_code = $3, lease_expires_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE status = 'pending' AND telegram_connection_id IN (
          SELECT id FROM telegram_connections WHERE user_id = $1 AND bot_id = $2
       )`,
      [normalizeInternalId(userId), botId, errorCode],
   )
   return result.rowCount
}

// ---------------------------------------------------------------- settings

async function findSettings(userId, botId, db = pool) {
   const result = await db.query(
      `SELECT ${settingsColumns},
          (EXISTS (
             SELECT 1 FROM auth_identities AS identity
             WHERE identity.user_id = account.id AND identity.provider = 'telegram'
          ) AND EXISTS (
             SELECT 1 FROM telegram_connections AS connection
             WHERE connection.user_id = account.id AND connection.bot_id = $2::text
               AND connection.status = 'active'
          )) AS messaging_connected
       FROM users AS account
       LEFT JOIN notification_settings AS settings ON settings.user_id = account.id
       LEFT JOIN user_profiles AS profile ON profile.user_id = account.id
       WHERE account.id = $1`,
      [normalizeInternalId(userId), botId || null],
   )
   return result.rows[0] || null
}

async function listTelegramPreferences(userId, db = pool) {
   const result = await db.query(
      `SELECT event_code, enabled FROM notification_preferences
       WHERE user_id = $1 AND channel = 'telegram'`,
      [normalizeInternalId(userId)],
   )
   return result.rows
}

async function saveSettings(userId, { telegramEnabled, hasQuietHours, quietStart, quietEnd }, client) {
   await client.query(
      `INSERT INTO notification_settings (user_id, telegram_enabled, quiet_start, quiet_end)
       VALUES ($1, COALESCE($2, TRUE),
          CASE WHEN $3 THEN $4::time ELSE TIME '22:00' END,
          CASE WHEN $3 THEN $5::time ELSE TIME '08:00' END)
       ON CONFLICT (user_id) DO UPDATE SET
          telegram_enabled = COALESCE($2, notification_settings.telegram_enabled),
          quiet_start = CASE WHEN $3 THEN $4::time ELSE notification_settings.quiet_start END,
          quiet_end = CASE WHEN $3 THEN $5::time ELSE notification_settings.quiet_end END,
          updated_at = CURRENT_TIMESTAMP`,
      [normalizeInternalId(userId), telegramEnabled, hasQuietHours, quietStart, quietEnd],
   )
}

async function saveTelegramPreferences(userId, preferences, client) {
   if (!preferences.length) return
   await client.query(
      `INSERT INTO notification_preferences (user_id, event_code, channel, enabled)
       SELECT $1, event_code, 'telegram', enabled
       FROM unnest($2::text[], $3::boolean[]) AS input(event_code, enabled)
       ON CONFLICT (user_id, event_code, channel) DO UPDATE SET enabled = EXCLUDED.enabled`,
      [
         normalizeInternalId(userId),
         preferences.map((preference) => preference.eventCode),
         preferences.map((preference) => preference.enabled),
      ],
   )
}

export {
   blockConnection,
   cancelPendingForConnection,
   cancelPendingForUser,
   claimTelegramDeliveries,
   findSettings,
   findTelegramTargets,
   finishDelivery,
   insertTelegramDeliveries,
   listTelegramPreferences,
   markDeliverySent,
   markStaleSendingUnknown,
   rescheduleDelivery,
   saveSettings,
   saveTelegramPreferences,
}
