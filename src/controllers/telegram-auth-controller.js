import env from '../configs/env.js'
import { telegramAuthService } from '../services/telegram-auth-service.js'
import { setAuthCookies } from '../utils/auth-cookies.js'

function createTelegramAuthController(service = telegramAuthService) {
   async function startTelegramController(req, res, next) {
      try {
         void req
         const result = await service.beginTelegramAuthorization({ intent: 'login' })
         res.json({ data: result })
      } catch (error) {
         next(error)
      }
   }

   async function telegramCallbackController(req, res, next) {
      try {
         const result = await service.handleTelegramCallback({
            code: req.query.code,
            state: req.query.state,
            error: req.query.error,
            requestContext: { ipAddress: req.ip, userAgent: req.get('user-agent') },
         })
         if (result.accessToken) {
            setAuthCookies(res, result, env)
         }
         const { accessToken: _accessToken, refreshToken: _refreshToken, ...safeResult } = result
         res.json({ data: safeResult })
      } catch (error) {
         next(error)
      }
   }

   async function linkTelegramController(req, res, next) {
      try {
         const result = await service.beginTelegramAuthorization({
            intent: 'link',
            userId: req.auth.userId,
         })
         res.json({ data: result })
      } catch (error) {
         next(error)
      }
   }

   async function unlinkTelegramController(req, res, next) {
      try {
         res.json({ data: await service.unlinkTelegram(req.auth.userId) })
      } catch (error) {
         next(error)
      }
   }

   async function testTelegramMessageController(req, res, next) {
      try {
         res.json({ data: await service.sendTelegramTestMessage(req.auth.userId) })
      } catch (error) {
         next(error)
      }
   }

   return {
      linkTelegramController,
      startTelegramController,
      telegramCallbackController,
      testTelegramMessageController,
      unlinkTelegramController,
   }
}

const {
   linkTelegramController,
   startTelegramController,
   telegramCallbackController,
   testTelegramMessageController,
   unlinkTelegramController,
} = createTelegramAuthController()

export {
   createTelegramAuthController,
   linkTelegramController,
   startTelegramController,
   telegramCallbackController,
   testTelegramMessageController,
   unlinkTelegramController,
}
