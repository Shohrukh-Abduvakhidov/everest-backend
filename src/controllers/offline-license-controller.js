import {
   deleteOfflineLicenseService,
   getOfflineLicenseDownloadService,
   issueOfflineLicenseService,
   listSessionOfflineLicensesService,
   listUserOfflineLicensesService,
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

export {
   deleteOfflineLicenseController,
   getOfflineLicenseDownloadController,
   issueOfflineLicenseController,
   listSessionOfflineLicensesController,
   listUserOfflineLicensesController,
   revokeOfflineLicenseController,
}
