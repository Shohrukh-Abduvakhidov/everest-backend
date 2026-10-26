function notFoundHandler(_request, response) {
   response.status(404).json({
      error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found', details: [] },
   })
}

function errorHandler(error, _request, response, _next) {
   const status = Number.isInteger(error.status) ? error.status : 500
   const isExpected = error.name === 'AppError'

   if (!isExpected) {
      console.error('Unhandled request error', { code: error.code })
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
