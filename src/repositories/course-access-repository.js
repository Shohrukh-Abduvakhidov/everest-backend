import pool from '../configs/db.js'
import { normalizeInternalId } from '../utils/internal-id.js'

const stateSql = `
   CASE
      WHEN grant_row.revoked_at IS NOT NULL THEN 'revoked'
      WHEN grant_row.begins_at > CURRENT_TIMESTAMP THEN 'scheduled'
      WHEN grant_row.expires_at IS NOT NULL AND grant_row.expires_at <= CURRENT_TIMESTAMP
         THEN 'expired'
      ELSE 'active'
   END`

const enrollmentColumns = `grant_row.id, grant_row.user_id, grant_row.course_id,
   grant_row.granted_by, grant_row.granted_at, grant_row.begins_at, grant_row.expires_at,
   grant_row.revoked_at, grant_row.revoked_by, ${stateSql} AS state`

const moduleGrantColumns = `grant_row.id, grant_row.user_id, grant_row.course_id,
   grant_row.module_id, grant_row.granted_by, grant_row.granted_at, grant_row.begins_at,
   grant_row.expires_at, grant_row.revoked_at, grant_row.revoked_by, ${stateSql} AS state`

const enrollmentStates = ['active', 'scheduled', 'expired', 'revoked']

async function findCourseForShare(courseId, client) {
   const result = await client.query(
      'SELECT id, status FROM courses WHERE id = $1 FOR SHARE',
      [normalizeInternalId(courseId)],
   )
   return result.rows[0] || null
}

async function findCourseStatus(courseId, db = pool) {
   const result = await db.query(
      'SELECT id, status FROM courses WHERE id = $1',
      [normalizeInternalId(courseId)],
   )
   return result.rows[0] || null
}

async function findGranteeForShare(userId, client) {
   const result = await client.query(
      `SELECT account.id, account.status,
         EXISTS (
            SELECT 1 FROM user_roles AS membership
            JOIN roles AS role ON role.id = membership.role_id
            WHERE membership.user_id = account.id AND role.code = 'student'
         ) AS is_student
       FROM users AS account WHERE account.id = $1 FOR SHARE OF account`,
      [normalizeInternalId(userId)],
   )
   return result.rows[0] || null
}

async function findEnrollmentForUpdate(courseId, userId, client) {
   const result = await client.query(
      `SELECT ${enrollmentColumns}
       FROM course_enrollments AS grant_row
       WHERE grant_row.course_id = $1 AND grant_row.user_id = $2
       FOR UPDATE`,
      [normalizeInternalId(courseId), normalizeInternalId(userId)],
   )
   return result.rows[0] || null
}

async function findEnrollment(courseId, userId, db = pool) {
   const result = await db.query(
      `SELECT ${enrollmentColumns}
       FROM course_enrollments AS grant_row
       WHERE grant_row.course_id = $1 AND grant_row.user_id = $2`,
      [normalizeInternalId(courseId), normalizeInternalId(userId)],
   )
   return result.rows[0] || null
}

async function insertEnrollment(enrollment, client) {
   const result = await client.query(
      `INSERT INTO course_enrollments (user_id, course_id, granted_by, begins_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, course_id) DO NOTHING
       RETURNING id`,
      [
         normalizeInternalId(enrollment.userId),
         normalizeInternalId(enrollment.courseId),
         normalizeInternalId(enrollment.actorId),
         enrollment.beginsAt,
         enrollment.expiresAt,
      ],
   )
   return result.rows[0] || null
}

async function regrantEnrollment(enrollmentId, enrollment, client) {
   const result = await client.query(
      `UPDATE course_enrollments SET
         granted_by = $2, granted_at = CURRENT_TIMESTAMP, begins_at = $3, expires_at = $4,
         revoked_at = NULL, revoked_by = NULL
       WHERE id = $1 AND revoked_at IS NOT NULL
       RETURNING id`,
      [
         normalizeInternalId(enrollmentId),
         normalizeInternalId(enrollment.actorId),
         enrollment.beginsAt,
         enrollment.expiresAt,
      ],
   )
   return result.rows[0] || null
}

async function updateEnrollmentExpiry(enrollmentId, expiresAt, client) {
   const result = await client.query(
      `UPDATE course_enrollments SET expires_at = $2
       WHERE id = $1 AND revoked_at IS NULL
       RETURNING id`,
      [normalizeInternalId(enrollmentId), expiresAt],
   )
   return result.rows[0] || null
}

async function revokeEnrollment(enrollmentId, actorId, client) {
   const result = await client.query(
      `UPDATE course_enrollments SET revoked_at = CURRENT_TIMESTAMP, revoked_by = $2
       WHERE id = $1 AND revoked_at IS NULL
       RETURNING id`,
      [normalizeInternalId(enrollmentId), normalizeInternalId(actorId)],
   )
   return result.rows[0] || null
}

async function revokeActiveModuleGrantsForEnrollment(courseId, userId, actorId, client) {
   const result = await client.query(
      `UPDATE module_access_grants SET revoked_at = CURRENT_TIMESTAMP, revoked_by = $3
       WHERE course_id = $1 AND user_id = $2 AND revoked_at IS NULL
       RETURNING id`,
      [
         normalizeInternalId(courseId),
         normalizeInternalId(userId),
         normalizeInternalId(actorId),
      ],
   )
   return result.rowCount
}

async function listEnrollments(courseId, { limit, offset, state }, db = pool) {
   if (state !== null && !enrollmentStates.includes(state)) {
      throw new TypeError('Enrollment state filter is invalid')
   }
   const result = await db.query(
      `SELECT * FROM (
         SELECT ${enrollmentColumns}, profile.first_name, profile.last_name
         FROM course_enrollments AS grant_row
         LEFT JOIN user_profiles AS profile ON profile.user_id = grant_row.user_id
         WHERE grant_row.course_id = $1
       ) AS listed
       WHERE $2::text IS NULL OR listed.state = $2
       ORDER BY listed.granted_at DESC, listed.id DESC
       LIMIT $3 OFFSET $4`,
      [normalizeInternalId(courseId), state, limit + 1, offset],
   )
   return result.rows
}

async function findModuleForShare(courseId, moduleId, client) {
   const result = await client.query(
      `SELECT id, course_id, status FROM course_modules
       WHERE id = $1 AND course_id = $2 FOR SHARE`,
      [normalizeInternalId(moduleId), normalizeInternalId(courseId)],
   )
   return result.rows[0] || null
}

async function findModuleGrantForUpdate(userId, moduleId, courseId, client) {
   const result = await client.query(
      `SELECT ${moduleGrantColumns}
       FROM module_access_grants AS grant_row
       WHERE grant_row.user_id = $1 AND grant_row.module_id = $2 AND grant_row.course_id = $3
       FOR UPDATE`,
      [
         normalizeInternalId(userId),
         normalizeInternalId(moduleId),
         normalizeInternalId(courseId),
      ],
   )
   return result.rows[0] || null
}

async function insertModuleGrant(grant, client) {
   const result = await client.query(
      `INSERT INTO module_access_grants
         (user_id, course_id, module_id, granted_by, begins_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, module_id) DO NOTHING
       RETURNING id`,
      [
         normalizeInternalId(grant.userId),
         normalizeInternalId(grant.courseId),
         normalizeInternalId(grant.moduleId),
         normalizeInternalId(grant.actorId),
         grant.beginsAt,
         grant.expiresAt,
      ],
   )
   return result.rows[0] || null
}

async function regrantModuleGrant(grantId, grant, client) {
   const result = await client.query(
      `UPDATE module_access_grants SET
         granted_by = $2, granted_at = CURRENT_TIMESTAMP, begins_at = $3, expires_at = $4,
         revoked_at = NULL, revoked_by = NULL
       WHERE id = $1 AND revoked_at IS NOT NULL
       RETURNING id`,
      [
         normalizeInternalId(grantId),
         normalizeInternalId(grant.actorId),
         grant.beginsAt,
         grant.expiresAt,
      ],
   )
   return result.rows[0] || null
}

async function updateModuleGrantExpiry(grantId, expiresAt, client) {
   const result = await client.query(
      `UPDATE module_access_grants SET expires_at = $2
       WHERE id = $1 AND revoked_at IS NULL
       RETURNING id`,
      [normalizeInternalId(grantId), expiresAt],
   )
   return result.rows[0] || null
}

async function revokeModuleGrant(grantId, actorId, client) {
   const result = await client.query(
      `UPDATE module_access_grants SET revoked_at = CURRENT_TIMESTAMP, revoked_by = $2
       WHERE id = $1 AND revoked_at IS NULL
       RETURNING id`,
      [normalizeInternalId(grantId), normalizeInternalId(actorId)],
   )
   return result.rows[0] || null
}

async function findModuleGrant(userId, moduleId, courseId, db = pool) {
   const result = await db.query(
      `SELECT ${moduleGrantColumns}
       FROM module_access_grants AS grant_row
       WHERE grant_row.user_id = $1 AND grant_row.module_id = $2 AND grant_row.course_id = $3`,
      [
         normalizeInternalId(userId),
         normalizeInternalId(moduleId),
         normalizeInternalId(courseId),
      ],
   )
   return result.rows[0] || null
}

async function listModuleGrants(courseId, userId, db = pool) {
   const result = await db.query(
      `SELECT ${moduleGrantColumns}, module.title AS module_title
       FROM module_access_grants AS grant_row
       JOIN course_modules AS module
         ON module.id = grant_row.module_id AND module.course_id = grant_row.course_id
       WHERE grant_row.course_id = $1 AND grant_row.user_id = $2
       ORDER BY module.position, grant_row.id`,
      [normalizeInternalId(courseId), normalizeInternalId(userId)],
   )
   return result.rows
}

// The learner-facing reads below return only published structure and the learner's own
// grants. Whether protected content is granted is decided by the database predicate.
// Card metadata counts published modules and published lessons inside published modules,
// the same structure a learner already sees in locked module and lesson metadata.
const learnerCardColumns = `
   CASE WHEN subject.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', subject.id::text,
      'color', subject.color,
      'title', (SELECT title FROM subject_translations
         WHERE subject_id = subject.id AND language_code = subject.primary_language),
      'translations', COALESCE((
         SELECT jsonb_object_agg(language_code, jsonb_build_object('title', title))
         FROM subject_translations WHERE subject_id = subject.id
      ), '{}'::jsonb)
   ) END AS subject,
   (SELECT count(*)::integer FROM course_modules AS counted_module
      WHERE counted_module.course_id = course.id AND counted_module.status = 'published')
      AS module_count,
   (SELECT count(*)::integer FROM lessons AS counted_lesson
      JOIN course_modules AS lesson_module ON lesson_module.id = counted_lesson.module_id
      WHERE counted_lesson.course_id = course.id AND counted_lesson.status = 'published'
         AND lesson_module.status = 'published')
      AS lesson_count`
async function listLearnerCourses(userId, db = pool) {
   const result = await db.query(
      `SELECT course.title, course.description, course.language_code,
         course.translations, course.cover_asset_id,
         ${enrollmentColumns}, ${learnerCardColumns}
       FROM course_enrollments AS grant_row
       JOIN courses AS course ON course.id = grant_row.course_id
       LEFT JOIN subjects AS subject ON subject.id = course.subject_id
       WHERE grant_row.user_id = $1 AND grant_row.revoked_at IS NULL
         AND course.status = 'published'
       ORDER BY course.title, course.id`,
      [normalizeInternalId(userId)],
   )
   return result.rows
}

async function findLearnerCourse(userId, courseId, db = pool) {
   const result = await db.query(
      `SELECT course.title, ${enrollmentColumns}, ${learnerCardColumns}
       FROM course_enrollments AS grant_row
       JOIN courses AS course ON course.id = grant_row.course_id
       LEFT JOIN subjects AS subject ON subject.id = course.subject_id
       WHERE grant_row.user_id = $1 AND grant_row.course_id = $2
         AND grant_row.revoked_at IS NULL AND course.status = 'published'`,
      [normalizeInternalId(userId), normalizeInternalId(courseId)],
   )
   return result.rows[0] || null
}

async function listLearnerModules(userId, courseId, db = pool) {
   const result = await db.query(
      `SELECT module.id, module.position, module.title, module.description, module.translations,
         can_access_module($1, module.id) AS granted,
         COALESCE((SELECT onboarding_completed_at IS NOT NULL FROM users WHERE id = $1), false)
            AS onboarded,
         (module_grant.id IS NOT NULL AND module_grant.revoked_at IS NULL) AS has_grant,
         COALESCE(module_grant.begins_at > CURRENT_TIMESTAMP, false) AS grant_scheduled,
         COALESCE(module_grant.expires_at <= CURRENT_TIMESTAMP, false) AS grant_expired
       FROM course_modules AS module
       LEFT JOIN module_access_grants AS module_grant
         ON module_grant.module_id = module.id AND module_grant.user_id = $1
       WHERE module.course_id = $2 AND module.status = 'published'
       ORDER BY module.position, module.id`,
      [normalizeInternalId(userId), normalizeInternalId(courseId)],
   )
   return result.rows
}

async function canAccessModule(userId, moduleId, db = pool) {
   const result = await db.query(
      'SELECT can_access_module($1, $2) AS granted',
      [normalizeInternalId(userId), normalizeInternalId(moduleId)],
   )
   return result.rows[0].granted === true
}

export {
   canAccessModule,
   enrollmentStates,
   findCourseForShare,
   findCourseStatus,
   findEnrollment,
   findEnrollmentForUpdate,
   findGranteeForShare,
   findLearnerCourse,
   findModuleForShare,
   findModuleGrant,
   findModuleGrantForUpdate,
   insertEnrollment,
   insertModuleGrant,
   listEnrollments,
   listLearnerCourses,
   listLearnerModules,
   listModuleGrants,
   regrantEnrollment,
   regrantModuleGrant,
   revokeActiveModuleGrantsForEnrollment,
   revokeEnrollment,
   revokeModuleGrant,
   updateEnrollmentExpiry,
   updateModuleGrantExpiry,
}
