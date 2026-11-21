import {
   countUnreadNotificationsService,
   listNotificationsService,
   markAllNotificationsReadService,
   markNotificationReadService,
} from '../services/notification-service.js'
import {
   getNotificationSettingsService,
   updateNotificationSettingsService,
} from '../services/notification-settings-service.js'

function overrides(req) {
   return req.app.locals.serviceDependencies.notifications
}

async function listNotificationsController(req, res, next) {
   try {
      const data = await listNotificationsService(req.auth.userId, req.query, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function countUnreadNotificationsController(req, res, next) {
   try {
      const data = await countUnreadNotificationsService(req.auth.userId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function markNotificationReadController(req, res, next) {
   try {
      const data = await markNotificationReadService(
         req.auth.userId,
         req.params.notificationId,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function markAllNotificationsReadController(req, res, next) {
   try {
      const data = await markAllNotificationsReadService(req.auth.userId, req.body, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function getNotificationSettingsController(req, res, next) {
   try {
      const data = await getNotificationSettingsService(req.auth.userId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function updateNotificationSettingsController(req, res, next) {
   try {
      const data = await updateNotificationSettingsService(req.auth.userId, req.body, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

export {
   getNotificationSettingsController,
   updateNotificationSettingsController,
   countUnreadNotificationsController,
   listNotificationsController,
   markAllNotificationsReadController,
   markNotificationReadController,
}
