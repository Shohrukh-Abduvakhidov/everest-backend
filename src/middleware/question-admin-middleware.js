import { authorizePermissionService } from '../services/authorization-service.js'

async function authorize(req, permissionCode) {
   await authorizePermissionService(
      req.auth.userId,
      permissionCode,
      undefined,
      req.app.locals.serviceDependencies.authorization,
   )
}

async function readTaxonomyAuthorizationMiddleware(req, res, next) {
   try {
      void res
      await authorize(req, 'taxonomy.read')
      next()
   } catch (error) {
      next(error)
   }
}

async function manageTaxonomyAuthorizationMiddleware(req, res, next) {
   try {
      void res
      await authorize(req, 'taxonomy.manage')
      next()
   } catch (error) {
      next(error)
   }
}

async function readQuestionsAuthorizationMiddleware(req, res, next) {
   try {
      void res
      await authorize(req, 'questions.read')
      next()
   } catch (error) {
      next(error)
   }
}

async function manageQuestionsAuthorizationMiddleware(req, res, next) {
   try {
      void res
      await authorize(req, 'questions.manage')
      next()
   } catch (error) {
      next(error)
   }
}

async function reviewQuestionsAuthorizationMiddleware(req, res, next) {
   try {
      void res
      await authorize(req, 'questions.review')
      next()
   } catch (error) {
      next(error)
   }
}

export {
   manageQuestionsAuthorizationMiddleware,
   manageTaxonomyAuthorizationMiddleware,
   readQuestionsAuthorizationMiddleware,
   readTaxonomyAuthorizationMiddleware,
   reviewQuestionsAuthorizationMiddleware,
}
