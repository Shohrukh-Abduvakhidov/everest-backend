import express from 'express'

import env from '../configs/env.js'
import AppError from '../utils/app-error.js'

const zipContentTypes = ['application/zip', 'application/x-zip-compressed']

// The ZIP body is read only after authentication, CSRF, permission and rate checks passed.
function questionPackageBodyMiddleware(req, res, next) {
   const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
   if (!zipContentTypes.includes(contentType)) {
      next(new AppError(415, 'PACKAGE_CONTENT_TYPE_INVALID', 'The package must be sent as application/zip'))
      return
   }
   const limit = req.app.locals.serviceDependencies.questionImports?.maxUploadBytes
      ?? env.questionImportMaxUploadBytes
   express.raw({ type: () => true, limit })(req, res, (error) => {
      if (error?.type === 'entity.too.large') {
         next(new AppError(413, 'PACKAGE_TOO_LARGE', 'Package exceeds the upload size limit'))
      } else if (error) {
         next(new AppError(400, 'PACKAGE_UPLOAD_FAILED', 'The package could not be read'))
      } else {
         next()
      }
   })
}

export { questionPackageBodyMiddleware }
