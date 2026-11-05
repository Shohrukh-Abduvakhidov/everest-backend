import {
   confirmQuestionPackageUploadService,
   getQuestionPackageUploadService,
   uploadQuestionPackageService,
} from '../services/question-import-upload-service.js'
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

async function uploadQuestionPackageController(req, res, next) {
   try {
      const data = await uploadQuestionPackageService(req.auth.userId, req.body, req.query, overrides(req))
      res.status(data.duplicate ? 200 : 201).json({ data })
   } catch (error) {
      next(error)
   }
}

async function getQuestionPackageUploadController(req, res, next) {
   try {
      const data = await getQuestionPackageUploadService(req.auth.userId, req.params.uploadId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function confirmQuestionPackageUploadController(req, res, next) {
   try {
      const data = await confirmQuestionPackageUploadService(
         req.auth.userId,
         req.params.uploadId,
         req.body,
         overrides(req),
      )
      res.status(202).json({ data })
   } catch (error) {
      next(error)
   }
}

export {
   confirmQuestionPackageUploadController,
   getQuestionPackageUploadController,
   uploadQuestionPackageController,
   getQuestionImportController,
   listQuestionImportErrorsController,
   listQuestionImportsController,
}
