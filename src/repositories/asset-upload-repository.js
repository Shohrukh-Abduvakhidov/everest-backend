import pool from '../configs/db.js'
import { normalizeInternalId } from '../utils/internal-id.js'

const uploadColumns = `upload.id, upload.asset_id, upload.course_id, upload.storage_upload_id,
   upload.declared_mime_type, upload.size_bytes, upload.part_size_bytes, upload.part_count,
   upload.status, upload.rejection_code, upload.created_by, upload.created_at,
   upload.expires_at, upload.completed_at, upload.aborted_at,
   asset.storage_key, asset.kind, asset.file_name, asset.status AS asset_status,
   asset.processing_status, asset.processing_error,
   (upload.status = 'initiated' AND upload.expires_at <= CURRENT_TIMESTAMP) AS is_expired`

const assetColumns = `id, kind, storage_key, mime_type, file_name, size_bytes, width_px, height_px,
   duration_seconds, status, processing_status, processing_error, uploaded_by, created_at,
   source_metadata`

async function findCourse(courseId, db = pool) {
   const result = await db.query(
      'SELECT id, status FROM courses WHERE id = $1',
      [normalizeInternalId(courseId)],
   )
   return result.rows[0] || null
}

async function isCourseLessonManager(userId, courseId, db = pool) {
   const result = await db.query(
      `SELECT EXISTS (
         SELECT 1
         FROM course_teachers AS assignment
         JOIN user_roles AS membership ON membership.user_id = assignment.user_id
         JOIN roles AS role ON role.id = membership.role_id AND role.code = 'teacher'
         WHERE assignment.user_id = $1
            AND assignment.course_id = $2
            AND assignment.can_manage_lessons
       ) AS allowed`,
      [normalizeInternalId(userId), normalizeInternalId(courseId)],
   )
   return result.rows[0].allowed
}

async function insertPendingAsset(asset, client) {
   const result = await client.query(
      `INSERT INTO assets
         (storage_key, mime_type, file_name, size_bytes, kind, status, uploaded_by,
          source_metadata)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
       RETURNING id`,
      [
         asset.storageKey,
         asset.mimeType,
         asset.fileName,
         asset.sizeBytes,
         asset.kind,
         normalizeInternalId(asset.uploadedBy),
         { courseId: asset.courseId },
      ],
   )
   return result.rows[0]
}

async function insertUpload(upload, client) {
   const result = await client.query(
      `INSERT INTO asset_uploads
         (asset_id, course_id, storage_upload_id, declared_mime_type, size_bytes,
          part_size_bytes, part_count, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
         normalizeInternalId(upload.assetId),
         normalizeInternalId(upload.courseId),
         upload.storageUploadId,
         upload.declaredMimeType,
         upload.sizeBytes,
         upload.partSizeBytes,
         upload.partCount,
         normalizeInternalId(upload.createdBy),
         upload.expiresAt,
      ],
   )
   return result.rows[0]
}

async function findUpload(uploadId, db = pool) {
   const result = await db.query(
      `SELECT ${uploadColumns}
       FROM asset_uploads AS upload
       JOIN assets AS asset ON asset.id = upload.asset_id
       WHERE upload.id = $1`,
      [normalizeInternalId(uploadId)],
   )
   return result.rows[0] || null
}

async function findUploadForUpdate(uploadId, client) {
   const result = await client.query(
      `SELECT ${uploadColumns}
       FROM asset_uploads AS upload
       JOIN assets AS asset ON asset.id = upload.asset_id
       WHERE upload.id = $1
       FOR UPDATE OF upload, asset`,
      [normalizeInternalId(uploadId)],
   )
   return result.rows[0] || null
}

async function markUploadCompleted(uploadId, client) {
   await client.query(
      `UPDATE asset_uploads SET status = 'completed', completed_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'initiated'`,
      [normalizeInternalId(uploadId)],
   )
}

async function markUploadAborted(uploadId, client) {
   await client.query(
      `UPDATE asset_uploads SET status = 'aborted', aborted_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'initiated'`,
      [normalizeInternalId(uploadId)],
   )
}

async function markUploadRejected(uploadId, rejectionCode, client) {
   await client.query(
      `UPDATE asset_uploads SET status = 'rejected', rejection_code = $2
       WHERE id = $1 AND status = 'initiated'`,
      [normalizeInternalId(uploadId), rejectionCode],
   )
}

async function markAssetReady(assetId, metadata, client) {
   await client.query(
      `UPDATE assets
       SET status = 'ready', mime_type = $2, size_bytes = $3, width_px = $4, height_px = $5,
          duration_seconds = $6, processing_status = $7, processing_error = NULL,
          source_metadata = source_metadata || $8::jsonb
       WHERE id = $1`,
      [
         normalizeInternalId(assetId),
         metadata.mimeType,
         metadata.sizeBytes,
         metadata.widthPx,
         metadata.heightPx,
         metadata.durationSeconds,
         metadata.processingStatus,
         metadata.media,
      ],
   )
}

async function markAssetUnusable(assetId, status, processingError, client) {
   await client.query(
      `UPDATE assets SET status = $2, processing_error = $3 WHERE id = $1`,
      [normalizeInternalId(assetId), status, processingError],
   )
}

async function findAsset(assetId, db = pool) {
   const result = await db.query(
      `SELECT ${assetColumns} FROM assets WHERE id = $1`,
      [normalizeInternalId(assetId)],
   )
   return result.rows[0] || null
}

export {
   findAsset,
   findCourse,
   findUpload,
   findUploadForUpdate,
   insertPendingAsset,
   insertUpload,
   isCourseLessonManager,
   markAssetReady,
   markAssetUnusable,
   markUploadAborted,
   markUploadCompleted,
   markUploadRejected,
}
