import express from 'express'

import {
   abortAssetUploadController,
   completeAssetUploadController,
   getAssetUploadController,
   initiateAssetUploadController,
   presignAssetUploadPartsController,
} from '../controllers/asset-upload-controller.js'
import { authMiddleware } from '../middleware/auth-middleware.js'
import {
   adminMutationRateMiddleware,
   authenticatedCsrfMiddleware,
} from '../middleware/auth-protection-middleware.js'

// Upload authorization is course-scoped (assets.upload or a course teacher with
// canManageLessons), so it is enforced in the service rather than by a permission guard.
const assetsRouter = express.Router()

assetsRouter.use(authMiddleware)
assetsRouter.post(
   '/uploads',
   authenticatedCsrfMiddleware,
   adminMutationRateMiddleware,
   initiateAssetUploadController,
)
assetsRouter.get('/uploads/:uploadId', getAssetUploadController)
assetsRouter.post(
   '/uploads/:uploadId/parts',
   authenticatedCsrfMiddleware,
   presignAssetUploadPartsController,
)
assetsRouter.post(
   '/uploads/:uploadId/complete',
   authenticatedCsrfMiddleware,
   adminMutationRateMiddleware,
   completeAssetUploadController,
)
assetsRouter.post(
   '/uploads/:uploadId/abort',
   authenticatedCsrfMiddleware,
   adminMutationRateMiddleware,
   abortAssetUploadController,
)

export default assetsRouter
