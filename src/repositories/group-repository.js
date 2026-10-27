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

async function createGroup(group, client) {
   const result = await client.query(
      `INSERT INTO groups (code, title, description, status, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, code, title, description, status, created_at, updated_at`,
      [group.code, group.title, group.description, group.status, normalizeInternalId(group.actorId)],
   )
   return result.rows[0]
}

async function findGroupForUpdate(groupId, client) {
   const result = await client.query(
      `SELECT id, code, title, description, status, created_at, updated_at
       FROM groups WHERE id = $1 FOR UPDATE`,
      [normalizeInternalId(groupId)],
   )
   return result.rows[0] || null
}

async function updateGroup(groupId, changes, client) {
   const result = await client.query(
      `UPDATE groups SET
         code = COALESCE($2, code),
         title = COALESCE($3, title),
         description = CASE WHEN $4 THEN $5 ELSE description END,
         status = COALESCE($6, status),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING id, code, title, description, status, created_at, updated_at`,
      [
         normalizeInternalId(groupId),
         changes.code,
         changes.title,
         changes.hasDescription,
         changes.description,
         changes.status,
      ],
   )
   return result.rows[0]
}

async function findEligibleUserForUpdate(userId, roleCode, client) {
   const result = await client.query(
      `SELECT account.id, account.status,
         EXISTS (
            SELECT 1 FROM user_roles AS membership
            JOIN roles AS role ON role.id = membership.role_id
            WHERE membership.user_id = account.id AND role.code = $2
         ) AS eligible
       FROM users AS account
       WHERE account.id = $1
       FOR UPDATE`,
      [normalizeInternalId(userId), roleCode],
   )
   return result.rows[0] || null
}

async function findMembershipForUpdate(groupId, userId, client) {
   const result = await client.query(
      `SELECT id, status, is_representative, joined_at, left_at
       FROM group_members WHERE group_id = $1 AND user_id = $2 FOR UPDATE`,
      [normalizeInternalId(groupId), normalizeInternalId(userId)],
   )
   return result.rows[0] || null
}

async function saveMembership({ groupId, userId, actorId, isRepresentative }, client) {
   const result = await client.query(
      `INSERT INTO group_members
         (group_id, user_id, status, is_representative, joined_at, left_at, added_by)
       VALUES ($1, $2, 'active', $3, CURRENT_TIMESTAMP, NULL, $4)
       ON CONFLICT (group_id, user_id) DO UPDATE SET
         status = 'active', is_representative = EXCLUDED.is_representative,
         joined_at = CURRENT_TIMESTAMP, left_at = NULL, added_by = EXCLUDED.added_by
       RETURNING id, group_id, user_id, status, is_representative, joined_at, left_at`,
      [
         normalizeInternalId(groupId),
         normalizeInternalId(userId),
         isRepresentative,
         normalizeInternalId(actorId),
      ],
   )
   return result.rows[0]
}

async function removeMembership(groupId, userId, client) {
   const result = await client.query(
      `UPDATE group_members
       SET status = 'removed', left_at = CURRENT_TIMESTAMP
       WHERE group_id = $1 AND user_id = $2 AND status = 'active'
       RETURNING id, group_id, user_id, status, is_representative, joined_at, left_at`,
      [normalizeInternalId(groupId), normalizeInternalId(userId)],
   )
   return result.rows[0] || null
}

async function findTeacherForUpdate(groupId, userId, client) {
   const result = await client.query(
      `SELECT id, user_id, can_publish_announcements, can_assign_tests,
         can_view_results, assigned_at
       FROM group_teachers WHERE group_id = $1 AND user_id = $2 FOR UPDATE`,
      [normalizeInternalId(groupId), normalizeInternalId(userId)],
   )
   return result.rows[0] || null
}

async function createTeacher(assignment, client) {
   const result = await client.query(
      `INSERT INTO group_teachers
         (group_id, user_id, can_publish_announcements, can_assign_tests,
          can_view_results, assigned_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, group_id, user_id, can_publish_announcements,
         can_assign_tests, can_view_results, assigned_at`,
      [
         normalizeInternalId(assignment.groupId),
         normalizeInternalId(assignment.userId),
         assignment.canPublishAnnouncements,
         assignment.canAssignTests,
         assignment.canViewResults,
         normalizeInternalId(assignment.actorId),
      ],
   )
   return result.rows[0]
}

async function removeTeacher(groupId, userId, client) {
   const result = await client.query(
      `DELETE FROM group_teachers WHERE group_id = $1 AND user_id = $2 RETURNING id`,
      [normalizeInternalId(groupId), normalizeInternalId(userId)],
   )
   return result.rowCount > 0
}

async function findAnnouncementManagerScope(userId, groupId, client) {
   const result = await client.query(
      `SELECT group_record.id,
         EXISTS (
            SELECT 1 FROM user_roles AS membership
            JOIN roles AS role ON role.id = membership.role_id
            WHERE membership.user_id = $1 AND role.code IN ('owner', 'admin')
         ) AS administrator,
         EXISTS (
            SELECT 1 FROM group_teachers AS assignment
            WHERE assignment.group_id = group_record.id AND assignment.user_id = $1
              AND assignment.can_publish_announcements
         ) AS assigned_teacher
       FROM groups AS group_record WHERE group_record.id = $2 FOR UPDATE`,
      [normalizeInternalId(userId), normalizeInternalId(groupId)],
   )
   return result.rows[0] || null
}

async function listVisibleAnnouncements(userId, groupId, { limit, offset }, db = pool) {
   const result = await db.query(
      `WITH actor AS (${actorAccessSql}),
       accessible_group AS (
          SELECT group_record.id, actor.administrator,
            EXISTS (
               SELECT 1 FROM group_teachers AS own_assignment
               WHERE own_assignment.group_id = group_record.id
                 AND own_assignment.user_id = $1
            ) AS is_teacher
          FROM groups AS group_record CROSS JOIN actor
          WHERE group_record.id = $2 AND (${visiblePredicateSql})
       ), page AS (
          SELECT announcement.id, announcement.group_id, announcement.author_id,
            announcement.title, announcement.content, announcement.is_pinned,
            announcement.status, announcement.published_at,
            announcement.created_at, announcement.updated_at
          FROM group_announcements AS announcement
          JOIN accessible_group ON accessible_group.id = announcement.group_id
          WHERE announcement.status <> 'archived'
            AND (
               announcement.status = 'published'
               OR accessible_group.administrator OR accessible_group.is_teacher
            )
          ORDER BY announcement.is_pinned DESC,
            announcement.published_at DESC NULLS LAST,
            announcement.created_at DESC, announcement.id DESC
          LIMIT $3 OFFSET $4
       )
       SELECT accessible_group.id AS accessible_group_id, page.*
       FROM accessible_group LEFT JOIN page ON TRUE`,
      [normalizeInternalId(userId), normalizeInternalId(groupId), limit + 1, offset],
   )
   return result.rows
}

async function createAnnouncement(announcement, client) {
   const result = await client.query(
      `INSERT INTO group_announcements
         (group_id, author_id, title, content, is_pinned, status, published_at)
       VALUES ($1, $2, $3, $4, $5, $6::varchar,
         CASE WHEN $6::varchar = 'published' THEN CURRENT_TIMESTAMP ELSE NULL END)
       RETURNING id, group_id, author_id, title, content, is_pinned, status,
         published_at, created_at, updated_at`,
      [
         normalizeInternalId(announcement.groupId),
         normalizeInternalId(announcement.authorId),
         announcement.title,
         announcement.content,
         announcement.isPinned,
         announcement.status,
      ],
   )
   return result.rows[0]
}

async function findAnnouncementForUpdate(groupId, announcementId, client) {
   const result = await client.query(
      `SELECT id, group_id, author_id, title, content, is_pinned, status,
         published_at, created_at, updated_at
       FROM group_announcements
       WHERE group_id = $1 AND id = $2 AND status <> 'archived'
       FOR UPDATE`,
      [normalizeInternalId(groupId), normalizeInternalId(announcementId)],
   )
   return result.rows[0] || null
}

async function updateAnnouncement(announcementId, changes, client) {
   const result = await client.query(
      `UPDATE group_announcements SET
         title = COALESCE($2, title),
         content = CASE WHEN $3 THEN $4 ELSE content END,
         is_pinned = COALESCE($5, is_pinned),
         status = COALESCE($6, status),
         published_at = CASE
            WHEN $6 = 'published' AND published_at IS NULL THEN CURRENT_TIMESTAMP
            ELSE published_at
         END,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING id, group_id, author_id, title, content, is_pinned, status,
         published_at, created_at, updated_at`,
      [
         normalizeInternalId(announcementId),
         changes.title,
         changes.hasContent,
         changes.content,
         changes.isPinned,
         changes.status,
      ],
   )
   return result.rows[0]
}

async function archiveAnnouncement(announcementId, client) {
   const result = await client.query(
      `UPDATE group_announcements
       SET status = 'archived', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING id, group_id, author_id, title, content, is_pinned, status,
         published_at, created_at, updated_at`,
      [normalizeInternalId(announcementId)],
   )
   return result.rows[0]
}

export {
   archiveAnnouncement,
   createAnnouncement,
   createGroup,
   createTeacher,
   findAnnouncementForUpdate,
   findAnnouncementManagerScope,
   findEligibleUserForUpdate,
   findGroupForUpdate,
   findMembershipForUpdate,
   findTeacherForUpdate,
   findVisibleGroup,
   listVisibleAnnouncements,
   listVisibleGroups,
   listVisibleMembers,
   listVisibleTeachers,
   removeMembership,
   removeTeacher,
   saveMembership,
   updateAnnouncement,
   updateGroup,
}
