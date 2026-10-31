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

async function countPendingUsers(db = pool) {
   const result = await db.query(
      "SELECT count(*)::integer AS total FROM users WHERE status = 'pending'",
   )
   return result.rows[0].total
}

// Fixed sort map: the order never comes from request input directly.
const accountOrders = Object.freeze({
   '-createdAt': 'account.created_at DESC, account.id DESC',
   createdAt: 'account.created_at ASC, account.id ASC',
})

// $1 status, $2 role, $3 LIKE pattern (already escaped by the service).
const accountFilterSql = `($1::text IS NULL OR account.status = $1)
   AND ($2::text IS NULL OR EXISTS (
      SELECT 1 FROM user_roles AS membership
      JOIN roles AS role ON role.id = membership.role_id
      WHERE membership.user_id = account.id AND role.code = $2
   ))
   AND ($3::text IS NULL
      OR profile.first_name ILIKE $3 ESCAPE '\\'
      OR profile.last_name ILIKE $3 ESCAPE '\\'
      OR concat_ws(' ', profile.first_name, profile.last_name) ILIKE $3 ESCAPE '\\'
      OR EXISTS (
         SELECT 1 FROM user_phones AS searched
         WHERE searched.user_id = account.id AND searched.phone_e164 LIKE $3 ESCAPE '\\'
      ))`

const accountColumns = `account.id, account.status, account.created_at, account.updated_at,
   account.last_login_at, account.onboarding_completed_at, profile.first_name, profile.last_name,
   phone.phone_e164,
   COALESCE((
      SELECT array_agg(role.code ORDER BY role.code)
      FROM user_roles AS membership JOIN roles AS role ON role.id = membership.role_id
      WHERE membership.user_id = account.id
   ), ARRAY[]::varchar[]) AS roles,
   EXISTS (
      SELECT 1 FROM auth_identities AS identity
      WHERE identity.user_id = account.id AND identity.provider = 'telegram'
   ) AS telegram_linked`

const primaryPhoneJoin = `LEFT JOIN LATERAL (
     SELECT candidate.phone_e164 FROM user_phones AS candidate
     WHERE candidate.user_id = account.id
     ORDER BY candidate.is_primary DESC, candidate.verified_at DESC NULLS LAST, candidate.id
     LIMIT 1
   ) AS phone ON TRUE`

async function listUsers(filters, db = pool) {
   const result = await db.query(
      `SELECT ${accountColumns}
     FROM users AS account
     LEFT JOIN user_profiles AS profile ON profile.user_id = account.id
     ${primaryPhoneJoin}
     WHERE ${accountFilterSql}
     ORDER BY ${accountOrders[filters.sort]}
     LIMIT $4 OFFSET $5`,
      [filters.status, filters.role, filters.pattern, filters.limit, filters.offset],
   )
   return result.rows
}

async function countUsers(filters, db = pool) {
   const result = await db.query(
      `SELECT count(*)::integer AS total
     FROM users AS account
     LEFT JOIN user_profiles AS profile ON profile.user_id = account.id
     WHERE ${accountFilterSql}`,
      [filters.status, filters.role, filters.pattern],
   )
   return result.rows[0].total
}

async function findAccount(userId, db = pool) {
   const result = await db.query(
      `SELECT ${accountColumns}
     FROM users AS account
     LEFT JOIN user_profiles AS profile ON profile.user_id = account.id
     ${primaryPhoneJoin}
     WHERE account.id = $1`,
      [normalizeInternalId(userId)],
   )
   return result.rows[0] || null
}

async function findUserRoles(userId, db = pool) {
   const result = await db.query(
      `SELECT role.code FROM user_roles AS membership
     JOIN roles AS role ON role.id = membership.role_id
     WHERE membership.user_id = $1
     ORDER BY role.code`,
      [normalizeInternalId(userId)],
   )
   return result.rows.map((row) => row.code)
}

// Replaces the role set in place: assignments that stay keep their assigned_by/assigned_at.
async function replaceUserRoles(userId, roleCodes, actorUserId, client) {
   const id = normalizeInternalId(userId)
   await client.query(
      `DELETE FROM user_roles AS membership USING roles AS role
     WHERE membership.role_id = role.id AND membership.user_id = $1
       AND NOT (role.code = ANY($2::text[]))`,
      [id, roleCodes],
   )
   await client.query(
      `INSERT INTO user_roles (user_id, role_id, assigned_by)
     SELECT $1, role.id, $3 FROM roles AS role WHERE role.code = ANY($2::text[])
     ON CONFLICT (user_id, role_id) DO NOTHING`,
      [id, roleCodes, normalizeInternalId(actorUserId)],
   )
}

async function countActiveOwners(client) {
   const result = await client.query(
      `SELECT count(DISTINCT account.id)::integer AS total
     FROM users AS account
     JOIN user_roles AS membership ON membership.user_id = account.id
     JOIN roles AS role ON role.id = membership.role_id
     WHERE role.code = 'owner' AND account.status = 'active'`,
   )
   return result.rows[0].total
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
   accountOrders,
   activateBootstrapOwner,
   assignOwnerRole,
   countActiveOwners,
   countPendingUsers,
   countUsers,
   findAccount,
   findOwnerAssignment,
   findUserByPhoneForUpdate,
   findUserForUpdate,
   findUserRoles,
   listPendingUsers,
   listUsers,
   lockOwnerBootstrap,
   replaceUserRoles,
   revokeUserRefreshTokens,
   revokeLiveSessions,
   updateAccountState,
}
