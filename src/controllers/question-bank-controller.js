import {
   archiveQuestionService,
   copyQuestionService,
   createQuestionBankService,
   createQuestionService,
   deleteQuestionService,
   getQuestionBankService,
   getQuestionService,
   listBankQuestionsService,
   listQuestionBanksService,
   publishQuestionService,
   replaceAnswerKeyService,
   updateQuestionBankService,
   updateQuestionService,
   verifyAnswerKeyService,
} from '../services/question-bank-service.js'

function overrides(req) {
   return req.app.locals.serviceDependencies.questions
}

async function listQuestionBanksController(req, res, next) {
   try {
      const data = await listQuestionBanksService(req.auth.userId, req.query, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function getQuestionBankController(req, res, next) {
   try {
      const data = await getQuestionBankService(req.auth.userId, req.params.bankId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function createQuestionBankController(req, res, next) {
   try {
      const data = await createQuestionBankService(req.auth.userId, req.body, overrides(req))
      res.status(201).json({ data })
   } catch (error) {
      next(error)
   }
}

async function updateQuestionBankController(req, res, next) {
   try {
      const data = await updateQuestionBankService(
         req.auth.userId,
         req.params.bankId,
         req.body,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function listBankQuestionsController(req, res, next) {
   try {
      const data = await listBankQuestionsService(
         req.auth.userId,
         req.params.bankId,
         req.query,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function createQuestionController(req, res, next) {
   try {
      const data = await createQuestionService(
         req.auth.userId,
         req.params.bankId,
         req.body,
         overrides(req),
      )
      res.status(201).json({ data })
   } catch (error) {
      next(error)
   }
}

async function getQuestionController(req, res, next) {
   try {
      const data = await getQuestionService(req.auth.userId, req.params.questionId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function updateQuestionController(req, res, next) {
   try {
      const data = await updateQuestionService(
         req.auth.userId,
         req.params.questionId,
         req.body,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function deleteQuestionController(req, res, next) {
   try {
      const data = await deleteQuestionService(req.auth.userId, req.params.questionId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function copyQuestionController(req, res, next) {
   try {
      const data = await copyQuestionService(req.auth.userId, req.params.questionId, overrides(req))
      res.status(201).json({ data })
   } catch (error) {
      next(error)
   }
}

async function replaceAnswerKeyController(req, res, next) {
   try {
      const data = await replaceAnswerKeyService(
         req.auth.userId,
         req.params.questionId,
         req.body,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function verifyAnswerKeyController(req, res, next) {
   try {
      const data = await verifyAnswerKeyService(
         req.auth.userId,
         req.params.questionId,
         req.body,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function publishQuestionController(req, res, next) {
   try {
      const data = await publishQuestionService(req.auth.userId, req.params.questionId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function archiveQuestionController(req, res, next) {
   try {
      const data = await archiveQuestionService(req.auth.userId, req.params.questionId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

export {
   archiveQuestionController,
   copyQuestionController,
   createQuestionBankController,
   createQuestionController,
   deleteQuestionController,
   getQuestionBankController,
   getQuestionController,
   listBankQuestionsController,
   listQuestionBanksController,
   publishQuestionController,
   replaceAnswerKeyController,
   updateQuestionBankController,
   updateQuestionController,
   verifyAnswerKeyController,
}
