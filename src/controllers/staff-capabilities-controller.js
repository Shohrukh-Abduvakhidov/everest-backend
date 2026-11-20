import { getStaffCapabilitiesService } from '../services/staff-capabilities-service.js'

async function getStaffCapabilitiesController(req, res, next) {
   try {
      const overrides = req.app.locals.serviceDependencies.staffCapabilities
      const data = await getStaffCapabilitiesService(req.auth.userId, overrides)
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

export { getStaffCapabilitiesController }
