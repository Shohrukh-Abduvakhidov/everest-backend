// Paces Telegram sends inside one process (decisions.md 2026-11-21, D8): at most `perSecond`
// messages per second for the bot (evenly spaced, no bursts) and one message per
// `perChatIntervalMs` to the same chat. pause() stops every send for a while (429 retry_after). Only one worker-jobs replica may send, otherwise the limits add up.
class TelegramRateLimiter {
   constructor({
      perSecond = 20,
      perChatIntervalMs = 1000,
      now = () => Date.now(),
      sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) }),
      maxTrackedChats = 10000,
   } = {}) {
      this.spacingMs = Math.ceil(1000 / perSecond)
      this.perChatIntervalMs = perChatIntervalMs
      this.now = now
      this.sleep = sleep
      this.maxTrackedChats = maxTrackedChats
      this.nextGlobalAt = 0
      this.pausedUntil = 0
      this.nextChatAt = new Map()
   }

   // Resolves when a message to chatKey may be sent and reserves that slot.
   async acquire(chatKey) {
      for (;;) {
         const current = this.now()
         const readyAt = Math.max(this.nextGlobalAt, this.pausedUntil, this.nextChatAt.get(chatKey) || 0)
         if (readyAt <= current) {
            this.nextGlobalAt = current + this.spacingMs
            this.nextChatAt.set(chatKey, current + this.perChatIntervalMs)
            this.forgetOldChats(current)
            return current
         }
         await this.sleep(readyAt - current)
      }
   }

   // Holds every chat for durationMs from now (by this limiter's clock).
   pause(durationMs) {
      this.pausedUntil = Math.max(this.pausedUntil, this.now() + durationMs)
   }

   forgetOldChats(current) {
      if (this.nextChatAt.size <= this.maxTrackedChats) return
      for (const [key, at] of this.nextChatAt) {
         if (at <= current) this.nextChatAt.delete(key)
      }
   }
}

export { TelegramRateLimiter }
