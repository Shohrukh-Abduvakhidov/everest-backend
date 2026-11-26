import {
   getMyAchievementsService,
   getStaffStudentAchievementsService,
   markAchievementsSeenService,
} from '../services/achievement-service.js'

function overrides(req) {
   return req.app.locals.serviceDependencies.achievements
}

async function getMyAchievementsController(req, res, next) {
   try {
      const data = await getMyAchievementsService(req.auth.userId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function markAchievementsSeenController(req, res, next) {
   try {
      const data = await markAchievementsSeenService(req.auth.userId, req.body, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function getStaffStudentAchievementsController(req, res, next) {
   try {
      const data = await getStaffStudentAchievementsService(req.auth.userId, req.params.userId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

export {
   getMyAchievementsController,
   getStaffStudentAchievementsController,
   markAchievementsSeenController,
}
