// Integrity errors of PostgreSQL that reached the HTTP layer without a service turning them
// into an AppError. The client gets a stable code and a generic message; the SQL, the
// constraint and the table stay in the server log only.
const integrityResponses = {
   23502: { status: 400, code: 'VALIDATION_ERROR', message: 'Request validation failed' },
   23514: { status: 400, code: 'VALIDATION_ERROR', message: 'Request validation failed' },
   23505: { status: 409, code: 'CONFLICT', message: 'The record conflicts with an existing one' },
   23001: { status: 409, code: 'REFERENCE_IN_USE', message: 'The record is still in use' },
}

// A pg DatabaseError carries severity and routine; an error built elsewhere with the same code
// is not treated as one.
function isDatabaseError(error) {
   return Boolean(error) && typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)
      && typeof error.severity === 'string'
}

// 23503 is either a write that names a row which does not exist (400 REFERENCE_NOT_FOUND) or a
// delete/update of a row that other rows still use (409 REFERENCE_IN_USE). PostgreSQL tells the
// two apart only in its message, whose language follows lc_messages, so a DELETE request counts
// as the second case too.
function foreignKeyResponse(error, method) {
   const stillReferenced = /^update or delete on table/i.test(error.message || '')
      || /still referenced/i.test(error.detail || '')
      || method === 'DELETE'
   return stillReferenced
      ? { status: 409, code: 'REFERENCE_IN_USE', message: 'The record is still in use' }
      : { status: 400, code: 'REFERENCE_NOT_FOUND', message: 'A referenced record was not found' }
}

function describeDatabaseError(error, method = null) {
   if (!isDatabaseError(error)) return null
   if (error.code === '23503') return foreignKeyResponse(error, method)
   return integrityResponses[error.code] || null
}

// What the log keeps: names of the violated constraint, table and column, never values.
function databaseErrorLog(error) {
   return {
      code: error.code,
      constraint: error.constraint ?? null,
      table: error.table ?? null,
      column: error.column ?? null,
   }
}

export { databaseErrorLog, describeDatabaseError, isDatabaseError }
