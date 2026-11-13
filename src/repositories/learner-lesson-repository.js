import pool from '../configs/db.js'
import { normalizeInternalId } from '../utils/internal-id.js'

const learnerLessonColumns = `lesson.id, lesson.module_id, lesson.course_id, lesson.title,
   lesson.position, lesson.lesson_type, lesson.content, lesson.translations,
   lesson.video_asset_id, lesson.test_id, lesson.allow_offline,
   can_access_module($1, lesson.module_id) AS granted`

// A learner sees lesson metadata only inside a course they hold a non-revoked enrollment
// for, and only when the course, module and lesson are all published.
const learnerVisibilitySql = `
   lesson.status = 'published' AND module.status = 'published' AND course.status = 'published'
   AND EXISTS (
      SELECT 1 FROM course_enrollments AS enrollment
      WHERE enrollment.user_id = $1 AND enrollment.course_id = course.id
         AND enrollment.revoked_at IS NULL
   )`

const noteColumns = 'id, lesson_id, body, playback_seconds, created_at, updated_at'
const progressColumns = `lesson_id, status, playback_seconds, watched_seconds, completed_at,
   updated_at, revision, watched_ranges, last_reported_at,
   EXTRACT(EPOCH FROM CURRENT_TIMESTAMP - last_reported_at)::float8 AS seconds_since_report`

async function listLearnerModuleLessons(userId, courseId, moduleId, db = pool) {
   const result = await db.query(
      `SELECT ${learnerLessonColumns}
       FROM lessons AS lesson
       JOIN course_modules AS module ON module.id = lesson.module_id
       JOIN courses AS course ON course.id = lesson.course_id
       WHERE lesson.course_id = $2 AND lesson.module_id = $3 AND ${learnerVisibilitySql}
       ORDER BY lesson.position, lesson.id`,
      [normalizeInternalId(userId), normalizeInternalId(courseId), normalizeInternalId(moduleId)],
   )
   return result.rows
}

async function findLearnerLesson(userId, courseId, lessonId, db = pool) {
   const result = await db.query(
      `SELECT ${learnerLessonColumns}
       FROM lessons AS lesson
       JOIN course_modules AS module ON module.id = lesson.module_id
       JOIN courses AS course ON course.id = lesson.course_id
       WHERE lesson.course_id = $2 AND lesson.id = $3 AND ${learnerVisibilitySql}`,
      [normalizeInternalId(userId), normalizeInternalId(courseId), normalizeInternalId(lessonId)],
   )
   return result.rows[0] || null
}

// Safe test facts for a lesson. Questions, keys and grading settings are never selected. The
// assignments are the learner's own: direct ones and those of their active group memberships,
// plus, as 'revoked', ones they no longer hold but have attempts on (history only).
async function findLearnerLessonTest(userId, testId, db = pool) {
   const test = await db.query(
      `SELECT test.id, test.title, test.status, test.duration_seconds, test.max_attempts,
         test.result_policy,
         (SELECT count(*)::integer FROM test_questions WHERE test_id = test.id) AS question_count
       FROM tests AS test WHERE test.id = $1`,
      [normalizeInternalId(testId)],
   )
   if (!test.rows[0]) return null
   const assignments = await db.query(
      `SELECT listed.id, listed.opens_at, listed.closes_at,
         CASE
            WHEN NOT listed.available THEN 'revoked'
            WHEN listed.opens_at > CURRENT_TIMESTAMP THEN 'upcoming'
            WHEN listed.closes_at IS NOT NULL AND listed.closes_at <= CURRENT_TIMESTAMP THEN 'closed'
            ELSE 'open'
         END AS state
       FROM (
          SELECT assignment.id, assignment.opens_at, assignment.closes_at,
             (assignment.status = 'active' AND (
                assignment.user_id = $1 OR assignment.group_id IN (
                   SELECT group_id FROM group_members WHERE user_id = $1 AND status = 'active'
                )
             )) AS available
          FROM test_assignments AS assignment
          WHERE assignment.test_id = $2
       ) AS listed
       WHERE listed.available OR EXISTS (
          SELECT 1 FROM test_attempts AS own_attempt
          WHERE own_attempt.assignment_id = listed.id AND own_attempt.user_id = $1
       )`,
      [normalizeInternalId(userId), normalizeInternalId(testId)],
   )
   return { ...test.rows[0], assignments: assignments.rows }
}

async function hasLearnerCourse(userId, courseId, db = pool) {
   const result = await db.query(
      `SELECT EXISTS (
         SELECT 1 FROM course_enrollments AS enrollment
         JOIN courses AS course ON course.id = enrollment.course_id
         WHERE enrollment.user_id = $1 AND enrollment.course_id = $2
            AND enrollment.revoked_at IS NULL AND course.status = 'published'
       ) AS visible`,
      [normalizeInternalId(userId), normalizeInternalId(courseId)],
   )
   return result.rows[0].visible
}

async function listNotes(userId, lessonId, db = pool) {
   const result = await db.query(
      `SELECT ${noteColumns} FROM lesson_notes
       WHERE user_id = $1 AND lesson_id = $2
       ORDER BY playback_seconds NULLS LAST, created_at, id`,
      [normalizeInternalId(userId), normalizeInternalId(lessonId)],
   )
   return result.rows
}

async function countNotes(userId, lessonId, client) {
   const result = await client.query(
      'SELECT count(*)::int AS count FROM lesson_notes WHERE user_id = $1 AND lesson_id = $2',
      [normalizeInternalId(userId), normalizeInternalId(lessonId)],
   )
   return result.rows[0].count
}

async function lockUser(userId, client) {
   await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [normalizeInternalId(userId)])
}

async function createNote(note, client) {
   const result = await client.query(
      `INSERT INTO lesson_notes (user_id, lesson_id, body, playback_seconds)
       VALUES ($1, $2, $3, $4) RETURNING ${noteColumns}`,
      [
         normalizeInternalId(note.userId),
         normalizeInternalId(note.lessonId),
         note.body,
         note.playbackSeconds,
      ],
   )
   return result.rows[0]
}

async function updateNote(userId, lessonId, noteId, changes, db = pool) {
   const result = await db.query(
      `UPDATE lesson_notes SET
         body = COALESCE($4, body),
         playback_seconds = CASE WHEN $5 THEN $6 ELSE playback_seconds END,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 AND user_id = $1 AND lesson_id = $2
       RETURNING ${noteColumns}`,
      [
         normalizeInternalId(userId),
         normalizeInternalId(lessonId),
         normalizeInternalId(noteId),
         changes.body,
         changes.hasPlaybackSeconds,
         changes.playbackSeconds,
      ],
   )
   return result.rows[0] || null
}

async function deleteNote(userId, lessonId, noteId, db = pool) {
   const result = await db.query(
      'DELETE FROM lesson_notes WHERE id = $3 AND user_id = $1 AND lesson_id = $2',
      [normalizeInternalId(userId), normalizeInternalId(lessonId), normalizeInternalId(noteId)],
   )
   return result.rowCount > 0
}

async function findProgress(userId, lessonId, db = pool) {
   const result = await db.query(
      `SELECT ${progressColumns} FROM lesson_progress WHERE user_id = $1 AND lesson_id = $2`,
      [normalizeInternalId(userId), normalizeInternalId(lessonId)],
   )
   return result.rows[0] || null
}

// Optimistic concurrency: the write applies only when the stored revision still equals
// the client's revision (0 when no row exists yet). Returns null on a stale revision.
async function writeProgress(progress, db = pool) {
   const values = [
      normalizeInternalId(progress.userId),
      normalizeInternalId(progress.lessonId),
      progress.status,
      progress.playbackSeconds,
      progress.watchedSeconds,
      progress.completed,
      progress.revision,
      JSON.stringify(progress.watchedRanges || []),
      Boolean(progress.reported),
   ]
   if (progress.revision === 0) {
      const inserted = await db.query(
         `INSERT INTO lesson_progress
            (user_id, lesson_id, status, playback_seconds, watched_seconds, completed_at, revision,
             watched_ranges, last_reported_at)
          VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 THEN CURRENT_TIMESTAMP END, $7 + 1,
             $8::jsonb, CASE WHEN $9 THEN CURRENT_TIMESTAMP END)
          ON CONFLICT (user_id, lesson_id) DO NOTHING
          RETURNING ${progressColumns}`,
         values,
      )
      return inserted.rows[0] || null
   }
   const updated = await db.query(
      `UPDATE lesson_progress SET
         status = $3,
         playback_seconds = $4,
         watched_seconds = GREATEST(watched_seconds, $5),
         completed_at = COALESCE(completed_at, CASE WHEN $6 THEN CURRENT_TIMESTAMP END),
         revision = revision + 1,
         watched_ranges = $8::jsonb,
         last_reported_at = CASE WHEN $9 THEN CURRENT_TIMESTAMP ELSE last_reported_at END,
         updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND lesson_id = $2 AND revision = $7
       RETURNING ${progressColumns}`,
      values,
   )
   return updated.rows[0] || null
}

// Server-side completion of every lesson linked to a test, in the caller's transaction. A row
// that is already completed is left untouched, so retries change neither completed_at nor
// revision. Other rows gain completed status and a new revision, so a stale player write
// gets the usual revision conflict.
async function completeTestLessons({ userId, testId, completedAt }, client) {
   const result = await client.query(
      `INSERT INTO lesson_progress (user_id, lesson_id, status, completed_at, revision, updated_at)
       SELECT $1, lesson.id, 'completed', $3, 1, $3
       FROM lessons AS lesson WHERE lesson.test_id = $2
       ON CONFLICT (user_id, lesson_id) DO UPDATE SET
         status = 'completed',
         completed_at = COALESCE(lesson_progress.completed_at, EXCLUDED.completed_at),
         revision = lesson_progress.revision + 1,
         updated_at = EXCLUDED.updated_at
       WHERE lesson_progress.status <> 'completed'
       RETURNING lesson_id`,
      [normalizeInternalId(userId), normalizeInternalId(testId), completedAt],
   )
   return result.rows.map((row) => row.lesson_id)
}

async function addFavorite(userId, courseId, db = pool) {
   await db.query(
      `INSERT INTO course_favorites (user_id, course_id) VALUES ($1, $2)
       ON CONFLICT (user_id, course_id) DO NOTHING`,
      [normalizeInternalId(userId), normalizeInternalId(courseId)],
   )
}

async function removeFavorite(userId, courseId, db = pool) {
   await db.query(
      'DELETE FROM course_favorites WHERE user_id = $1 AND course_id = $2',
      [normalizeInternalId(userId), normalizeInternalId(courseId)],
   )
}

async function listFavorites(userId, db = pool) {
   const result = await db.query(
      `SELECT course.id, course.title, course.translations, course.cover_asset_id,
         favorite.created_at
       FROM course_favorites AS favorite
       JOIN courses AS course ON course.id = favorite.course_id
       WHERE favorite.user_id = $1 AND course.status = 'published'
         AND EXISTS (
            SELECT 1 FROM course_enrollments AS enrollment
            WHERE enrollment.user_id = $1 AND enrollment.course_id = course.id
               AND enrollment.revoked_at IS NULL
         )
       ORDER BY favorite.created_at DESC, course.id`,
      [normalizeInternalId(userId)],
   )
   return result.rows
}

// Only what the playback watermark shows: first name and the primary phone (masked later).
async function findWatermarkIdentity(userId, db = pool) {
   const result = await db.query(
      `SELECT profile.first_name, phone.phone_e164
       FROM users AS account
       LEFT JOIN user_profiles AS profile ON profile.user_id = account.id
       LEFT JOIN LATERAL (
          SELECT owned_phone.phone_e164 FROM user_phones AS owned_phone
          WHERE owned_phone.user_id = account.id
          ORDER BY owned_phone.is_primary DESC, owned_phone.created_at, owned_phone.id
          LIMIT 1
       ) AS phone ON TRUE
       WHERE account.id = $1`,
      [normalizeInternalId(userId)],
   )
   return result.rows[0] || null
}

// Staff summary of one lesson: every learner with a current enrollment in the course, with
// their progress if any. Only the name is selected; no phone, username or contact data.
async function listLessonProgressSummary(courseId, lessonId, db = pool) {
   const result = await db.query(
      `SELECT enrollment.user_id, profile.first_name, profile.last_name,
         can_access_module(enrollment.user_id, lesson.module_id) AS has_access,
         COALESCE(progress.status, 'not_started') AS status,
         COALESCE(progress.playback_seconds, 0) AS playback_seconds,
         COALESCE(progress.watched_seconds, 0) AS watched_seconds,
         COALESCE(progress.watched_ranges, '[]'::jsonb) AS watched_ranges,
         progress.completed_at, progress.updated_at
       FROM lessons AS lesson
       JOIN course_enrollments AS enrollment
         ON enrollment.course_id = lesson.course_id AND enrollment.revoked_at IS NULL
       LEFT JOIN user_profiles AS profile ON profile.user_id = enrollment.user_id
       LEFT JOIN lesson_progress AS progress
         ON progress.user_id = enrollment.user_id AND progress.lesson_id = lesson.id
       WHERE lesson.course_id = $1 AND lesson.id = $2
       ORDER BY profile.first_name, profile.last_name, enrollment.user_id
       LIMIT 2000`,
      [normalizeInternalId(courseId), normalizeInternalId(lessonId)],
   )
   return result.rows
}

export {
   addFavorite,
   completeTestLessons,
   countNotes,
   createNote,
   deleteNote,
   findLearnerLesson,
   findLearnerLessonTest,
   findProgress,
   findWatermarkIdentity,
   hasLearnerCourse,
   listFavorites,
   listLearnerModuleLessons,
   listLessonProgressSummary,
   listNotes,
   lockUser,
   removeFavorite,
   updateNote,
   writeProgress,
}
