import { authorizePermissionService } from '../services/authorization-service.js'

async function authorize(req, permissionCode) {
   await authorizePermissionService(
      req.auth.userId,
      permissionCode,
      undefined,
      req.app.locals.serviceDependencies.authorization,
   )
}

async function readTestsAuthorizationMiddleware(req, res, next) {
   try {
      void res
      await authorize(req, 'tests.read')
      next()
   } catch (error) {
      next(error)
   }
}

async function manageTestsAuthorizationMiddleware(req, res, next) {
   try {
      void res
      await authorize(req, 'tests.manage')
      next()
   } catch (error) {
      next(error)
   }
}

async function publishTestsAuthorizationMiddleware(req, res, next) {
   try {
      void res
      await authorize(req, 'tests.publish')
      next()
   } catch (error) {
      next(error)
   }
}

async function assignTestsAuthorizationMiddleware(req, res, next) {
   try {
      void res
      await authorize(req, 'tests.assign')
      next()
   } catch (error) {
      next(error)
   }
}

async function readTestResultsAuthorizationMiddleware(req, res, next) {
   try {
      void res
      await authorize(req, 'tests.results.read')
      next()
   } catch (error) {
      next(error)
   }
}

async function regradeTestResultsAuthorizationMiddleware(req, res, next) {
   try {
      void res
      await authorize(req, 'tests.results.regrade')
      next()
   } catch (error) {
      next(error)
   }
}

async function grantAttemptsAuthorizationMiddleware(req, res, next) {
   try {
      void res
      await authorize(req, 'tests.attempts.grant')
      next()
   } catch (error) {
      next(error)
   }
}

export {
   assignTestsAuthorizationMiddleware,
   grantAttemptsAuthorizationMiddleware,
   manageTestsAuthorizationMiddleware,
   publishTestsAuthorizationMiddleware,
   readTestResultsAuthorizationMiddleware,
   readTestsAuthorizationMiddleware,
   regradeTestResultsAuthorizationMiddleware,
}
