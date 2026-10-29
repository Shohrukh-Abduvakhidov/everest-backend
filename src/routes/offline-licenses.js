import express from 'express'

import {
   deleteOfflineLicenseController,
   getOfflineLicenseDownloadController,
   listSessionOfflineLicensesController,
} from '../controllers/offline-license-controller.js'
import { authMiddleware } from '../middleware/auth-middleware.js'
import {
   authenticatedCsrfMiddleware,
   learnerMediaRateMiddleware,
} from '../middleware/auth-protection-middleware.js'

// Licenses of the current session (device) only.
const offlineLicensesRouter = express.Router()

offlineLicensesRouter.use(authMiddleware)
offlineLicensesRouter.get('/', listSessionOfflineLicensesController)
offlineLicensesRouter.get(
   '/:licenseId/download',
   learnerMediaRateMiddleware,
   getOfflineLicenseDownloadController,
)
offlineLicensesRouter.delete('/:licenseId', authenticatedCsrfMiddleware, deleteOfflineLicenseController)

export default offlineLicensesRouter
