import {
   deleteOfflineLicenseService,
   getOfflineLicenseDownloadService,
   issueOfflineLicenseService,
   listOfflineDevicesService,
   listSessionOfflineLicensesService,
   listUserOfflineLicensesService,
   registerOfflineDeviceService,
   removeOfflineDeviceService,
   revokeOfflineLicenseService,
} from '../services/offline-license-service.js'

function overrides(req) {
   return req.app.locals.serviceDependencies.lessons
}

async function issueOfflineLicenseController(req, res, next) {
   try {
      const data = await issueOfflineLicenseService(
         req.auth.userId,
         req.auth.sessionId,
         req.params.courseId,
         req.params.lessonId,
         req.body,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function listSessionOfflineLicensesController(req, res, next) {
   try {
      const data = await listSessionOfflineLicensesService(
         req.auth.userId,
         req.auth.sessionId,
         req.query,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function getOfflineLicenseDownloadController(req, res, next) {
   try {
      const data = await getOfflineLicenseDownloadService(
         req.auth.userId,
         req.auth.sessionId,
         req.params.licenseId,
         req.query,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function deleteOfflineLicenseController(req, res, next) {
   try {
      const data = await deleteOfflineLicenseService(
         req.auth.userId,
         req.auth.sessionId,
         req.params.licenseId,
         req.query,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function listUserOfflineLicensesController(req, res, next) {
   try {
      const data = await listUserOfflineLicensesService(
         req.auth.userId,
         req.params.userId,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function revokeOfflineLicenseController(req, res, next) {
   try {
      const data = await revokeOfflineLicenseService(
         req.auth.userId,
         req.params.licenseId,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function registerOfflineDeviceController(req, res, next) {
   try {
      const data = await registerOfflineDeviceService(req.auth.userId, req.body, overrides(req))
      res.status(data.created ? 201 : 200).json({ data })
   } catch (error) {
      next(error)
   }
}

async function listOfflineDevicesController(req, res, next) {
   try {
      const data = await listOfflineDevicesService(req.auth.userId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function removeOfflineDeviceController(req, res, next) {
   try {
      const data = await removeOfflineDeviceService(req.auth.userId, req.params.deviceId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

export {
   deleteOfflineLicenseController,
   getOfflineLicenseDownloadController,
   issueOfflineLicenseController,
   listOfflineDevicesController,
   listSessionOfflineLicensesController,
   listUserOfflineLicensesController,
   registerOfflineDeviceController,
   removeOfflineDeviceController,
   revokeOfflineLicenseController,
}
