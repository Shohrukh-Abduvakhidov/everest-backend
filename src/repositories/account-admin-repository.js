import pool from '../configs/db.js'
import { normalizeInternalId } from '../utils/internal-id.js'

const accountStateAssignments = {
   approve: `status = 'active', approved_by = $2, approved_at = CURRENT_TIMESTAMP,
    blocked_by = NULL, blocked_at = NULL`,
   reject: `status = 'rejected'`,
   block: `status = 'blocked', blocked_by = $2, blocked_at = CURRENT_TIMESTAMP`,
   unblock: `status = 'active', blocked_by = NULL, blocked_at = NULL`,
}

async function listPendingUsers({ limit, offset }, db = pool) {
   const result = await db.query(
      `SELECT account.id, account.status, account.created_at,
       account.onboarding_completed_at, profile.first_name, profile.last_name,
       phone.phone_e164
     FROM users AS account
     LEFT JOIN user_profiles AS profile ON profile.user_id = account.id
     LEFT JOIN LATERAL (
       SELECT candidate.phone_e164 FROM user_phones AS candidate
       WHERE candidate.user_id = account.id
       ORDER BY candidate.is_primary DESC, candidate.verified_at DESC NULLS LAST, candidate.id
       LIMIT 1
     ) AS phone ON TRUE
     WHERE account.status = 'pending'
     ORDER BY account.created_at, account.id
     LIMIT $1 OFFSET $2`,
      [limit + 1, offset],
   )
   return result.rows
}

async function findUserForUpdate(userId, client) {
   const result = await client.query(
      `SELECT account.id, account.status, account.created_at,
       account.onboarding_completed_at, profile.first_name, profile.last_name,
       phone.phone_e164
     FROM users AS account
     LEFT JOIN user_profiles AS profile ON profile.user_id = account.id
     LEFT JOIN LATERAL (
       SELECT candidate.phone_e164 FROM user_phones AS candidate
       WHERE candidate.user_id = account.id
       ORDER BY candidate.is_primary DESC, candidate.verified_at DESC NULLS LAST, candidate.id
       LIMIT 1
     ) AS phone ON TRUE
     WHERE account.id = $1
     FOR UPDATE OF account`,
      [normalizeInternalId(userId)],
   )
   return result.rows[0] || null
}

async function updateAccountState({ userId, action, actorUserId }, client) {
   const assignment = accountStateAssignments[action]
   const values = ['approve', 'block'].includes(action)
      ? [normalizeInternalId(userId), normalizeInternalId(actorUserId)]
      : [normalizeInternalId(userId)]

   const result = await client.query(
      `UPDATE users SET ${assignment}, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING id, status, approved_by, approved_at, blocked_by, blocked_at, updated_at`,
      values,
   )

   return result.rows[0]
}

async function revokeLiveSessions(userId, reason, client) {
   const result = await client.query(
      `UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP, revoke_reason = $2
     WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP`,
      [normalizeInternalId(userId), reason],
   )
   return result.rowCount
}

async function revokeUserRefreshTokens(userId, client) {
   await client.query(
      `UPDATE auth_refresh_tokens AS token SET revoked_at = COALESCE(token.revoked_at, CURRENT_TIMESTAMP)
     FROM auth_sessions AS session
     WHERE token.session_id = session.id AND session.user_id = $1
       AND token.revoked_at IS NULL`,
      [normalizeInternalId(userId)],
   )
}

async function lockOwnerBootstrap(client) {
   await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('everest.owner-bootstrap', 0))`,
   )
}

async function findOwnerAssignment(client) {
   const result = await client.query(
      `SELECT membership.user_id FROM user_roles AS membership
     JOIN roles AS role ON role.id = membership.role_id
     WHERE role.code = 'owner' LIMIT 1`,
   )
   return result.rows[0] || null
}

async function findUserByPhoneForUpdate(phoneE164, client) {
   const result = await client.query(
      `SELECT account.id, account.status FROM user_phones AS phone
     JOIN users AS account ON account.id = phone.user_id
     WHERE phone.phone_e164 = $1 FOR UPDATE OF account`,
      [phoneE164],
   )
   return result.rows[0] || null
}

async function activateBootstrapOwner(userId, client) {
   await client.query(
      `UPDATE users SET status = 'active', blocked_by = NULL, blocked_at = NULL,
       updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [normalizeInternalId(userId)],
   )
}

async function assignOwnerRole(userId, client) {
   await client.query(
      `INSERT INTO user_roles (user_id, role_id)
     SELECT $1, id FROM roles WHERE code = 'owner'`,
      [normalizeInternalId(userId)],
   )
}

export {
   activateBootstrapOwner,
   assignOwnerRole,
   findOwnerAssignment,
   findUserByPhoneForUpdate,
   findUserForUpdate,
   listPendingUsers,
   lockOwnerBootstrap,
   revokeUserRefreshTokens,
   revokeLiveSessions,
   updateAccountState,
}
