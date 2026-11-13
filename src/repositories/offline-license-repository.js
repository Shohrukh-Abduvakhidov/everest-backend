import pool from '../configs/db.js'
import { normalizeInternalId } from '../utils/internal-id.js'

const licenseColumns = `license.id, license.user_id, license.session_id, license.lesson_id,
   license.asset_id, license.granted_at, license.lease_expires_at, license.last_checked_at,
   license.revoked_at, license.revoked_by, license.revoke_reason, license.renewed_at,
   license.device_label, lesson.course_id, lesson.module_id, license.device_id,
   device.device_key, device.revoked_at AS device_revoked_at,
   (license.revoked_at IS NULL AND license.lease_expires_at > CURRENT_TIMESTAMP) AS is_active`

const licenseFrom = `offline_downloads AS license
   JOIN lessons AS lesson ON lesson.id = license.lesson_id
   LEFT JOIN offline_devices AS device ON device.id = license.device_id`

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

// Pre-device licenses: a device is a live session holding at least one active license
// that is not bound to a registered device.
async function listActiveDeviceSessions(userId, client) {
   const result = await client.query(
      `SELECT DISTINCT license.session_id
       FROM offline_downloads AS license
       JOIN auth_sessions AS session ON session.id = license.session_id
       WHERE license.user_id = $1 AND license.device_id IS NULL
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
         (user_id, session_id, lesson_id, asset_id, lease_expires_at, last_checked_at, device_label,
          device_id)
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, $6, $7)
       RETURNING id`,
      [
         normalizeInternalId(license.userId),
         normalizeInternalId(license.sessionId),
         normalizeInternalId(license.lessonId),
         normalizeInternalId(license.assetId),
         license.leaseExpiresAt,
         license.deviceLabel,
         license.deviceId ? normalizeInternalId(license.deviceId) : null,
      ],
   )
   return result.rows[0]
}

// Renewal also reopens a license the learner deleted earlier on the same session.
// A device-bound renewal also adopts an older session license of the same lesson video.
async function renewLicense(licenseId, leaseExpiresAt, deviceLabel, client, deviceId = null) {
   await client.query(
      `UPDATE offline_downloads SET
         lease_expires_at = GREATEST($2::timestamptz, granted_at + INTERVAL '1 second'),
         renewed_at = CURRENT_TIMESTAMP,
         last_checked_at = CURRENT_TIMESTAMP,
         device_label = COALESCE($3, device_label),
         device_id = COALESCE($4, device_id),
         revoked_at = NULL, revoked_by = NULL, revoke_reason = NULL
       WHERE id = $1`,
      [
         normalizeInternalId(licenseId),
         leaseExpiresAt,
         deviceLabel,
         deviceId ? normalizeInternalId(deviceId) : null,
      ],
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

async function findDeviceLicenseForUpdate(deviceId, lessonId, assetId, client) {
   const result = await client.query(
      `SELECT ${licenseColumns} FROM ${licenseFrom}
       WHERE license.device_id = $1 AND license.lesson_id = $2 AND license.asset_id = $3
       FOR UPDATE OF license`,
      [normalizeInternalId(deviceId), normalizeInternalId(lessonId), normalizeInternalId(assetId)],
   )
   return result.rows[0] || null
}

// Access ended (enrollment or module grant revoked): every active license of the user in
// that course, or only in that module, stops in the same transaction.
async function revokeAccessLicenses({ userId, courseId, moduleId = null, revokedBy }, client) {
   const result = await client.query(
      `UPDATE offline_downloads AS license
       SET revoked_at = CURRENT_TIMESTAMP, revoked_by = $4, revoke_reason = 'access_lost'
       FROM lessons AS lesson
       WHERE lesson.id = license.lesson_id AND license.user_id = $1 AND lesson.course_id = $2
         AND ($3::bigint IS NULL OR lesson.module_id = $3) AND license.revoked_at IS NULL`,
      [
         normalizeInternalId(userId),
         normalizeInternalId(courseId),
         moduleId ? normalizeInternalId(moduleId) : null,
         normalizeInternalId(revokedBy),
      ],
   )
   return result.rowCount
}

async function listDeviceLicenses(userId, deviceId, db = pool) {
   const result = await db.query(
      `SELECT ${licenseColumns} FROM ${licenseFrom}
       WHERE license.user_id = $1 AND license.device_id = $2
         AND license.revoked_at IS NULL AND license.lease_expires_at > CURRENT_TIMESTAMP
       ORDER BY license.granted_at DESC, license.id`,
      [normalizeInternalId(userId), normalizeInternalId(deviceId)],
   )
   return result.rows
}

async function revokeDeviceLicenses(deviceId, revokedBy, client) {
   const result = await client.query(
      `UPDATE offline_downloads
       SET revoked_at = CURRENT_TIMESTAMP, revoked_by = $2, revoke_reason = 'user_deleted'
       WHERE device_id = $1 AND revoked_at IS NULL`,
      [normalizeInternalId(deviceId), normalizeInternalId(revokedBy)],
   )
   return result.rowCount
}

const deviceColumns = `device.id, device.user_id, device.device_key, device.label, device.registered_at,
   device.last_seen_at, device.revoked_at`

async function findDevice(userId, deviceKey, db = pool) {
   const result = await db.query(
      `SELECT ${deviceColumns} FROM offline_devices AS device
       WHERE device.user_id = $1 AND device.device_key = $2`,
      [normalizeInternalId(userId), deviceKey],
   )
   return result.rows[0] || null
}

async function findDeviceForUpdate(userId, deviceKey, client) {
   const result = await client.query(
      `SELECT ${deviceColumns} FROM offline_devices AS device
       WHERE device.user_id = $1 AND device.device_key = $2 FOR UPDATE`,
      [normalizeInternalId(userId), deviceKey],
   )
   return result.rows[0] || null
}

async function countActiveDevices(userId, client) {
   const result = await client.query(
      'SELECT count(*)::integer AS count FROM offline_devices WHERE user_id = $1 AND revoked_at IS NULL',
      [normalizeInternalId(userId)],
   )
   return result.rows[0].count
}

async function insertDevice({ userId, deviceKey, label }, client) {
   const result = await client.query(
      `INSERT INTO offline_devices AS device (user_id, device_key, label) VALUES ($1, $2, $3)
       RETURNING ${deviceColumns}`,
      [normalizeInternalId(userId), deviceKey, label],
   )
   return result.rows[0]
}

// Re-registering a removed device starts it again with a fresh registration time.
async function activateDevice(deviceId, label, client) {
   const result = await client.query(
      `UPDATE offline_devices AS device SET
         label = COALESCE($2, device.label),
         last_seen_at = CURRENT_TIMESTAMP,
         registered_at = CASE WHEN device.revoked_at IS NULL THEN device.registered_at
            ELSE CURRENT_TIMESTAMP END,
         revoked_at = NULL
       WHERE device.id = $1
       RETURNING ${deviceColumns}`,
      [normalizeInternalId(deviceId), label],
   )
   return result.rows[0]
}

async function touchDevice(deviceId, client) {
   await client.query(
      'UPDATE offline_devices SET last_seen_at = CURRENT_TIMESTAMP WHERE id = $1',
      [normalizeInternalId(deviceId)],
   )
}

async function revokeDevice(deviceId, client) {
   await client.query(
      'UPDATE offline_devices SET revoked_at = CURRENT_TIMESTAMP WHERE id = $1 AND revoked_at IS NULL',
      [normalizeInternalId(deviceId)],
   )
}

async function listDevices(userId, db = pool) {
   const result = await db.query(
      `SELECT ${deviceColumns},
         (SELECT count(*)::integer FROM offline_downloads AS license
          WHERE license.device_id = device.id AND license.revoked_at IS NULL
            AND license.lease_expires_at > CURRENT_TIMESTAMP) AS active_licenses
       FROM offline_devices AS device
       WHERE device.user_id = $1 AND device.revoked_at IS NULL
       ORDER BY device.registered_at, device.id`,
      [normalizeInternalId(userId)],
   )
   return result.rows
}

async function listSessionLicenses(userId, sessionId, db = pool) {
   const result = await db.query(
      `SELECT ${licenseColumns} FROM ${licenseFrom}
       WHERE license.user_id = $1 AND license.session_id = $2 AND license.device_id IS NULL
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
   activateDevice,
   countActiveDevices,
   findAccessWindow,
   findDevice,
   findDeviceForUpdate,
   findDeviceLicenseForUpdate,
   findLicense,
   findLicenseForUpdate,
   findSessionLicenseForUpdate,
   insertDevice,
   insertLicense,
   listActiveDeviceSessions,
   listDeviceLicenses,
   listDevices,
   listSessionLicenses,
   listUserLicenses,
   renewLicense,
   revokeAccessLicenses,
   revokeDevice,
   revokeDeviceLicenses,
   revokeLessonAssetLicenses,
   revokeLicense,
   touchDevice,
   touchLicense,
}
