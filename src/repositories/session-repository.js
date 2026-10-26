import pool from '../configs/db.js'
import { normalizeInternalId } from '../utils/internal-id.js'

async function createRefreshToken({ sessionId, tokenHash, expiresAt }, client) {
   const result = await client.query(
      `INSERT INTO auth_refresh_tokens (session_id, token_hash, expires_at)
     VALUES ($1, $2, $3) RETURNING id`,
      [normalizeInternalId(sessionId), tokenHash, expiresAt],
   )
   return result.rows[0]
}

async function findRefreshTokenForUpdate(tokenHash, client) {
   const result = await client.query(
      `SELECT token.id AS token_id, token.session_id, token.expires_at AS token_expires_at,
       token.used_at, token.revoked_at AS token_revoked_at,
       session.user_id, session.expires_at AS session_expires_at,
       session.revoked_at AS session_revoked_at, account.status
     FROM auth_refresh_tokens AS token
     JOIN auth_sessions AS session ON session.id = token.session_id
     JOIN users AS account ON account.id = session.user_id
     WHERE token.token_hash = $1
     FOR UPDATE OF token, session, account`,
      [tokenHash],
   )
   return result.rows[0] || null
}

async function markRefreshTokenUsed(tokenId, client) {
   await client.query('UPDATE auth_refresh_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = $1', [
      normalizeInternalId(tokenId),
   ])
}

async function lockOwnedSession(userId, sessionId, client) {
   const result = await client.query(
      `SELECT id, user_id, created_at, last_used_at, expires_at, revoked_at,
       revoke_reason, user_agent
     FROM auth_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [normalizeInternalId(sessionId), normalizeInternalId(userId)],
   )
   return result.rows[0] || null
}

async function revokeSession(sessionId, reason, client) {
   const result = await client.query(
      `UPDATE auth_sessions
     SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
       revoke_reason = COALESCE(revoke_reason, $2)
     WHERE id = $1 RETURNING id, revoked_at`,
      [normalizeInternalId(sessionId), reason],
   )
   return result.rows[0] || null
}

async function revokeSessionRefreshTokens(sessionId, client) {
   const result = await client.query(
      `UPDATE auth_refresh_tokens SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
     WHERE session_id = $1 AND revoked_at IS NULL`,
      [normalizeInternalId(sessionId)],
   )
   return result.rowCount
}

async function revokeAllUserSessions(userId, reason, client) {
   const normalized = normalizeInternalId(userId)
   const sessions = await client.query(
      `UPDATE auth_sessions
     SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP),
       revoke_reason = COALESCE(revoke_reason, $2)
     WHERE user_id = $1 AND revoked_at IS NULL
     RETURNING id`,
      [normalized, reason],
   )
   const tokens = await client.query(
      `UPDATE auth_refresh_tokens AS token SET revoked_at = COALESCE(token.revoked_at, CURRENT_TIMESTAMP)
     FROM auth_sessions AS session
     WHERE token.session_id = session.id AND session.user_id = $1
       AND token.revoked_at IS NULL`,
      [normalized],
   )
   return { sessions: sessions.rowCount, refreshTokens: tokens.rowCount }
}

async function listUserSessions(userId, db = pool) {
   const result = await db.query(
      `SELECT id, created_at, last_used_at, expires_at, revoked_at, user_agent
     FROM auth_sessions WHERE user_id = $1 ORDER BY created_at DESC, id DESC`,
      [normalizeInternalId(userId)],
   )
   return result.rows
}

async function touchSessionLastUsed(sessionId, db = pool) {
   await db.query(
      `UPDATE auth_sessions SET last_used_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < CURRENT_TIMESTAMP - INTERVAL '60 seconds')`,
      [normalizeInternalId(sessionId)],
   )
}

async function touchSessionLastUsedNow(sessionId, client) {
   await client.query('UPDATE auth_sessions SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1', [
      normalizeInternalId(sessionId),
   ])
}

export {
   createRefreshToken,
   findRefreshTokenForUpdate,
   listUserSessions,
   lockOwnedSession,
   markRefreshTokenUsed,
   revokeAllUserSessions,
   revokeSession,
   revokeSessionRefreshTokens,
   touchSessionLastUsed,
   touchSessionLastUsedNow,
}
