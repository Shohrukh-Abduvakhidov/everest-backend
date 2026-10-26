import pool from '../configs/db.js'

async function checkDatabase(db = pool) {
   const result = await db.query('SELECT 1 AS ready')
   return result.rows[0].ready === 1
}

export { checkDatabase }
