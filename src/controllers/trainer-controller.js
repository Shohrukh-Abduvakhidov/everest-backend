import {
   createTrainerAttemptService,
   getTrainerCatalogService,
   listTrainerHistoryService,
} from '../services/trainer-service.js'

function overrides(req) {
   return req.app.locals.serviceDependencies.testAttempts
}

async function getTrainerCatalogController(req, res, next) {
   try {
      const data = await getTrainerCatalogService(req.auth.userId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function createTrainerAttemptController(req, res, next) {
   try {
      const data = await createTrainerAttemptService(req.auth.userId, req.body, overrides(req))
      res.status(data.resumed ? 200 : 201).json({ data })
   } catch (error) {
      next(error)
   }
}

async function listTrainerHistoryController(req, res, next) {
   try {
      const data = await listTrainerHistoryService(req.auth.userId, req.query, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

export { createTrainerAttemptController, getTrainerCatalogController, listTrainerHistoryController }
