import express from 'express'

import {
   getDocsAssetController,
   getDocsInitializerController,
   getDocsPageController,
   getOpenApiDocumentController,
} from '../controllers/docs-controller.js'

const docsRouter = express.Router()

docsRouter.get('/', getDocsPageController)
docsRouter.get('/openapi.json', getOpenApiDocumentController)
docsRouter.get('/swagger-initializer.js', getDocsInitializerController)
docsRouter.get('/assets/:fileName', getDocsAssetController)

export default docsRouter
