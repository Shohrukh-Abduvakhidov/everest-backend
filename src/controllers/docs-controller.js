import { createRequire } from 'node:module'
import path from 'node:path'

import { buildOpenApiDocument } from '../docs/openapi.js'

// Resolve the package directory without importing its browser bundle into Node.
const swaggerUiDirectory = path.dirname(createRequire(import.meta.url).resolve('swagger-ui-dist/package.json'))
const swaggerAssets = Object.freeze({
   'swagger-ui.css': 'text/css; charset=utf-8',
   'swagger-ui-bundle.js': 'text/javascript; charset=utf-8',
   'favicon-32x32.png': 'image/png',
})

// Scripts load only from this origin; Swagger UI needs inline styles and data: images.
const contentSecurityPolicy = [
   "default-src 'self'",
   "script-src 'self'",
   "style-src 'self' 'unsafe-inline'",
   "img-src 'self' data:",
   "connect-src 'self'",
   "frame-ancestors 'none'",
   "base-uri 'none'",
   "form-action 'none'",
].join('; ')

const page = `<!doctype html>
<html lang="en">
<head>
   <meta charset="utf-8">
   <meta name="viewport" content="width=device-width, initial-scale=1">
   <title>EVEREST API</title>
   <link rel="icon" type="image/png" href="/api/docs/assets/favicon-32x32.png">
   <link rel="stylesheet" href="/api/docs/assets/swagger-ui.css">
</head>
<body>
   <div id="swagger-ui"></div>
   <script src="/api/docs/assets/swagger-ui-bundle.js"></script>
   <script src="/api/docs/swagger-initializer.js"></script>
</body>
</html>
`

// Cookie sessions need X-CSRF-Token on mutations; the page copies it from the readable
// everest_csrf cookie. The browser itself sends Origin and the HttpOnly access cookie.
const initializer = `window.addEventListener('load', function () {
   function readCookie(name) {
      var parts = document.cookie ? document.cookie.split(';') : []
      for (var index = 0; index < parts.length; index += 1) {
         var part = parts[index].trim()
         if (part.indexOf(name + '=') === 0) return decodeURIComponent(part.slice(name.length + 1))
      }
      return null
   }
   window.ui = SwaggerUIBundle({
      url: '/api/docs/openapi.json',
      dom_id: '#swagger-ui',
      deepLinking: true,
      persistAuthorization: false,
      withCredentials: true,
      presets: [SwaggerUIBundle.presets.apis],
      layout: 'BaseLayout',
      requestInterceptor: function (request) {
         var method = String(request.method || 'GET').toUpperCase()
         if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
            var token = readCookie('everest_csrf')
            if (token && !request.headers['X-CSRF-Token']) request.headers['X-CSRF-Token'] = token
         }
         return request
      },
   })
})
`

let cachedDocument

function docsHeaders(res) {
   res.set('Content-Security-Policy', contentSecurityPolicy)
   res.set('X-Content-Type-Options', 'nosniff')
   res.set('Referrer-Policy', 'no-referrer')
}

async function getDocsPageController(req, res, next) {
   try {
      void req
      docsHeaders(res)
      res.type('html').send(page)
   } catch (error) {
      next(error)
   }
}

async function getDocsInitializerController(req, res, next) {
   try {
      void req
      docsHeaders(res)
      res.type('text/javascript').send(initializer)
   } catch (error) {
      next(error)
   }
}

async function getOpenApiDocumentController(req, res, next) {
   try {
      void req
      cachedDocument ||= buildOpenApiDocument()
      res.set('Cache-Control', 'no-store')
      res.json(cachedDocument)
   } catch (error) {
      next(error)
   }
}

async function getDocsAssetController(req, res, next) {
   try {
      const contentType = swaggerAssets[req.params.fileName]
      if (!contentType) {
         res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found', details: [] } })
         return
      }
      docsHeaders(res)
      res.type(contentType)
      res.sendFile(path.join(swaggerUiDirectory, req.params.fileName), { maxAge: '1h' }, (error) => {
         if (error) next(error)
      })
   } catch (error) {
      next(error)
   }
}

export {
   getDocsAssetController,
   getDocsInitializerController,
   getDocsPageController,
   getOpenApiDocumentController,
}
