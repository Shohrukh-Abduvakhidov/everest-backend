import { databaseErrorLog, describeDatabaseError } from '../utils/database-error.js'

function notFoundHandler(_request, response) {
   response.status(404).json({
      error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found', details: [] },
   })
}

// Method and path without the query string, so the log shows which route failed.
function requestLog(request) {
   return {
      method: request?.method ?? null,
      path: typeof request?.originalUrl === 'string' ? request.originalUrl.split('?')[0] : null,
   }
}

function errorHandler(error, request, response, _next) {
   const status = Number.isInteger(error.status) ? error.status : 500
   const isExpected = error.name === 'AppError'
   const database = isExpected ? null : describeDatabaseError(error, request?.method)

   if (database) {
      console.error('Database constraint violation', { ...databaseErrorLog(error), ...requestLog(request) })
      response.status(database.status).json({
         error: { code: database.code, message: database.message, details: [] },
      })
      return
   }

   if (!isExpected) {
      console.error('Unhandled request error', {
         code: error.code,
         ...(error.constraint ? { constraint: error.constraint } : {}),
         ...requestLog(request),
      })
   }

   if (isExpected && status === 429 && Number.isInteger(error.retryAfter)) {
      response.set('Retry-After', String(error.retryAfter))
   }

   response.status(isExpected ? status : 500).json({
      error: {
         code: isExpected ? error.code : 'INTERNAL_ERROR',
         message: isExpected ? error.message : 'Internal server error',
         details: isExpected && Array.isArray(error.details) ? error.details : [],
      },
   })
}

export { errorHandler, notFoundHandler }
