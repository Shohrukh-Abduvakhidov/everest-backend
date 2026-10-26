import pool from '../configs/db.js'
import { normalizeInternalId } from '../utils/internal-id.js'

const actorAccessSql = `
   SELECT EXISTS (
      SELECT 1 FROM user_roles AS membership
      JOIN roles AS role ON role.id = membership.role_id
      WHERE membership.user_id = $1 AND role.code IN ('owner', 'admin')
   ) AS administrator`

const relationshipSql = `
   EXISTS (
      SELECT 1 FROM group_members AS own_membership
      WHERE own_membership.group_id = group_record.id
        AND own_membership.user_id = $1 AND own_membership.status = 'active'
   ) AS is_member,
   EXISTS (
      SELECT 1 FROM group_members AS own_membership
      WHERE own_membership.group_id = group_record.id
        AND own_membership.user_id = $1 AND own_membership.status = 'active'
        AND own_membership.is_representative
   ) AS is_representative,
   EXISTS (
      SELECT 1 FROM group_teachers AS own_assignment
      WHERE own_assignment.group_id = group_record.id AND own_assignment.user_id = $1
   ) AS is_teacher`

const visiblePredicateSql = `
   actor.administrator OR EXISTS (
      SELECT 1 FROM group_members AS own_membership
      WHERE own_membership.group_id = group_record.id
        AND own_membership.user_id = $1 AND own_membership.status = 'active'
   ) OR EXISTS (
      SELECT 1 FROM group_teachers AS own_assignment
      WHERE own_assignment.group_id = group_record.id AND own_assignment.user_id = $1
   )`

async function listVisibleGroups(userId, { limit, offset }, db = pool) {
   const result = await db.query(
      `WITH actor AS (${actorAccessSql})
       SELECT group_record.id, group_record.code, group_record.title,
         group_record.description, group_record.status, group_record.created_at,
         group_record.updated_at, actor.administrator, ${relationshipSql},
         (
            SELECT count(*)::int FROM group_members AS member_count
            WHERE member_count.group_id = group_record.id AND member_count.status = 'active'
         ) AS member_count,
         (
            SELECT count(*)::int FROM group_teachers AS teacher_count
            WHERE teacher_count.group_id = group_record.id
         ) AS teacher_count
       FROM groups AS group_record
       CROSS JOIN actor
       WHERE ${visiblePredicateSql}
       ORDER BY group_record.title, group_record.id
       LIMIT $2 OFFSET $3`,
      [normalizeInternalId(userId), limit + 1, offset],
   )
   return result.rows
}

async function findVisibleGroup(userId, groupId, db = pool) {
   const result = await db.query(
      `WITH actor AS (${actorAccessSql})
       SELECT group_record.id, group_record.code, group_record.title,
         group_record.description, group_record.status, group_record.created_at,
         group_record.updated_at, actor.administrator, ${relationshipSql},
         (
            SELECT count(*)::int FROM group_members AS member_count
            WHERE member_count.group_id = group_record.id AND member_count.status = 'active'
         ) AS member_count,
         (
            SELECT count(*)::int FROM group_teachers AS teacher_count
            WHERE teacher_count.group_id = group_record.id
         ) AS teacher_count
       FROM groups AS group_record
       CROSS JOIN actor
       WHERE group_record.id = $2 AND (${visiblePredicateSql})`,
      [normalizeInternalId(userId), normalizeInternalId(groupId)],
   )
   return result.rows[0] || null
}

async function listVisibleMembers(userId, groupId, { limit, offset }, db = pool) {
   const result = await db.query(
      `WITH actor AS (${actorAccessSql}),
       accessible_group AS (
          SELECT group_record.id
          FROM groups AS group_record CROSS JOIN actor
          WHERE group_record.id = $2 AND (${visiblePredicateSql})
       ),
       page AS (
          SELECT membership.id, membership.user_id, membership.status,
            membership.is_representative, membership.joined_at,
            profile.first_name, profile.last_name, profile.avatar_asset_id
          FROM group_members AS membership
          JOIN accessible_group ON accessible_group.id = membership.group_id
          JOIN user_profiles AS profile ON profile.user_id = membership.user_id
          WHERE membership.status = 'active'
          ORDER BY profile.last_name NULLS LAST, profile.first_name NULLS LAST,
            membership.user_id
          LIMIT $3 OFFSET $4
       )
       SELECT accessible_group.id AS accessible_group_id, page.*
       FROM accessible_group LEFT JOIN page ON TRUE`,
      [normalizeInternalId(userId), normalizeInternalId(groupId), limit + 1, offset],
   )
   return result.rows
}

async function listVisibleTeachers(userId, groupId, { limit, offset }, db = pool) {
   const result = await db.query(
      `WITH actor AS (${actorAccessSql}),
       accessible_group AS (
          SELECT group_record.id
          FROM groups AS group_record CROSS JOIN actor
          WHERE group_record.id = $2 AND (${visiblePredicateSql})
       ),
       page AS (
          SELECT assignment.id, assignment.user_id, assignment.assigned_at,
            assignment.can_publish_announcements, assignment.can_assign_tests,
            assignment.can_view_results, profile.first_name, profile.last_name,
            profile.avatar_asset_id
          FROM group_teachers AS assignment
          JOIN accessible_group ON accessible_group.id = assignment.group_id
          JOIN user_profiles AS profile ON profile.user_id = assignment.user_id
          ORDER BY profile.last_name NULLS LAST, profile.first_name NULLS LAST,
            assignment.user_id
          LIMIT $3 OFFSET $4
       )
       SELECT accessible_group.id AS accessible_group_id, page.*
       FROM accessible_group LEFT JOIN page ON TRUE`,
      [normalizeInternalId(userId), normalizeInternalId(groupId), limit + 1, offset],
   )
   return result.rows
}

export {
   findVisibleGroup,
   listVisibleGroups,
   listVisibleMembers,
   listVisibleTeachers,
}
