import AppError from '../../utils/app-error.js'

class TelegramBotProvider {
   constructor(config, fetchImplementation = globalThis.fetch) {
      this.config = config
      this.fetch = fetchImplementation
   }

   async sendMessage(chatId, text) {
      let response
      try {
         response = await this.fetch(
            `https://api.telegram.org/bot${this.config.botToken}/sendMessage`,
            {
               method: 'POST',
               headers: { 'content-type': 'application/json' },
               body: JSON.stringify({ chat_id: chatId, text }),
            },
         )
      } catch {
         throw new AppError(
            502,
            'TELEGRAM_MESSAGE_FAILED',
            'Telegram test message could not be delivered',
         )
      }
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body.ok !== true) {
         const blocked =
            response.status === 403 ||
            /blocked|deactivated|chat not found|forbidden/i.test(String(body.description || ''))
         const error = new AppError(
            502,
            'TELEGRAM_MESSAGE_FAILED',
            'Telegram test message could not be delivered',
         )
         error.telegramAccessUnavailable = blocked
         throw error
      }
   }

   async sendRecoveryCode(chatId, code) {
      return this.sendMessage(chatId, `EVEREST password recovery code: ${code}`)
   }

   async sendTestMessage(chatId) {
      return this.sendMessage(chatId, 'EVEREST Telegram connection test')
   }
}

export { TelegramBotProvider }
