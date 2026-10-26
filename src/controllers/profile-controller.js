import {
   completeOnboardingService,
   getOnboardingService,
   getOwnProfileService,
   updateOnboardingService,
   updateOwnProfileService,
} from '../services/profile-service.js'

async function getOwnProfileController(req, res, next) {
   try {
      const data = await getOwnProfileService(
         req.auth.userId,
         req.app.locals.serviceDependencies.profile,
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function updateOwnProfileController(req, res, next) {
   try {
      const data = await updateOwnProfileService(
         req.auth.userId,
         req.body,
         req.app.locals.serviceDependencies.profile,
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function getOnboardingController(req, res, next) {
   try {
      const data = await getOnboardingService(
         req.auth.userId,
         req.app.locals.serviceDependencies.profile,
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function updateOnboardingController(req, res, next) {
   try {
      const data = await updateOnboardingService(
         req.auth.userId,
         req.body,
         req.app.locals.serviceDependencies.profile,
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function completeOnboardingController(req, res, next) {
   try {
      const data = await completeOnboardingService(
         req.auth.userId,
         req.app.locals.serviceDependencies.profile,
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

export {
   completeOnboardingController,
   getOnboardingController,
   getOwnProfileController,
   updateOnboardingController,
   updateOwnProfileController,
}
