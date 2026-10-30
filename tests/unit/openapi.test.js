import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { Validator } from '@seriousme/openapi-schema-validator'

import { createApp } from '../../src/app.js'
import { buildOpenApiDocument, documentedRoutes } from '../../src/docs/openapi.js'
import router, { routeMounts } from '../../src/routes/index.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function routesOf(expressRouter, prefix = '') {
   return expressRouter.stack
      .filter((layer) => layer.route)
      .flatMap((layer) => Object.keys(layer.route.methods).map((method) => {
         const routePath = `${prefix}${layer.route.path === '/' ? '' : layer.route.path}`
         return `${method.toUpperCase()} ${routePath || '/'}`
      }))
}

function registeredRoutes() {
   return [
      ...routesOf(router),
      ...routeMounts.flatMap(([mountPath, mounted]) => routesOf(mounted, mountPath)),
   ].sort()
}

async function sourceFiles(directory) {
   const entries = await readdir(directory, { withFileTypes: true })
   const nested = await Promise.all(entries.map(async (entry) => {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) return entry.name === 'docs' ? [] : sourceFiles(full)
      return full.endsWith('.js') ? [full] : []
   }))
   return nested.flat()
}

test('OpenAPI document is valid OpenAPI 3.1', async () => {
   const document = buildOpenApiDocument()
   const validator = new Validator()
   const result = await validator.validate(document)
   assert.equal(result.valid, true, JSON.stringify(result.errors, null, 2))
   assert.equal(validator.version, '3.1')
})

test('every registered Express route is documented and nothing else is', () => {
   const registered = registeredRoutes()
   const documented = [...documentedRoutes].sort()
   assert.equal(new Set(documented).size, documented.length, 'duplicate documented route')
   assert.deepEqual(
      registered.filter((route) => !documented.includes(route)),
      [],
      'routes missing from src/docs/openapi.js',
   )
   assert.deepEqual(
      documented.filter((route) => !registered.includes(route)),
      [],
      'documented routes that Express does not register',
   )
})

test('operations declare security, unique ids and the shared error envelope', () => {
   const document = buildOpenApiDocument()
   const operationIds = new Set()
   for (const [routePath, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(item)) {
         const label = `${method.toUpperCase()} ${routePath}`
         assert.ok(Array.isArray(operation.security), `${label} has no security`)
         assert.equal(operationIds.has(operation.operationId), false, `${label} duplicates an operationId`)
         operationIds.add(operation.operationId)
         const success = Object.keys(operation.responses).filter((status) => Number(status) < 400)
         assert.equal(success.length, 1, `${label} needs exactly one success response`)
         for (const [status, response] of Object.entries(operation.responses)) {
            if (Number(status) < 400) continue
            assert.equal(
               response.content['application/json'].schema.$ref,
               '#/components/schemas/ErrorResponse',
               `${label} ${status}`,
            )
         }
         if (operation.security.length && method !== 'get') {
            assert.ok(
               operation.parameters?.some((parameter) => parameter.$ref === '#/components/parameters/CsrfToken'),
               `${label} must document X-CSRF-Token`,
            )
         }
      }
   }
})

// Codes built from a template in taxonomy-service (`${labels[kind].code}_NOT_FOUND`, ...).
const templatedCodes = /^(INVALID_(SUBJECT|SECTION|TOPIC)_ID|(SUBJECT|SECTION|TOPIC)_(NOT_FOUND|CODE_CONFLICT|IN_USE))$/

test('every documented error code exists in the source', async () => {
   const source = (await Promise.all(
      (await sourceFiles(path.join(projectRoot, 'src'))).map((file) => readFile(file, 'utf8')),
   )).join('\n')
   const missing = new Set()
   for (const item of Object.values(buildOpenApiDocument().paths)) {
      for (const operation of Object.values(item)) {
         for (const [status, response] of Object.entries(operation.responses)) {
            if (Number(status) < 400) continue
            for (const entry of response.description.split(', ')) {
               const code = entry.split(' ')[0]
               if (!templatedCodes.test(code) && !new RegExp(`['\`]${code}['\`]`).test(source)) missing.add(code)
            }
         }
      }
   }
   assert.deepEqual([...missing], [])
})

test('owner bootstrap script imports an existing service export', async () => {
   const script = await readFile(path.join(projectRoot, 'scripts/bootstrap-owner.js'), 'utf8')
   const service = await import('../../src/services/account-admin-service.js')
   const imported = script.match(/import \{ ([A-Za-z]+) \} from '..\/src\/services\/account-admin-service.js'/)
   assert.ok(imported, 'bootstrap script must import from account-admin-service')
   assert.equal(typeof service[imported[1]], 'function')
})

async function listen(app) {
   return new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
   })
}

test('Swagger UI is served only when enabled', async (t) => {
   const enabled = await listen(createApp({ docs: { enabled: true } }))
   const disabled = await listen(createApp({ docs: { enabled: false } }))
   t.after(async () => {
      await new Promise((resolve) => enabled.close(resolve))
      await new Promise((resolve) => disabled.close(resolve))
   })
   const base = `http://127.0.0.1:${enabled.address().port}/api/docs`

   const page = await fetch(base)
   assert.equal(page.status, 200)
   assert.match(page.headers.get('content-type'), /text\/html/)
   assert.match(page.headers.get('content-security-policy'), /script-src 'self'/)
   assert.doesNotMatch(await page.text(), /<script>(?!<)/)

   const specResponse = await fetch(`${base}/openapi.json`)
   assert.equal(specResponse.status, 200)
   const spec = await specResponse.json()
   assert.equal(spec.openapi, '3.1.0')
   assert.deepEqual(spec.servers, [{ url: '/api/v1' }])

   const initializer = await fetch(`${base}/swagger-initializer.js`)
   assert.equal(initializer.status, 200)
   assert.match(await initializer.text(), /everest_csrf/)

   const asset = await fetch(`${base}/assets/swagger-ui-bundle.js`)
   assert.equal(asset.status, 200)
   await asset.arrayBuffer()
   for (const name of ['index.html', 'swagger-initializer.js', '..%2Fpackage.json']) {
      const blocked = await fetch(`${base}/assets/${name}`)
      assert.equal(blocked.status, 404, name)
      await blocked.arrayBuffer()
   }

   const off = await fetch(`http://127.0.0.1:${disabled.address().port}/api/docs/openapi.json`)
   assert.equal(off.status, 404)
   assert.equal((await off.json()).error.code, 'ROUTE_NOT_FOUND')
})
