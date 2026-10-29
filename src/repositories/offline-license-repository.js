import pool from '../configs/db.js'
import { normalizeInternalId } from '../utils/internal-id.js'

const licenseColumns = `license.id, license.user_id, license.session_id, license.lesson_id,
   license.asset_id, license.granted_at, license.lease_expires_at, license.last_checked_at,
   license.revoked_at, license.revoked_by, license.revoke_reason, license.renewed_at,
   license.device_label, lesson.course_id, lesson.module_id,
   (license.revoked_at IS NULL AND license.lease_expires_at > CURRENT_TIMESTAMP) AS is_active`

const licenseFrom = `offline_downloads AS license
   JOIN lessons AS lesson ON lesson.id = license.lesson_id`

// Only current grants bound the lease; the shortest expiry wins in the service.
async function findAccessWindow(userId, moduleId, client) {
   const result = await client.query(
      `SELECT enrollment.expires_at AS enrollment_expires_at,
         module_grant.expires_at AS grant_expires_at
       FROM course_modules AS module
       JOIN course_enrollments AS enrollment
         ON enrollment.course_id = module.course_id AND enrollment.user_id = $1
       JOIN module_access_grants AS module_grant
         ON module_grant.module_id = module.id AND module_grant.user_id = $1
       WHERE module.id = $2 AND enrollment.revoked_at IS NULL AND module_grant.revoked_at IS NULL`,
      [normalizeInternalId(userId), normalizeInternalId(moduleId)],
   )
   return result.rows[0] || null
}

// A device is a live session holding at least one active license.
async function listActiveDeviceSessions(userId, client) {
   const result = await client.query(
      `SELECT DISTINCT license.session_id
       FROM offline_downloads AS license
       JOIN auth_sessions AS session ON session.id = license.session_id
       WHERE license.user_id = $1
         AND license.revoked_at IS NULL AND license.lease_expires_at > CURRENT_TIMESTAMP
         AND session.revoked_at IS NULL AND session.expires_at > CURRENT_TIMESTAMP`,
      [normalizeInternalId(userId)],
   )
   return result.rows.map((row) => row.session_id)
}

async function findSessionLicenseForUpdate(sessionId, lessonId, assetId, client) {
   const result = await client.query(
      `SELECT ${licenseColumns} FROM ${licenseFrom}
       WHERE license.session_id = $1 AND license.lesson_id = $2 AND license.asset_id = $3
       FOR UPDATE OF license`,
      [normalizeInternalId(sessionId), normalizeInternalId(lessonId), normalizeInternalId(assetId)],
   )
   return result.rows[0] || null
}

async function findLicense(licenseId, db = pool) {
   const result = await db.query(
      `SELECT ${licenseColumns} FROM ${licenseFrom} WHERE license.id = $1`,
      [normalizeInternalId(licenseId)],
   )
   return result.rows[0] || null
}

async function findLicenseForUpdate(licenseId, client) {
   const result = await client.query(
      `SELECT ${licenseColumns} FROM ${licenseFrom} WHERE license.id = $1 FOR UPDATE OF license`,
      [normalizeInternalId(licenseId)],
   )
   return result.rows[0] || null
}

async function insertLicense(license, client) {
   const result = await client.query(
      `INSERT INTO offline_downloads
         (user_id, session_id, lesson_id, asset_id, lease_expires_at, last_checked_at, device_label)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, $6)
       RETURNING id`,
      [
         normalizeInternalId(license.userId),
         normalizeInternalId(license.sessionId),
         normalizeInternalId(license.lessonId),
         normalizeInternalId(license.assetId),
         license.leaseExpiresAt,
         license.deviceLabel,
      ],
   )
   return result.rows[0]
}

// Renewal also reopens a license the learner deleted earlier on the same session.
async function renewLicense(licenseId, leaseExpiresAt, deviceLabel, client) {
   await client.query(
      `UPDATE offline_downloads SET
         lease_expires_at = GREATEST($2::timestamptz, granted_at + INTERVAL '1 second'),
         renewed_at = CURRENT_TIMESTAMP,
         last_checked_at = CURRENT_TIMESTAMP,
         device_label = COALESCE($3, device_label),
         revoked_at = NULL, revoked_by = NULL, revoke_reason = NULL
       WHERE id = $1`,
      [normalizeInternalId(licenseId), leaseExpiresAt, deviceLabel],
   )
}

async function touchLicense(licenseId, client) {
   await client.query(
      'UPDATE offline_downloads SET last_checked_at = CURRENT_TIMESTAMP WHERE id = $1',
      [normalizeInternalId(licenseId)],
   )
}

async function revokeLicense(licenseId, revokedBy, reason, client) {
   await client.query(
      `UPDATE offline_downloads
       SET revoked_at = CURRENT_TIMESTAMP, revoked_by = $2, revoke_reason = $3
       WHERE id = $1 AND revoked_at IS NULL`,
      [normalizeInternalId(licenseId), normalizeInternalId(revokedBy), reason],
   )
}

async function revokeLessonAssetLicenses(lessonId, assetId, revokedBy, client) {
   const result = await client.query(
      `UPDATE offline_downloads
       SET revoked_at = CURRENT_TIMESTAMP, revoked_by = $3, revoke_reason = 'access_lost'
       WHERE lesson_id = $1 AND asset_id = $2 AND revoked_at IS NULL`,
      [normalizeInternalId(lessonId), normalizeInternalId(assetId), normalizeInternalId(revokedBy)],
   )
   return result.rowCount
}

async function listSessionLicenses(userId, sessionId, db = pool) {
   const result = await db.query(
      `SELECT ${licenseColumns} FROM ${licenseFrom}
       WHERE license.user_id = $1 AND license.session_id = $2
         AND license.revoked_at IS NULL AND license.lease_expires_at > CURRENT_TIMESTAMP
       ORDER BY license.granted_at DESC, license.id`,
      [normalizeInternalId(userId), normalizeInternalId(sessionId)],
   )
   return result.rows
}

async function listUserLicenses(userId, db = pool) {
   const result = await db.query(
      `SELECT ${licenseColumns} FROM ${licenseFrom}
       WHERE license.user_id = $1
       ORDER BY license.granted_at DESC, license.id
       LIMIT 500`,
      [normalizeInternalId(userId)],
   )
   return result.rows
}

export {
   findAccessWindow,
   findLicense,
   findLicenseForUpdate,
   findSessionLicenseForUpdate,
   insertLicense,
   listActiveDeviceSessions,
   listSessionLicenses,
   listUserLicenses,
   renewLicense,
   revokeLessonAssetLicenses,
   revokeLicense,
   touchLicense,
}
