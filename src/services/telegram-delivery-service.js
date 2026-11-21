import env from '../configs/env.js'
import { retryDelayMs } from '../jobs/job-worker.js'
import * as notificationRepository from '../repositories/notification-repository.js'
import * as telegramDeliveryRepository from '../repositories/telegram-delivery-repository.js'
import { withTransaction } from '../repositories/transaction-repository.js'
import { notificationExpiresAt, renderNotification, telegramMessageText } from '../utils/notification-texts.js'
import { quietUntil } from '../utils/quiet-hours.js'
import { TelegramBotProvider } from './auth/telegram-bot-provider.js'

// M14 PR 2 (decisions.md 2026-11-21, D6–D8). Sends pending Telegram deliveries:
// - re-checks account, connection, switches and quiet hours right before each send;
// - paces sends with the shared rate limiter (20/s for the bot, 1/s per chat);
// - 429: everything pauses for retry_after, the delivery and the rest of the batch go back to
//   pending without using an attempt;
// - 403 / blocked / chat not found: the delivery fails, the connection becomes blocked, the
//   user's other pending deliveries are cancelled (BOT_BLOCKED), one in-app notice is written;
// - no response (network error, timeout): unknown, never resent (at most once);
// - 5xx: retried with backoff up to maxAttempts; other 4xx: failed.
// Logs carry codes and ids only: no token, chat id or text.

const maxAttempts = 5

function dependencies(overrides = {}) {
   const config = overrides.config || env
   return {
      config,
      deliveries: overrides.deliveries || telegramDeliveryRepository,
      notifications: overrides.notifications || notificationRepository,
      botProvider: overrides.botProvider || new TelegramBotProvider(config.telegram),
      transaction: overrides.transaction || withTransaction,
      now: overrides.now || (() => new Date()),
      log: overrides.log || (() => {}),
   }
}

// Marks the connection blocked, cancels pending Telegram deliveries and writes one in-app
// telegram.disconnected per connection episode (a relink sets a new connected_at).
async function blockTelegramConnectionService(connectionId, overrides) {
   const { deliveries, notifications, transaction } = dependencies(overrides)
   return transaction(async (client) => {
      const blocked = await deliveries.blockConnection(connectionId, client)
      const cancelled = await deliveries.cancelPendingForConnection(connectionId, 'BOT_BLOCKED', client)
      if (!blocked) return { blocked: false, cancelled }
      const [recipient] = await notifications.findRecipients([blocked.user_id], client)
      if (recipient) {
         const eventCode = 'telegram.disconnected'
         await notifications.insertNotifications([{
            userId: recipient.user_id,
            eventCode,
            targetPath: '/profile',
            dedupeKey: `${eventCode}:${blocked.id}:${new Date(blocked.connected_at).toISOString()}`,
            ...renderNotification(eventCode, {}, {
               languageCode: recipient.language_code, timeZone: recipient.timezone,
            }),
         }], client)
      }
      return { blocked: true, cancelled }
   })
}

// Reasons to drop a delivery without sending, checked right before the send.
function cancelReason(row) {
   if (row.account_status !== 'active') return 'ACCOUNT_NOT_ACTIVE'
   if (row.connection_status === 'blocked') return 'BOT_BLOCKED'
   if (row.connection_status !== 'active') return 'TELEGRAM_UNLINKED'
   if (!row.telegram_enabled) return 'TELEGRAM_DISABLED'
   if (!row.event_enabled) return 'TELEGRAM_EVENT_DISABLED'
   return null
}

// Claims up to batchSize due deliveries and processes them in order. Returns how many were
// claimed (0 means the queue is empty for now).
async function sendTelegramBatchService({ limiter, batchSize = 20, leaseSeconds = env.jobLeaseSeconds }, overrides) {
   const context = dependencies(overrides)
   const { config, deliveries, botProvider, now, log } = context
   const stale = await deliveries.markStaleSendingUnknown()
   if (stale) log('telegram deliveries left without an outcome', { count: stale, code: 'LEASE_EXPIRED' })
   const rows = await deliveries.claimTelegramDeliveries({
      limit: batchSize, leaseSeconds, botId: config.telegram?.clientId ?? null,
   })
   // Connections found blocked in this batch: later rows were claimed before the block.
   const blockedInBatch = new Set()
   for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]
      const reason = blockedInBatch.has(String(row.connection_id)) ? 'BOT_BLOCKED' : cancelReason(row)
      if (reason) {
         await deliveries.finishDelivery(row.id, 'cancelled', reason)
         continue
      }
      const current = now()
      const quietEnd = quietUntil(current, { start: row.quiet_start, end: row.quiet_end, timeZone: row.timezone })
      const expiresAt = notificationExpiresAt(row.event_code, row.dedupe_key)
      if (expiresAt && quietEnd && quietEnd >= expiresAt) {
         await deliveries.finishDelivery(row.id, 'cancelled', 'QUIET_EXPIRED')
         continue
      }
      if (expiresAt && current >= expiresAt) {
         await deliveries.finishDelivery(row.id, 'cancelled', 'NOTIFICATION_EXPIRED')
         continue
      }
      if (quietEnd) {
         await deliveries.rescheduleDelivery(row.id, { nextAttemptAt: quietEnd, errorCode: 'QUIET_HOURS', consumeAttempt: false })
         continue
      }
      await limiter.acquire(String(row.chat_id))
      try {
         const result = await botProvider.sendMessage(
            String(row.chat_id),
            telegramMessageText({ title: row.title, body: row.body, targetPath: row.target_path }, config.appUrl),
         )
         await deliveries.markDeliverySent(row.id, result?.messageId ?? null)
      } catch (error) {
         if (error.retryAfter) {
            const resumeAt = new Date(now().getTime() + error.retryAfter * 1000)
            limiter.pause(error.retryAfter * 1000)
            log('telegram rate limited', { deliveryId: row.id, retryAfter: error.retryAfter, code: 'TELEGRAM_RATE_LIMITED' })
            // This delivery and the rest of the batch wait; their leases must not run out meanwhile.
            for (const waiting of rows.slice(index)) {
               await deliveries.rescheduleDelivery(waiting.id, {
                  nextAttemptAt: resumeAt, errorCode: 'TELEGRAM_RATE_LIMITED', consumeAttempt: false,
               })
            }
            return rows.length
         }
         if (error.telegramAccessUnavailable) {
            await deliveries.finishDelivery(row.id, 'failed', 'BOT_BLOCKED')
            blockedInBatch.add(String(row.connection_id))
            await blockTelegramConnectionService(row.connection_id, overrides)
            log('telegram chat unavailable', { deliveryId: row.id, code: 'BOT_BLOCKED' })
         } else if (error.networkError) {
            await deliveries.finishDelivery(row.id, 'unknown', 'TELEGRAM_NO_RESPONSE')
            log('telegram send without response', { deliveryId: row.id, code: 'TELEGRAM_NO_RESPONSE' })
         } else if (error.telegramStatus >= 500 && row.attempt_count < maxAttempts) {
            await deliveries.rescheduleDelivery(row.id, {
               nextAttemptAt: new Date(now().getTime() + retryDelayMs(row.attempt_count)),
               errorCode: 'TELEGRAM_UNAVAILABLE',
               consumeAttempt: true,
            })
         } else {
            const code = error.telegramStatus >= 500 ? 'TELEGRAM_UNAVAILABLE' : 'TELEGRAM_REJECTED'
            await deliveries.finishDelivery(row.id, 'failed', code)
            log('telegram delivery failed', { deliveryId: row.id, status: error.telegramStatus ?? null, code })
         }
      }
   }
   return rows.length
}

// Started by scripts/job-worker.js next to the job runner, only when the bot is configured.
function startTelegramSender({ limiter, intervalMs = env.jobWorkerIntervalMs, overrides, log = () => {} }) {
   let stopped = false
   let timer = null
   let running = null

   async function tick() {
      try {
         while (!stopped && await sendTelegramBatchService({ limiter }, { ...overrides, log }));
      } catch (error) {
         log('telegram sender tick failed', { code: error.code })
      }
      if (!stopped) timer = setTimeout(() => { running = tick() }, intervalMs)
   }

   running = tick()
   return {
      async stop() {
         stopped = true
         clearTimeout(timer)
         await running
      },
   }
}

export { blockTelegramConnectionService, sendTelegramBatchService, startTelegramSender }
