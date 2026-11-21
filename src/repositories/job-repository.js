import pool from '../configs/db.js'
import { normalizeInternalId as normalizeId } from '../utils/internal-id.js'

const normalizeInternalId = (value) => normalizeId(String(value))

const jobColumns = `id, job_type, payload, dedupe_key, status, available_at, locked_by,
   lease_expires_at, attempts, max_attempts, last_error_code, created_at, finished_at`

// Inserts a job inside the caller's transaction (outbox): a rolled-back domain change leaves no
// job. The same dedupe_key is a no-op and returns null.
async function enqueueJob({ jobType, payload, dedupeKey, availableAt = null, maxAttempts = null }, client) {
   const result = await client.query(
      `INSERT INTO background_jobs (job_type, payload, dedupe_key, available_at, max_attempts)
       VALUES ($1, $2, $3, COALESCE($4::timestamptz, CURRENT_TIMESTAMP), COALESCE($5::integer, 5))
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
      [jobType, payload, dedupeKey, availableAt, maxAttempts],
   )
   return result.rows[0]?.id ?? null
}

// A running job whose lease ran out after its last attempt can never be retried.
async function failExhaustedLeases(db = pool) {
   const result = await db.query(
      `UPDATE background_jobs
       SET status = 'failed', last_error_code = 'LEASE_EXPIRED', locked_by = NULL,
           lease_expires_at = NULL, finished_at = CURRENT_TIMESTAMP
       WHERE status = 'running' AND lease_expires_at < CURRENT_TIMESTAMP
         AND attempts >= max_attempts`,
   )
   return result.rowCount
}

// Claims one due job: a pending one first, otherwise a running one whose lease expired (its
// worker died). SKIP LOCKED lets several workers claim different jobs at the same time.
async function claimNextJob({ workerId, leaseSeconds, jobTypes }, db = pool) {
   for (const where of [
      `status = 'pending' AND available_at <= CURRENT_TIMESTAMP`,
      `status = 'running' AND lease_expires_at < CURRENT_TIMESTAMP AND attempts < max_attempts`,
   ]) {
      const result = await db.query(
         `UPDATE background_jobs AS job
          SET status = 'running', locked_by = $1, attempts = job.attempts + 1,
              lease_expires_at = CURRENT_TIMESTAMP + make_interval(secs => $2)
          WHERE job.id = (
             SELECT id FROM background_jobs
             WHERE ${where} AND job_type = ANY($3::text[])
             ORDER BY available_at, id
             FOR UPDATE SKIP LOCKED
             LIMIT 1
          )
          RETURNING ${jobColumns.split(',').map((column) => `job.${column.trim()}`).join(', ')}`,
         [workerId, leaseSeconds, jobTypes],
      )
      if (result.rows[0]) return result.rows[0]
   }
   return null
}

async function extendJobLease({ jobId, workerId, leaseSeconds }, db = pool) {
   const result = await db.query(
      `UPDATE background_jobs
       SET lease_expires_at = CURRENT_TIMESTAMP + make_interval(secs => $3)
       WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
      [normalizeInternalId(jobId), workerId, leaseSeconds],
   )
   return result.rowCount === 1
}

async function completeJob({ jobId, workerId }, db = pool) {
   const result = await db.query(
      `UPDATE background_jobs
       SET status = 'completed', locked_by = NULL, lease_expires_at = NULL,
           last_error_code = NULL, finished_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
      [normalizeInternalId(jobId), workerId],
   )
   return result.rowCount === 1
}

// retryAt null, or no attempts left: the job ends as failed (the dead letter state).
async function failJob({ jobId, workerId, errorCode, retryAt }, db = pool) {
   const result = await db.query(
      `UPDATE background_jobs
       SET status = CASE WHEN $4::timestamptz IS NULL OR attempts >= max_attempts
                         THEN 'failed' ELSE 'pending' END,
           available_at = CASE WHEN $4::timestamptz IS NULL OR attempts >= max_attempts
                               THEN available_at ELSE $4::timestamptz END,
           finished_at = CASE WHEN $4::timestamptz IS NULL OR attempts >= max_attempts
                              THEN CURRENT_TIMESTAMP END,
           last_error_code = $3, locked_by = NULL, lease_expires_at = NULL
       WHERE id = $1 AND locked_by = $2 AND status = 'running'
       RETURNING status`,
      [normalizeInternalId(jobId), workerId, errorCode, retryAt],
   )
   return result.rows[0]?.status ?? null
}

export {
   claimNextJob,
   completeJob,
   enqueueJob,
   extendJobLease,
   failExhaustedLeases,
   failJob,
}
