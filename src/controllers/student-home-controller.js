import { getStudentHomeService, listStudentAttemptsService } from '../services/student-home-service.js'

function overrides(req) {
   return req.app.locals.serviceDependencies.studentHome
}

async function getStudentHomeController(req, res, next) {
   try {
      const data = await getStudentHomeService(req.auth.userId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function listStudentAttemptsController(req, res, next) {
   try {
      const data = await listStudentAttemptsService(req.auth.userId, req.query, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

export { getStudentHomeController, listStudentAttemptsController }
