import pool from '../configs/db.js'

async function withTransaction(work) {
   const client = await pool.connect()
   try {
      await client.query('BEGIN')
      const result = await work(client)
      await client.query('COMMIT')
      return result
   } catch (error) {
      try {
         await client.query('ROLLBACK')
      } catch (rollbackError) {
         console.error('Database rollback failed', { code: rollbackError.code })
      }
      throw error
   } finally {
      client.release()
   }
}

export { withTransaction }
