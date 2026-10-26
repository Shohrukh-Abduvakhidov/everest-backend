import express from 'express'

import {
   completeOnboardingController,
   getOnboardingController,
   getOwnProfileController,
   updateOnboardingController,
   updateOwnProfileController,
} from '../controllers/profile-controller.js'
import { authMiddleware } from '../middleware/auth-middleware.js'
import { authenticatedCsrfMiddleware } from '../middleware/auth-protection-middleware.js'

const profileRouter = express.Router()

profileRouter.use(authMiddleware)
profileRouter.get('/', getOwnProfileController)
profileRouter.patch('/', authenticatedCsrfMiddleware, updateOwnProfileController)
profileRouter.get('/onboarding', getOnboardingController)
profileRouter.patch('/onboarding', authenticatedCsrfMiddleware, updateOnboardingController)
profileRouter.post(
   '/onboarding/complete',
   authenticatedCsrfMiddleware,
   completeOnboardingController,
)

export default profileRouter
