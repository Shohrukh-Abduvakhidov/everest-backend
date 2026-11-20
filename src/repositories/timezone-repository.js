import pool from '../configs/db.js'

// The time zone names PostgreSQL itself accepts in AT TIME ZONE. Read once and cached by
// services/timezone-service.js, because pg_timezone_names scans the zoneinfo files on every call.
async function listTimeZoneNames(db = pool) {
   const result = await db.query('SELECT name FROM pg_timezone_names')
   return result.rows.map((row) => row.name)
}

export { listTimeZoneNames }
