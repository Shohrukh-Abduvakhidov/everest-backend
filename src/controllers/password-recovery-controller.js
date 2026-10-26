import { passwordRecoveryService } from '../services/password-recovery-service.js'

function createPasswordRecoveryController(service = passwordRecoveryService) {
   async function requestPasswordRecoveryController(req, res, next) {
      try {
         res.status(202).json({ data: await service.request(req.body) })
      } catch (error) {
         next(error)
      }
   }

   async function verifyPasswordRecoveryController(req, res, next) {
      try {
         res.json({ data: await service.verify(req.body) })
      } catch (error) {
         next(error)
      }
   }

   async function resetPasswordController(req, res, next) {
      try {
         res.json({ data: await service.reset(req.body) })
      } catch (error) {
         next(error)
      }
   }

   return {
      requestPasswordRecoveryController,
      resetPasswordController,
      verifyPasswordRecoveryController,
   }
}

const {
   requestPasswordRecoveryController,
   resetPasswordController,
   verifyPasswordRecoveryController,
} = createPasswordRecoveryController()

export {
   createPasswordRecoveryController,
   requestPasswordRecoveryController,
   resetPasswordController,
   verifyPasswordRecoveryController,
}
