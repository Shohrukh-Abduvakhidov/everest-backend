import env from '../configs/env.js'
import {
   createSiteItemService,
   deleteSiteItemService,
   getSiteItemService,
   getSiteSettingsService,
   listSiteItemsService,
   publishSiteItemService,
   reorderSiteItemsService,
   unpublishSiteItemService,
   updateSiteItemService,
   updateSiteSettingsService,
   uploadSiteImageService,
} from '../services/site-content-service.js'
import {
   getPublicSiteCourseService,
   getPublicSiteImageService,
   getPublicSiteSettingsService,
   listPublicSiteItemsService,
} from '../services/site-public-service.js'

// Absolute image URLs use API_PUBLIC_URL, else this request's own origin.
function overrides(req) {
   const site = req.app.locals.serviceDependencies.site || {}
   return { ...site, baseUrl: site.baseUrl ?? env.apiPublicUrl ?? `${req.protocol}://${req.get('host')}` }
}

// Routes are registered per collection as /site/<collection>[/...]; the service checks the
// name against its allowlist.
function collectionOf(req) {
   return req.route.path.split('/')[2]
}

// Short shared cache; Express adds a weak ETag and answers If-None-Match with 304.
function setPublicCache(req, res) {
   const maxAge = req.app.locals.serviceDependencies.site?.cacheMaxAgeSeconds ?? env.siteCacheMaxAgeSeconds
   res.set('Cache-Control', `public, max-age=${maxAge}, stale-while-revalidate=${maxAge * 5}`)
}

async function listSiteItemsController(req, res, next) {
   try {
      const data = await listSiteItemsService(collectionOf(req), req.query, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function getSiteItemController(req, res, next) {
   try {
      const data = await getSiteItemService(collectionOf(req), req.params.itemId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function createSiteItemController(req, res, next) {
   try {
      const data = await createSiteItemService(req.auth.userId, collectionOf(req), req.body, overrides(req))
      res.status(201).json({ data })
   } catch (error) {
      next(error)
   }
}

async function updateSiteItemController(req, res, next) {
   try {
      const data = await updateSiteItemService(
         req.auth.userId,
         collectionOf(req),
         req.params.itemId,
         req.body,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function deleteSiteItemController(req, res, next) {
   try {
      const data = await deleteSiteItemService(req.auth.userId, collectionOf(req), req.params.itemId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function publishSiteItemController(req, res, next) {
   try {
      const data = await publishSiteItemService(req.auth.userId, collectionOf(req), req.params.itemId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function unpublishSiteItemController(req, res, next) {
   try {
      const data = await unpublishSiteItemService(req.auth.userId, collectionOf(req), req.params.itemId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function reorderSiteItemsController(req, res, next) {
   try {
      const data = await reorderSiteItemsService(req.auth.userId, collectionOf(req), req.body, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function getSiteSettingsController(req, res, next) {
   try {
      void req
      const data = await getSiteSettingsService(overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function updateSiteSettingsController(req, res, next) {
   try {
      const data = await updateSiteSettingsService(req.auth.userId, req.body, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function uploadSiteImageController(req, res, next) {
   try {
      const data = await uploadSiteImageService(req.auth.userId, {
         body: req.body,
         contentType: req.headers['content-type'],
         fileName: req.headers['x-file-name'],
      }, overrides(req))
      res.status(201).json({ data })
   } catch (error) {
      next(error)
   }
}

async function listPublicSiteItemsController(req, res, next) {
   try {
      const data = await listPublicSiteItemsService(collectionOf(req), req.query, overrides(req))
      setPublicCache(req, res)
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function getPublicSiteCourseController(req, res, next) {
   try {
      const data = await getPublicSiteCourseService(req.params.slug, req.query, overrides(req))
      setPublicCache(req, res)
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function getPublicSiteSettingsController(req, res, next) {
   try {
      const data = await getPublicSiteSettingsService(req.query, overrides(req))
      setPublicCache(req, res)
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function getPublicSiteImageController(req, res, next) {
   try {
      const { url, cacheSeconds } = await getPublicSiteImageService(req.params.assetId, overrides(req))
      res.set('Cache-Control', `public, max-age=${cacheSeconds}`)
      res.redirect(302, url)
   } catch (error) {
      next(error)
   }
}

export {
   createSiteItemController,
   deleteSiteItemController,
   getPublicSiteCourseController,
   getPublicSiteImageController,
   getPublicSiteSettingsController,
   getSiteItemController,
   getSiteSettingsController,
   listPublicSiteItemsController,
   listSiteItemsController,
   publishSiteItemController,
   reorderSiteItemsController,
   unpublishSiteItemController,
   updateSiteItemController,
   updateSiteSettingsController,
   uploadSiteImageController,
}
