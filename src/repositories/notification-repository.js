import pool from '../configs/db.js'
import { normalizeInternalId } from '../utils/internal-id.js'

const inboxColumns = 'id, event_code, title, body, target_path, created_at, read_at'

// ---------------------------------------------------------------- recipients

// Active accounts only, with the language and time zone used to render the text.
async function findRecipients(userIds, db = pool) {
   if (!userIds.length) return []
   const result = await db.query(
      `SELECT account.id AS user_id,
          COALESCE(profile.language_code, 'ru') AS language_code,
          COALESCE(profile.timezone, 'Asia/Dushanbe') AS timezone
       FROM users AS account
       LEFT JOIN user_profiles AS profile ON profile.user_id = account.id
       WHERE account.id = ANY($1::bigint[]) AND account.status = 'active'
       ORDER BY account.id`,
      [userIds.map((userId) => normalizeInternalId(String(userId)))],
   )
   return result.rows
}

async function listActiveGroupMemberIds(groupId, db = pool) {
   const result = await db.query(
      `SELECT user_id FROM group_members WHERE group_id = $1 AND status = 'active' ORDER BY user_id`,
      [normalizeInternalId(groupId)],
   )
   return result.rows.map((row) => row.user_id)
}

// ---------------------------------------------------------------- event sources

async function findAssignmentSource(assignmentId, db = pool) {
   const result = await db.query(
      `SELECT assignment.id, assignment.status, assignment.opens_at, assignment.closes_at,
          assignment.group_id, assignment.user_id, test.title AS test_title, test.course_id,
          test.status AS test_status,
          (assignment.opens_at <= CURRENT_TIMESTAMP) AS is_open,
          (assignment.closes_at IS NOT NULL AND assignment.closes_at <= CURRENT_TIMESTAMP) AS is_closed
       FROM test_assignments AS assignment
       JOIN tests AS test ON test.id = assignment.test_id
       WHERE assignment.id = $1`,
      [normalizeInternalId(assignmentId)],
   )
   return result.rows[0] || null
}

// Open assignments of a group right now: active, already opened, not closed, test published.
// Assignments that open later get their own scheduled job at opens_at.
async function listOpenGroupAssignmentIds(groupId, db = pool) {
   const result = await db.query(
      `SELECT assignment.id
       FROM test_assignments AS assignment
       JOIN tests AS test ON test.id = assignment.test_id
       WHERE assignment.group_id = $1 AND assignment.status = 'active'
         AND test.status = 'published'
         AND assignment.opens_at <= CURRENT_TIMESTAMP
         AND (assignment.closes_at IS NULL OR assignment.closes_at > CURRENT_TIMESTAMP)
       ORDER BY assignment.id`,
      [normalizeInternalId(groupId)],
   )
   return result.rows.map((row) => row.id)
}

async function isActiveGroupMember(groupId, userId, db = pool) {
   const result = await db.query(
      `SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2 AND status = 'active'`,
      [normalizeInternalId(groupId), normalizeInternalId(userId)],
   )
   return result.rowCount === 1
}

async function findAnnouncementSource(announcementId, db = pool) {
   const result = await db.query(
      `SELECT announcement.id, announcement.group_id, announcement.author_id, announcement.title,
          announcement.status, grp.title AS group_title, grp.status AS group_status
       FROM group_announcements AS announcement
       JOIN groups AS grp ON grp.id = announcement.group_id
       WHERE announcement.id = $1`,
      [normalizeInternalId(announcementId)],
   )
   return result.rows[0] || null
}

async function findAttemptGrantSource(grantId, db = pool) {
   const result = await db.query(
      `SELECT grant_record.id, grant_record.user_id, grant_record.extra_attempts,
          assignment.id AS assignment_id, assignment.status AS assignment_status,
          test.title AS test_title, test.course_id
       FROM test_attempt_grants AS grant_record
       JOIN test_assignments AS assignment ON assignment.id = grant_record.assignment_id
       JOIN tests AS test ON test.id = assignment.test_id
       WHERE grant_record.id = $1`,
      [normalizeInternalId(grantId)],
   )
   return result.rows[0] || null
}

async function findEnrollmentSource(enrollmentId, db = pool) {
   const result = await db.query(
      `SELECT enrollment.id, enrollment.user_id, enrollment.course_id, enrollment.revoked_at,
          enrollment.begins_at, enrollment.expires_at, course.title AS course_title,
          course.status AS course_status,
          (enrollment.revoked_at IS NULL AND enrollment.begins_at <= CURRENT_TIMESTAMP
             AND (enrollment.expires_at IS NULL OR enrollment.expires_at > CURRENT_TIMESTAMP)) AS is_current
       FROM course_enrollments AS enrollment
       JOIN courses AS course ON course.id = enrollment.course_id
       WHERE enrollment.id = $1`,
      [normalizeInternalId(enrollmentId)],
   )
   return result.rows[0] || null
}

async function findModuleGrantSource(grantId, db = pool) {
   const result = await db.query(
      `SELECT grant_record.id, grant_record.user_id, grant_record.course_id, grant_record.module_id,
          module.title AS module_title, module.status AS module_status, course.title AS course_title,
          (grant_record.revoked_at IS NULL AND grant_record.begins_at <= CURRENT_TIMESTAMP
             AND (grant_record.expires_at IS NULL OR grant_record.expires_at > CURRENT_TIMESTAMP)) AS is_current
       FROM module_access_grants AS grant_record
       JOIN course_modules AS module ON module.id = grant_record.module_id
       JOIN courses AS course ON course.id = grant_record.course_id
       WHERE grant_record.id = $1`,
      [normalizeInternalId(grantId)],
   )
   return result.rows[0] || null
}

// ---------------------------------------------------------------- writes

// One statement per batch; UNIQUE (user_id, dedupe_key) makes a repeated event a no-op.
// Returns only the rows written now (id, user_id), so channels are added for new ones only.
async function insertNotifications(rows, client) {
   if (!rows.length) return []
   const result = await client.query(
      `INSERT INTO notifications (user_id, event_code, title, body, target_path, dedupe_key)
       SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
       ON CONFLICT (user_id, dedupe_key) DO NOTHING
       RETURNING id, user_id`,
      [
         rows.map((row) => normalizeInternalId(String(row.userId))),
         rows.map((row) => row.eventCode),
         rows.map((row) => row.title),
         rows.map((row) => row.body),
         rows.map((row) => row.targetPath ?? null),
         rows.map((row) => row.dedupeKey),
      ],
   )
   return result.rows
}

// ---------------------------------------------------------------- inbox

async function listNotifications(userId, { limit, beforeId, unreadOnly }, db = pool) {
   const result = await db.query(
      `SELECT ${inboxColumns}
       FROM notifications
       WHERE user_id = $1
         AND ($2::bigint IS NULL OR id < $2::bigint)
         AND (NOT $3::boolean OR read_at IS NULL)
       ORDER BY id DESC
       LIMIT $4`,
      [normalizeInternalId(userId), beforeId, unreadOnly, limit + 1],
   )
   return result.rows
}

async function countUnread(userId, db = pool) {
   const result = await db.query(
      'SELECT count(*)::integer AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL',
      [normalizeInternalId(userId)],
   )
   return result.rows[0].count
}

// Idempotent: an already read notification keeps its first read_at.
async function markRead(userId, notificationId, db = pool) {
   const result = await db.query(
      `UPDATE notifications
       SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
       WHERE id = $1 AND user_id = $2
       RETURNING ${inboxColumns}`,
      [normalizeInternalId(notificationId), normalizeInternalId(userId)],
   )
   return result.rows[0] || null
}

async function markAllRead(userId, upToId, db = pool) {
   const result = await db.query(
      `UPDATE notifications
       SET read_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND id <= $2 AND read_at IS NULL`,
      [normalizeInternalId(userId), normalizeInternalId(upToId)],
   )
   return result.rowCount
}

async function isActiveAccount(userId, db = pool) {
   const result = await db.query(
      "SELECT 1 FROM users WHERE id = $1 AND status = 'active'",
      [normalizeInternalId(userId)],
   )
   return result.rowCount === 1
}

export {
   countUnread,
   findAnnouncementSource,
   findAssignmentSource,
   findAttemptGrantSource,
   findEnrollmentSource,
   findModuleGrantSource,
   findRecipients,
   insertNotifications,
   isActiveAccount,
   isActiveGroupMember,
   listActiveGroupMemberIds,
   listNotifications,
   listOpenGroupAssignmentIds,
   markAllRead,
   markRead,
}
