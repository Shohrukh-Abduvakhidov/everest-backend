import pool from '../configs/db.js';

async function createTelegramOidcState(state, db = pool) {
  await db.query(
    `INSERT INTO telegram_oidc_states
      (id, state_hash, nonce_hash, code_verifier_ciphertext, intent,
       initiating_user_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [state.id, state.stateHash, state.nonceHash, state.codeVerifierCiphertext,
      state.intent, state.initiatingUserId, state.expiresAt]
  );
}

async function consumeTelegramOidcState(stateHash, db = pool) {
  const result = await db.query(
    `UPDATE telegram_oidc_states
     SET consumed_at = CURRENT_TIMESTAMP
     WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP
     RETURNING id, nonce_hash, code_verifier_ciphertext, intent,
       initiating_user_id, expires_at`,
    [stateHash]
  );
  return result.rows[0] || null;
}

async function findTelegramIdentityForUpdate(issuer, subject, client) {
  const result = await client.query(
    `SELECT identity.id, identity.user_id, account.status,
       account.onboarding_completed_at
     FROM auth_identities AS identity
     JOIN users AS account ON account.id = identity.user_id
     WHERE identity.provider = 'telegram'
       AND identity.issuer = $1 AND identity.provider_subject = $2
     FOR UPDATE OF identity, account`,
    [issuer, subject]
  );
  return result.rows[0] || null;
}

async function findUserTelegramIdentityForUpdate(userId, issuer, client) {
  const result = await client.query(
    `SELECT id, user_id, provider_subject
     FROM auth_identities
     WHERE user_id = $1 AND provider = 'telegram' AND issuer = $2
     FOR UPDATE`,
    [userId, issuer]
  );
  return result.rows[0] || null;
}

async function createTelegramIdentity(identity, client) {
  const result = await client.query(
    `INSERT INTO auth_identities
      (id, user_id, provider, issuer, provider_subject, provider_profile)
     VALUES ($1, $2, 'telegram', $3, $4, $5)
     RETURNING id, user_id`,
    [identity.id, identity.userId, identity.issuer, identity.subject, identity.profile]
  );
  return result.rows[0];
}

async function touchTelegramIdentity(identityId, profile, client) {
  await client.query(
    `UPDATE auth_identities
     SET provider_profile = $2, last_used_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [identityId, profile]
  );
}

async function createSession(session, client) {
  await client.query(
    `INSERT INTO auth_sessions
      (id, user_id, expires_at, user_agent, ip_address)
     VALUES ($1, $2, $3, $4, $5)`,
    [session.id, session.userId, session.expiresAt, session.userAgent, session.ipAddress]
  );
}

async function findLiveSession(userId, sessionId, db = pool) {
  const result = await db.query(
    `SELECT session.id, session.user_id, account.status,
       account.onboarding_completed_at, session.expires_at
     FROM auth_sessions AS session
     JOIN users AS account ON account.id = session.user_id
     WHERE session.id = $1 AND session.user_id = $2
       AND session.revoked_at IS NULL
       AND session.expires_at > CURRENT_TIMESTAMP`,
    [sessionId, userId]
  );
  return result.rows[0] || null;
}

async function upsertTelegramConnection(connection, client) {
  const result = await client.query(
    `INSERT INTO telegram_connections
      (id, user_id, bot_id, chat_id, status)
     VALUES ($1, $2, $3, $4, 'active')
     ON CONFLICT (user_id, bot_id) DO UPDATE
       SET chat_id = EXCLUDED.chat_id,
           status = 'active',
           connected_at = CURRENT_TIMESTAMP,
           blocked_at = NULL
     RETURNING id, status`,
    [connection.id, connection.userId, connection.botId, connection.chatId]
  );
  return result.rows[0];
}

async function appendAuditEvent(event, client) {
  await client.query(
    `INSERT INTO audit_events
      (id, actor_user_id, subject_user_id, event_code, entity_type, entity_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [event.id, event.actorUserId, event.subjectUserId, event.code,
      event.entityType, event.entityId, event.metadata]
  );
}

async function hasAlternativeLogin(userId, identityId, client) {
  const result = await client.query(
    `SELECT
       EXISTS (SELECT 1 FROM user_passwords WHERE user_id = $1)
       OR EXISTS (
         SELECT 1 FROM auth_identities WHERE user_id = $1 AND id <> $2
       ) AS has_alternative`,
    [userId, identityId]
  );
  return result.rows[0].has_alternative;
}

async function deleteTelegramIdentity(identityId, client) {
  await client.query('DELETE FROM auth_identities WHERE id = $1', [identityId]);
}

async function disconnectTelegramConnection(userId, botId, client) {
  await client.query(
    `UPDATE telegram_connections
     SET status = 'disconnected'
     WHERE user_id = $1 AND bot_id = $2`,
    [userId, botId]
  );
}

async function findActiveTelegramConnection(userId, botId, db = pool) {
  const result = await db.query(
    `SELECT id, chat_id
     FROM telegram_connections
     WHERE user_id = $1 AND bot_id = $2 AND status = 'active'`,
    [userId, botId]
  );
  return result.rows[0] || null;
}

async function markTelegramConnectionBlocked(connectionId, db = pool) {
  await db.query(
    `UPDATE telegram_connections
     SET status = 'blocked', blocked_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [connectionId]
  );
}

export {
  appendAuditEvent,
  consumeTelegramOidcState,
  createSession,
  createTelegramIdentity,
  createTelegramOidcState,
  deleteTelegramIdentity,
  disconnectTelegramConnection,
  findActiveTelegramConnection,
  findLiveSession,
  findTelegramIdentityForUpdate,
  findUserTelegramIdentityForUpdate,
  hasAlternativeLogin,
  markTelegramConnectionBlocked,
  touchTelegramIdentity,
  upsertTelegramConnection,
};
