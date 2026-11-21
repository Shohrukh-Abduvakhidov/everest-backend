import AppError from '../../utils/app-error.js'

function deliveryError(fields) {
   const error = new AppError(
      502,
      'TELEGRAM_MESSAGE_FAILED',
      'Telegram test message could not be delivered',
   )
   return Object.assign(error, fields)
}

class TelegramBotProvider {
   constructor(config, fetchImplementation = globalThis.fetch) {
      this.config = config
      this.fetch = fetchImplementation
   }

   // Plain text only (no parse_mode), so user content never needs escaping. Returns the
   // Telegram message id. Failures are AppError 502 with:
   //   telegramStatus            HTTP status from Telegram (absent when no response arrived);
   //   retryAfter                seconds from a 429 response;
   //   telegramAccessUnavailable the bot may not write to this chat (403, blocked, not found);
   //   networkError              no response: the message may or may not have been delivered.
   async sendMessage(chatId, text) {
      let response
      try {
         response = await this.fetch(
            `https://api.telegram.org/bot${this.config.botToken}/sendMessage`,
            {
               method: 'POST',
               headers: { 'content-type': 'application/json' },
               body: JSON.stringify({ chat_id: chatId, text }),
               signal: AbortSignal.timeout(this.config.messageTimeoutMs || 10000),
            },
         )
      } catch {
         throw deliveryError({ networkError: true, telegramAccessUnavailable: false })
      }
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body.ok !== true) {
         const description = String(body.description || '')
         const blocked =
            response.status === 403 ||
            /blocked|deactivated|chat not found|forbidden/i.test(description)
         const retryAfter = Number(body.parameters?.retry_after)
         throw deliveryError({
            telegramStatus: response.status,
            telegramAccessUnavailable: blocked,
            retryAfter: response.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0
               ? retryAfter
               : null,
         })
      }
      const messageId = body.result?.message_id
      return { messageId: messageId === undefined || messageId === null ? null : String(messageId) }
   }

   async sendRecoveryCode(chatId, code) {
      return this.sendMessage(chatId, `EVEREST password recovery code: ${code}`)
   }

   async sendConnectionConfirmation(chatId) {
      return this.sendMessage(chatId, 'Telegram подключён к EVEREST')
   }

   async sendTestMessage(chatId) {
      return this.sendMessage(chatId, 'EVEREST Telegram connection test')
   }
}

export { TelegramBotProvider }
