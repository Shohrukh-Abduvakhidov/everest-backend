import cors from 'cors'
import express from 'express'

import env from './configs/env.js'
import { errorHandler, notFoundHandler } from './configs/error-handler.js'
import router from './routes/index.js'

function createApp(serviceDependencies = {}) {
   const app = express()

   app.locals.serviceDependencies = serviceDependencies
   app.disable('x-powered-by')
   app.use(cors({ origin: env.corsOrigins, credentials: true }))
   app.use(express.json({ limit: '1mb' }))
   app.use('/api/v1', router)
   app.use(notFoundHandler)
   app.use(errorHandler)

   return app
}

const app = createApp()

export { createApp }
export default app
