import cors from 'cors'
import express from 'express'

import env from './configs/env.js'
import { errorHandler, notFoundHandler } from './configs/error-handler.js'
import docsRouter from './routes/docs.js'
import router from './routes/index.js'

function createApp(serviceDependencies = {}) {
   const app = express()

   app.locals.serviceDependencies = serviceDependencies
   app.disable('x-powered-by')
   app.use(cors({ origin: env.corsOrigins, credentials: true }))
   app.use(express.json({ limit: '1mb' }))
   // Swagger UI is opt-in in production (SWAGGER_ENABLED) and never part of /api/v1.
   if (serviceDependencies.docs?.enabled ?? env.swaggerEnabled) app.use('/api/docs', docsRouter)
   app.use('/api/v1', router)
   app.use(notFoundHandler)
   app.use(errorHandler)

   return app
}

const app = createApp()

export { createApp }
export default app
