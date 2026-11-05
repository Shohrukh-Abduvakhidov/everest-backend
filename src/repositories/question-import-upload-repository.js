import pool from '../configs/db.js'
import { normalizeInternalId } from '../utils/internal-id.js'

const administratorSql = `
   EXISTS (
      SELECT 1 FROM user_roles AS membership
      JOIN roles AS role ON role.id = membership.role_id
      WHERE membership.user_id = $1 AND role.code IN ('owner', 'admin')
   )`

const uploadColumns = `upload.id, upload.uploaded_by, upload.package_sha256, upload.size_bytes,
   upload.stored_name, upload.status, upload.options, upload.dry_run_report,
   upload.previous_run_id, upload.run_id, upload.error_code, upload.expires_at,
   upload.created_at, upload.confirmed_at, upload.finished_at`

async function findLiveUploadByHash(packageSha256, db = pool) {
   const result = await db.query(
      `SELECT ${uploadColumns} FROM question_import_uploads AS upload
       WHERE upload.package_sha256 = $1 AND upload.status IN ('validated', 'queued', 'running')`,
      [packageSha256],
   )
   return result.rows[0] || null
}

async function insertUpload(upload, client) {
   const result = await client.query(
      `INSERT INTO question_import_uploads AS upload
         (uploaded_by, package_sha256, size_bytes, stored_name, status, options, dry_run_report,
          previous_run_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${uploadColumns}`,
      [
         normalizeInternalId(upload.uploadedBy),
         upload.packageSha256,
         upload.sizeBytes,
         upload.storedName,
         upload.status,
         upload.options,
         upload.dryRunReport,
         upload.previousRunId,
         upload.expiresAt,
      ],
   )
   return result.rows[0]
}

async function findVisibleUpload(userId, uploadId, db = pool) {
   const result = await db.query(
      `SELECT ${uploadColumns} FROM question_import_uploads AS upload
       WHERE upload.id = $2 AND (upload.uploaded_by = $1 OR ${administratorSql})`,
      [normalizeInternalId(userId), normalizeInternalId(uploadId)],
   )
   return result.rows[0] || null
}

async function lockVisibleUpload(userId, uploadId, client) {
   const result = await client.query(
      `SELECT ${uploadColumns} FROM question_import_uploads AS upload
       WHERE upload.id = $2 AND (upload.uploaded_by = $1 OR ${administratorSql})
       FOR UPDATE OF upload`,
      [normalizeInternalId(userId), normalizeInternalId(uploadId)],
   )
   return result.rows[0] || null
}

async function queueUpload(uploadId, client) {
   const result = await client.query(
      `UPDATE question_import_uploads AS upload
       SET status = 'queued', confirmed_at = CURRENT_TIMESTAMP
       WHERE upload.id = $1
       RETURNING ${uploadColumns}`,
      [normalizeInternalId(uploadId)],
   )
   return result.rows[0]
}

// SKIP LOCKED lets several worker processes run; each row goes to exactly one of them.
async function claimNextUpload(leaseSeconds, db = pool) {
   const result = await db.query(
      `UPDATE question_import_uploads AS upload
       SET status = 'running', lease_until = CURRENT_TIMESTAMP + make_interval(secs => $1)
       WHERE upload.id = (
          SELECT id FROM question_import_uploads
          WHERE status = 'queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       RETURNING ${uploadColumns}`,
      [leaseSeconds],
   )
   return result.rows[0] || null
}

async function renewLease(uploadId, leaseSeconds, db = pool) {
   await db.query(
      `UPDATE question_import_uploads
       SET lease_until = CURRENT_TIMESTAMP + make_interval(secs => $2)
       WHERE id = $1 AND status = 'running'`,
      [normalizeInternalId(uploadId), leaseSeconds],
   )
}

async function finishUpload(uploadId, outcome, db = pool) {
   await db.query(
      `UPDATE question_import_uploads
       SET status = $2, run_id = $3, error_code = $4, stored_name = NULL, lease_until = NULL,
          finished_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [normalizeInternalId(uploadId), outcome.status, outcome.runId, outcome.errorCode],
   )
}

// Returns the rows moved out of a live state, so their stored files can be removed.
async function expireUnconfirmedUploads(db = pool) {
   const result = await db.query(
      `UPDATE question_import_uploads AS upload
       SET status = 'expired', stored_name = NULL, finished_at = CURRENT_TIMESTAMP
       FROM (
          SELECT id, stored_name FROM question_import_uploads
          WHERE status = 'validated' AND expires_at <= CURRENT_TIMESTAMP
          FOR UPDATE
       ) AS previous
       WHERE upload.id = previous.id
       RETURNING upload.id, previous.stored_name`,
   )
   return result.rows
}

async function supersedeUpload(uploadId, client) {
   await client.query(
      `UPDATE question_import_uploads
       SET status = 'expired', error_code = 'IMPORT_UPLOAD_SUPERSEDED', stored_name = NULL,
          finished_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [normalizeInternalId(uploadId)],
   )
}

// A worker that died stops renewing its lease. Its run can no longer finish on its own.
async function failAbandonedUploads(db = pool) {
   const result = await db.query(
      `UPDATE question_import_uploads AS upload
       SET status = 'failed', error_code = 'IMPORT_WORKER_LOST', stored_name = NULL,
          lease_until = NULL, finished_at = CURRENT_TIMESTAMP
       FROM (
          SELECT id, stored_name FROM question_import_uploads
          WHERE status = 'running' AND lease_until <= CURRENT_TIMESTAMP
          FOR UPDATE
       ) AS previous
       WHERE upload.id = previous.id
       RETURNING upload.id, upload.package_sha256, upload.uploaded_by, previous.stored_name`,
   )
   return result.rows
}

async function failInterruptedRuns(packageSha256, initiatedBy, db = pool) {
   await db.query(
      `UPDATE question_imports SET status = 'failed', finished_at = CURRENT_TIMESTAMP
       WHERE package_sha256 = $1 AND initiated_by = $2 AND status = 'importing'`,
      [packageSha256, normalizeInternalId(initiatedBy)],
   )
}

export {
   claimNextUpload,
   expireUnconfirmedUploads,
   failAbandonedUploads,
   failInterruptedRuns,
   findLiveUploadByHash,
   findVisibleUpload,
   finishUpload,
   insertUpload,
   lockVisibleUpload,
   queueUpload,
   renewLease,
   supersedeUpload,
}
