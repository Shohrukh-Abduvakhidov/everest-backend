import {
   getQuestionImportService,
   listQuestionImportErrorsService,
   listQuestionImportsService,
} from '../services/question-import-service.js'

function overrides(req) {
   return req.app.locals.serviceDependencies.questionImports
}

async function listQuestionImportsController(req, res, next) {
   try {
      const data = await listQuestionImportsService(req.auth.userId, req.query, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function getQuestionImportController(req, res, next) {
   try {
      const data = await getQuestionImportService(req.auth.userId, req.params.importId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function listQuestionImportErrorsController(req, res, next) {
   try {
      const data = await listQuestionImportErrorsService(
         req.auth.userId,
         req.params.importId,
         req.query,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

export {
   getQuestionImportController,
   listQuestionImportErrorsController,
   listQuestionImportsController,
}
