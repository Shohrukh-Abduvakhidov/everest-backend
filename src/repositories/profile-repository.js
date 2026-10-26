import pool from '../configs/db.js'
import { normalizeInternalId } from '../utils/internal-id.js'

async function findOwnProfile(userId, db = pool) {
   const result = await db.query(
      `SELECT account.id, account.status, account.onboarding_completed_at,
         account.created_at, GREATEST(account.updated_at, profile.updated_at) AS updated_at,
         profile.first_name, profile.last_name, profile.language_code, profile.timezone,
         profile.avatar_asset_id, phone.phone_e164,
         COALESCE(
            array_agg(DISTINCT role.code ORDER BY role.code)
               FILTER (WHERE role.code IS NOT NULL),
            ARRAY[]::varchar[]
         ) AS roles
       FROM users AS account
       JOIN user_profiles AS profile ON profile.user_id = account.id
       LEFT JOIN LATERAL (
          SELECT owned_phone.phone_e164
          FROM user_phones AS owned_phone
          WHERE owned_phone.user_id = account.id
          ORDER BY owned_phone.is_primary DESC, owned_phone.created_at, owned_phone.id
          LIMIT 1
       ) AS phone ON TRUE
       LEFT JOIN user_roles AS membership ON membership.user_id = account.id
       LEFT JOIN roles AS role ON role.id = membership.role_id
       WHERE account.id = $1
       GROUP BY account.id, profile.user_id, phone.phone_e164`,
      [normalizeInternalId(userId)],
   )
   return result.rows[0] || null
}

async function findOwnProfileForUpdate(userId, client) {
   const result = await client.query(
      `SELECT account.id, account.status, account.onboarding_completed_at,
         profile.first_name, profile.last_name, profile.language_code, profile.timezone
       FROM users AS account
       JOIN user_profiles AS profile ON profile.user_id = account.id
       WHERE account.id = $1
       FOR UPDATE OF account, profile`,
      [normalizeInternalId(userId)],
   )
   return result.rows[0] || null
}

async function updateOwnProfile(userId, changes, client) {
   const normalizedUserId = normalizeInternalId(userId)
   await client.query(
      `UPDATE user_profiles
       SET first_name = CASE WHEN $2 THEN $3 ELSE first_name END,
           last_name = CASE WHEN $4 THEN $5 ELSE last_name END,
           language_code = CASE WHEN $6 THEN $7 ELSE language_code END,
           timezone = CASE WHEN $8 THEN $9 ELSE timezone END,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1`,
      [
         normalizedUserId,
         changes.hasFirstName,
         changes.firstName,
         changes.hasLastName,
         changes.lastName,
         changes.hasPreferredLanguage,
         changes.preferredLanguage,
         changes.hasTimezone,
         changes.timezone,
      ],
   )
   await client.query(
      `UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [normalizedUserId],
   )
}

async function completeOnboarding(userId, client) {
   const result = await client.query(
      `UPDATE users
       SET onboarding_completed_at = COALESCE(onboarding_completed_at, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING onboarding_completed_at`,
      [normalizeInternalId(userId)],
   )
   return result.rows[0]
}

export {
   completeOnboarding,
   findOwnProfile,
   findOwnProfileForUpdate,
   updateOwnProfile,
}
