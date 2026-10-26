import * as healthService from '../services/health-service.js'

async function getLivenessController(req, res, next) {
   try {
      void req
      res.json({ data: { status: 'ok' } })
   } catch (error) {
      next(error)
   }
}

async function getReadinessController(req, res, next) {
   try {
      void req
      const readiness = await healthService.getReadinessService()
      res.json({ data: readiness })
   } catch (error) {
      next(error)
   }
}

export { getLivenessController, getReadinessController }
