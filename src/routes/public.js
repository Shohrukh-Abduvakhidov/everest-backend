import express from 'express'

import {
   getPublicSiteCourseController,
   getPublicSiteImageController,
   getPublicSiteSettingsController,
   listPublicSiteItemsController,
} from '../controllers/site-controller.js'

// Unauthenticated reads for the marketing site. Responses are small, cached by the frontend
// and by Cache-Control/ETag, so no database-backed rate limit is applied.
const publicRouter = express.Router()

publicRouter.get('/site/settings', getPublicSiteSettingsController)
publicRouter.get('/site/courses', listPublicSiteItemsController)
publicRouter.get('/site/courses/:slug', getPublicSiteCourseController)
publicRouter.get('/site/vacancies', listPublicSiteItemsController)
publicRouter.get('/site/events', listPublicSiteItemsController)
publicRouter.get('/site/videos', listPublicSiteItemsController)
publicRouter.get('/site/images/:assetId', getPublicSiteImageController)

export default publicRouter
