import express from 'express'

import { authorizePermissionService } from '../services/authorization-service.js'
import { maxImageBytes } from '../services/site-content-service.js'
import AppError from '../utils/app-error.js'

async function manageSiteAuthorizationMiddleware(req, res, next) {
   try {
      void res
      await authorizePermissionService(
         req.auth.userId,
         'site.manage',
         {},
         req.app.locals.serviceDependencies.authorization,
      )
      next()
   } catch (error) {
      next(error)
   }
}

const imageContentTypes = ['image/jpeg', 'image/png']

// The image body is read only after authentication, permission, CSRF and rate checks passed.
function siteImageBodyMiddleware(req, res, next) {
   const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
   if (!imageContentTypes.includes(contentType)) {
      next(new AppError(415, 'SITE_IMAGE_TYPE_INVALID', 'Send the image as image/jpeg or image/png'))
      return
   }
   express.raw({ type: () => true, limit: maxImageBytes })(req, res, (error) => {
      if (error?.type === 'entity.too.large') {
         next(new AppError(413, 'SITE_IMAGE_TOO_LARGE', 'The image is larger than 5 MB'))
      } else if (error) {
         next(new AppError(400, 'SITE_IMAGE_UPLOAD_FAILED', 'The image could not be read'))
      } else {
         next()
      }
   })
}

export { manageSiteAuthorizationMiddleware, siteImageBodyMiddleware }
