// Idempotent enqueue only; claiming, leasing and retries belong to the M19 worker.
async function enqueueJob(job, client) {
   const result = await client.query(
      `INSERT INTO background_jobs (job_type, payload, dedupe_key)
       VALUES ($1, $2, $3)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
      [job.jobType, job.payload, job.dedupeKey],
   )
   return result.rows[0] || null
}

export { enqueueJob }
