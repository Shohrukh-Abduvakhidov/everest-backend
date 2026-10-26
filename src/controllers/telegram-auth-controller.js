import env from '../configs/env.js'
import {
   authenticateService,
   beginTelegramAuthorizationService,
   handleTelegramCallbackService,
   sendTelegramTestMessageService,
   unlinkTelegramService,
} from '../services/telegram-auth-service.js'
import { setAuthCookies } from '../utils/auth-cookies.js'

async function startTelegramController(req, res, next) {
   try {
      const result = await beginTelegramAuthorizationService(
         { intent: 'login' },
         req.app.locals.serviceDependencies.telegramAuth,
      )

      res.json({ data: result })
   } catch (error) {
      next(error)
   }
}

async function telegramCallbackController(req, res, next) {
   try {
      const result = await handleTelegramCallbackService(
         {
            code: req.query.code,
            state: req.query.state,
            error: req.query.error,
            requestContext: {
               ipAddress: req.ip,
               userAgent: req.get('user-agent'),
            },
         },
         req.app.locals.serviceDependencies.telegramAuth,
      )

      if (result.accessToken) setAuthCookies(res, result, env)
      const {
         accessToken: _accessToken,
         csrfToken: _csrfToken,
         refreshToken: _refreshToken,
         ...safeResult
      } = result
      res.json({ data: safeResult })
   } catch (error) {
      next(error)
   }
}

async function linkTelegramController(req, res, next) {
   try {
      const result = await beginTelegramAuthorizationService(
         {
            intent: 'link',
            userId: req.auth.userId,
         },
         req.app.locals.serviceDependencies.telegramAuth,
      )

      res.json({ data: result })
   } catch (error) {
      next(error)
   }
}

async function unlinkTelegramController(req, res, next) {
   try {
      const data = await unlinkTelegramService(
         req.auth.userId,
         req.app.locals.serviceDependencies.telegramAuth,
      )

      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function testTelegramMessageController(req, res, next) {
   try {
      const data = await sendTelegramTestMessageService(
         req.auth.userId,
         req.app.locals.serviceDependencies.telegramAuth,
      )

      res.json({ data })
   } catch (error) {
      next(error)
   }
}

export {
   linkTelegramController,
   startTelegramController,
   telegramCallbackController,
   testTelegramMessageController,
   unlinkTelegramController,
}
