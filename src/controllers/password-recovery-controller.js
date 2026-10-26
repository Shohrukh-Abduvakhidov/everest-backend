import {
   requestPasswordRecoveryService,
   resetPasswordService,
   verifyPasswordRecoveryService,
} from '../services/password-recovery-service.js'

async function requestPasswordRecoveryController(req, res, next) {
   try {
      const data = await requestPasswordRecoveryService(
         req.body,
         req.app.locals.serviceDependencies.passwordRecovery,
      )

      res.status(202).json({ data })
   } catch (error) {
      next(error)
   }
}

async function verifyPasswordRecoveryController(req, res, next) {
   try {
      const data = await verifyPasswordRecoveryService(
         req.body,
         req.app.locals.serviceDependencies.passwordRecovery,
      )

      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function resetPasswordController(req, res, next) {
   try {
      const data = await resetPasswordService(
         req.body,
         req.app.locals.serviceDependencies.passwordRecovery,
      )

      res.json({ data })
   } catch (error) {
      next(error)
   }
}

export {
   requestPasswordRecoveryController,
   resetPasswordController,
   verifyPasswordRecoveryController,
}
