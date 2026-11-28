import env from '../src/configs/env.js'
import pool from '../src/configs/db.js'
import { startJobWorker } from '../src/jobs/job-worker.js'
import { TelegramRateLimiter } from '../src/jobs/telegram-rate-limiter.js'
import { achievementJobHandlers, scheduleAchievementJobsService } from '../src/services/achievement-service.js'
import {
   notificationJobHandlers,
   scheduleNotificationRetentionService,
} from '../src/services/notification-service.js'
import { siteJobHandlers } from '../src/services/site-content-service.js'
import { startTelegramSender } from '../src/services/telegram-delivery-service.js'

// General background runner: background_jobs (notification fan-out, achievements and ranking
// snapshots, site revalidation webhooks) and, when the bot is
// configured, the Telegram sender (20 messages/s for the bot, 1/s per chat). Run exactly one
// replica: the rate limits are kept in this process. Output has codes only, never payloads,
// chat ids, texts or tokens.
const log = (message, details) => console.log(message, details)
const worker = startJobWorker({ handlers: { ...notificationJobHandlers, ...achievementJobHandlers, ...siteJobHandlers }, log })
const telegramConfigured = Boolean(env.telegram.clientId && env.telegram.botToken)
const sender = telegramConfigured
   ? startTelegramSender({ limiter: new TelegramRateLimiter({ perSecond: 20, perChatIntervalMs: 1000 }), log })
   : null
// Daily retention job (notifications older than 180 days). Checked at start and every hour;
// the date in the job key makes it run once a day however often this fires or restarts.
const scheduleRetention = () => scheduleNotificationRetentionService()
   .catch((error) => log('notification retention scheduling failed', { code: error.code }))
scheduleRetention()
const retentionTimer = setInterval(scheduleRetention, 3600000)
retentionTimer.unref()
// M13: the daily streak run (00:01), the weekly snapshot (Monday 00:05) and the monthly one (the
// 1st, 00:10), Asia/Dushanbe. Checked at start and every 5 minutes; the period in each job key
// queues it once, and a job becomes due at its time even when queued earlier.
const scheduleAchievements = () => scheduleAchievementJobsService()
   .catch((error) => log('achievement scheduling failed', { code: error.code }))
scheduleAchievements()
const achievementTimer = setInterval(scheduleAchievements, 300000)
achievementTimer.unref()

console.log('Job worker started', {
   workerId: worker.workerId,
   telegramSender: telegramConfigured,
   appUrl: env.appUrl ? 'set' : 'missing',
})

async function shutdown(signal) {
   console.log(`Received ${signal}; stopping the job worker`)
   clearInterval(retentionTimer)
   clearInterval(achievementTimer)
   await Promise.all([worker.stop(), sender?.stop()])
   await pool.end()
}

process.once('SIGTERM', () => shutdown('SIGTERM'))
process.once('SIGINT', () => shutdown('SIGINT'))
