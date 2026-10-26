import pool from '../configs/db.js'
import { normalizeInternalId } from '../utils/internal-id.js'

async function createPendingUser(client) {
   const result = await client.query(
      `INSERT INTO users (status)
     VALUES ('pending')
     RETURNING id, status, created_at`,
   )
   return result.rows[0]
}

async function createProfile(profile, client) {
   const userId = normalizeInternalId(profile.userId)
   await client.query(
      `INSERT INTO user_profiles (user_id, first_name, last_name)
     VALUES ($1, $2, $3)`,
      [userId, profile.firstName, profile.lastName],
   )
}

async function createPhone(phone, client) {
   const userId = normalizeInternalId(phone.userId)
   const result = await client.query(
      `INSERT INTO user_phones (user_id, phone_e164, is_primary)
     VALUES ($1, $2, FALSE)
     RETURNING id`,
      [userId, phone.phoneE164],
   )
   return result.rows[0]
}

async function createPassword(userId, passwordHash, client) {
   const normalizedUserId = normalizeInternalId(userId)
   await client.query(
      `INSERT INTO user_passwords (user_id, password_hash)
     VALUES ($1, $2)`,
      [normalizedUserId, passwordHash],
   )
}

async function assignRole(userId, roleCode, client) {
   const normalizedUserId = normalizeInternalId(userId)
   const result = await client.query(
      `INSERT INTO user_roles (user_id, role_id)
     SELECT $1, id FROM roles WHERE code = $2
     RETURNING role_id`,
      [normalizedUserId, roleCode],
   )
   if (result.rowCount !== 1) throw new Error('Required role is not configured')
}

async function findPasswordAccountByPhone(phoneE164, db = pool) {
   const result = await db.query(
      `SELECT account.id AS user_id, account.status, credential.password_hash
     FROM user_phones AS phone
     JOIN users AS account ON account.id = phone.user_id
     JOIN user_passwords AS credential ON credential.user_id = account.id
     WHERE phone.phone_e164 = $1`,
      [phoneE164],
   )
   return result.rows[0] || null
}

async function findPasswordAccountForUpdate(phoneE164, client) {
   const result = await client.query(
      `SELECT account.id AS user_id, account.status, credential.password_hash
     FROM user_phones AS phone
     JOIN users AS account ON account.id = phone.user_id
     JOIN user_passwords AS credential ON credential.user_id = account.id
     WHERE phone.phone_e164 = $1
     FOR UPDATE OF account, credential`,
      [phoneE164],
   )
   return result.rows[0] || null
}

async function touchLastLogin(userId, client) {
   const normalizedUserId = normalizeInternalId(userId)
   await client.query(
      `UPDATE users
     SET last_login_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
      [normalizedUserId],
   )
}

export {
   assignRole,
   createPassword,
   createPendingUser,
   createPhone,
   createProfile,
   findPasswordAccountByPhone,
   findPasswordAccountForUpdate,
   touchLastLogin,
}
