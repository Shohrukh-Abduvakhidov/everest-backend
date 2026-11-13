import express from 'express'

import {
   listOfflineDevicesController,
   registerOfflineDeviceController,
   removeOfflineDeviceController,
} from '../controllers/offline-license-controller.js'
import { authMiddleware } from '../middleware/auth-middleware.js'
import { authenticatedCsrfMiddleware } from '../middleware/auth-protection-middleware.js'

// App-generated device ids for in-app offline viewing (OFFLINE_MAX_DEVICES per user).
const offlineDevicesRouter = express.Router()

offlineDevicesRouter.use(authMiddleware)
offlineDevicesRouter.get('/', listOfflineDevicesController)
offlineDevicesRouter.post('/', authenticatedCsrfMiddleware, registerOfflineDeviceController)
offlineDevicesRouter.delete('/:deviceId', authenticatedCsrfMiddleware, removeOfflineDeviceController)

export default offlineDevicesRouter
