import pool from '../configs/db.js';

async function createPendingUser(userId, client) {
  const result = await client.query(
    `INSERT INTO users (id, status)
     VALUES ($1, 'pending')
     RETURNING id, status, created_at`,
    [userId]
  );
  return result.rows[0];
}

async function createProfile(profile, client) {
  await client.query(
    `INSERT INTO user_profiles (user_id, first_name, last_name)
     VALUES ($1, $2, $3)`,
    [profile.userId, profile.firstName, profile.lastName]
  );
}

async function createPhone(phone, client) {
  await client.query(
    `INSERT INTO user_phones (id, user_id, phone_e164, is_primary)
     VALUES ($1, $2, $3, FALSE)`,
    [phone.id, phone.userId, phone.phoneE164]
  );
}

async function createPassword(userId, passwordHash, client) {
  await client.query(
    `INSERT INTO user_passwords (user_id, password_hash)
     VALUES ($1, $2)`,
    [userId, passwordHash]
  );
}

async function assignRole(userId, roleCode, client) {
  const result = await client.query(
    `INSERT INTO user_roles (user_id, role_id)
     SELECT $1, id FROM roles WHERE code = $2
     RETURNING role_id`,
    [userId, roleCode]
  );
  if (result.rowCount !== 1) throw new Error('Required role is not configured');
}

async function findPasswordAccountByPhone(phoneE164, db = pool) {
  const result = await db.query(
    `SELECT account.id AS user_id, account.status, credential.password_hash
     FROM user_phones AS phone
     JOIN users AS account ON account.id = phone.user_id
     JOIN user_passwords AS credential ON credential.user_id = account.id
     WHERE phone.phone_e164 = $1`,
    [phoneE164]
  );
  return result.rows[0] || null;
}

async function findPasswordAccountForUpdate(phoneE164, client) {
  const result = await client.query(
    `SELECT account.id AS user_id, account.status, credential.password_hash
     FROM user_phones AS phone
     JOIN users AS account ON account.id = phone.user_id
     JOIN user_passwords AS credential ON credential.user_id = account.id
     WHERE phone.phone_e164 = $1
     FOR UPDATE OF account, credential`,
    [phoneE164]
  );
  return result.rows[0] || null;
}

async function touchLastLogin(userId, client) {
  await client.query(
    `UPDATE users
     SET last_login_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [userId]
  );
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
};
