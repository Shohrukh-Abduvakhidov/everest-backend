import pool from '../configs/db.js'
import { normalizeInternalId } from '../utils/internal-id.js'

async function hasPermission(userId, permissionCode, db = pool) {
   const result = await db.query(
      `SELECT EXISTS (
       SELECT 1
       FROM user_roles AS membership
       JOIN role_permissions AS grant_record ON grant_record.role_id = membership.role_id
       JOIN permissions AS permission ON permission.id = grant_record.permission_id
       WHERE membership.user_id = $1 AND permission.code = $2
     ) AS allowed`,
      [normalizeInternalId(userId), permissionCode],
   )

   return result.rows[0].allowed
}

export { hasPermission }
