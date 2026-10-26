import pool from '../configs/db.js'

async function consumeCounter({ scope, keyHash, limit, windowSeconds, blockSeconds }, db = pool) {
   const result = await db.query(
      `INSERT INTO auth_security_counters
         (scope, key_hash, window_started_at, attempt_count, blocked_until)
       VALUES ($1, $2, CURRENT_TIMESTAMP, 1, NULL)
       ON CONFLICT (scope, key_hash) DO UPDATE SET
         window_started_at = CASE
           WHEN auth_security_counters.window_started_at <= CURRENT_TIMESTAMP - make_interval(secs => $4)
             THEN CURRENT_TIMESTAMP ELSE auth_security_counters.window_started_at END,
         attempt_count = CASE
           WHEN auth_security_counters.window_started_at <= CURRENT_TIMESTAMP - make_interval(secs => $4)
             THEN 1 ELSE auth_security_counters.attempt_count + 1 END,
         blocked_until = CASE
           WHEN auth_security_counters.blocked_until > CURRENT_TIMESTAMP
             THEN auth_security_counters.blocked_until
           WHEN (CASE
             WHEN auth_security_counters.window_started_at <= CURRENT_TIMESTAMP - make_interval(secs => $4)
               THEN 1 ELSE auth_security_counters.attempt_count + 1 END) > $3
             THEN CURRENT_TIMESTAMP + make_interval(secs => $5)
           ELSE NULL END,
         updated_at = CURRENT_TIMESTAMP
       RETURNING attempt_count, blocked_until,
         GREATEST(1, CEIL(EXTRACT(EPOCH FROM (blocked_until - CURRENT_TIMESTAMP))))::integer
           AS retry_after_seconds`,
      [scope, keyHash, limit, windowSeconds, blockSeconds],
   )

   return result.rows[0]
}

async function clearCounter(scope, keyHash, db = pool) {
   await db.query('DELETE FROM auth_security_counters WHERE scope = $1 AND key_hash = $2', [
      scope,
      keyHash,
   ])
}

async function findSessionCsrfHash(sessionId, db = pool) {
   const result = await db.query(
      `SELECT csrf_token_hash FROM auth_sessions
       WHERE id = $1 AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP`,
      [sessionId],
   )
   return result.rows[0]?.csrf_token_hash || null
}

async function findRefreshSessionCsrfHash(tokenHash, db = pool) {
   const result = await db.query(
      `SELECT session.csrf_token_hash
       FROM auth_refresh_tokens AS token
       JOIN auth_sessions AS session ON session.id = token.session_id
       WHERE token.token_hash = $1 AND token.revoked_at IS NULL
         AND token.expires_at > CURRENT_TIMESTAMP
         AND session.revoked_at IS NULL AND session.expires_at > CURRENT_TIMESTAMP`,
      [tokenHash],
   )
   return result.rows[0]?.csrf_token_hash || null
}

export { clearCounter, consumeCounter, findRefreshSessionCsrfHash, findSessionCsrfHash }
