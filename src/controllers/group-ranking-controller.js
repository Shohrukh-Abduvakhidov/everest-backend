import {
   getGroupRankingService,
   getRankingSettingsService,
   getStaffGroupRankingService,
   updateRankingSettingsService,
} from '../services/group-ranking-service.js'

async function getGroupRankingController(req, res, next) {
   try {
      const data = await getGroupRankingService(
         req.auth.userId,
         req.params.groupId,
         req.query,
         req.app.locals.serviceDependencies.groupRanking,
      )

      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function getStaffGroupRankingController(req, res, next) {
   try {
      const data = await getStaffGroupRankingService(
         req.auth.userId,
         req.params.groupId,
         req.query,
         req.app.locals.serviceDependencies.groupRanking,
      )

      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function getRankingSettingsController(req, res, next) {
   try {
      const data = await getRankingSettingsService(
         req.auth.userId,
         req.params.groupId,
         req.app.locals.serviceDependencies.groupRanking,
      )

      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function updateRankingSettingsController(req, res, next) {
   try {
      const data = await updateRankingSettingsService(
         req.auth.userId,
         req.params.groupId,
         req.body,
         req.app.locals.serviceDependencies.groupRanking,
      )

      res.json({ data })
   } catch (error) {
      next(error)
   }
}

export {
   getGroupRankingController,
   getRankingSettingsController,
   getStaffGroupRankingController,
   updateRankingSettingsController,
}
