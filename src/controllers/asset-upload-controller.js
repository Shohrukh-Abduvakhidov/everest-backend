import {
   abortAssetUploadService,
   completeAssetUploadService,
   getAssetUploadService,
   initiateAssetUploadService,
   presignAssetUploadPartsService,
} from '../services/asset-upload-service.js'

function overrides(req) {
   return req.app.locals.serviceDependencies.assets
}

async function initiateAssetUploadController(req, res, next) {
   try {
      const data = await initiateAssetUploadService(req.auth.userId, req.body, overrides(req))
      res.status(201).json({ data })
   } catch (error) {
      next(error)
   }
}

async function getAssetUploadController(req, res, next) {
   try {
      const data = await getAssetUploadService(req.auth.userId, req.params.uploadId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function presignAssetUploadPartsController(req, res, next) {
   try {
      const data = await presignAssetUploadPartsService(
         req.auth.userId,
         req.params.uploadId,
         req.body,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function completeAssetUploadController(req, res, next) {
   try {
      const data = await completeAssetUploadService(
         req.auth.userId,
         req.params.uploadId,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function abortAssetUploadController(req, res, next) {
   try {
      const data = await abortAssetUploadService(req.auth.userId, req.params.uploadId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

export {
   abortAssetUploadController,
   completeAssetUploadController,
   getAssetUploadController,
   initiateAssetUploadController,
   presignAssetUploadPartsController,
}
