import pool from '../configs/db.js'
import { normalizeInternalId } from '../utils/internal-id.js'

const learnerLessonColumns = `lesson.id, lesson.module_id, lesson.course_id, lesson.title,
   lesson.position, lesson.lesson_type, lesson.content, lesson.translations,
   lesson.video_asset_id, lesson.allow_offline,
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
   updated_at, revision`

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
   ]
   if (progress.revision === 0) {
      const inserted = await db.query(
         `INSERT INTO lesson_progress
            (user_id, lesson_id, status, playback_seconds, watched_seconds, completed_at, revision)
          VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 THEN CURRENT_TIMESTAMP END, $7 + 1)
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
         updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND lesson_id = $2 AND revision = $7
       RETURNING ${progressColumns}`,
      values,
   )
   return updated.rows[0] || null
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

export {
   addFavorite,
   countNotes,
   createNote,
   deleteNote,
   findLearnerLesson,
   findProgress,
   hasLearnerCourse,
   listFavorites,
   listLearnerModuleLessons,
   listNotes,
   lockUser,
   removeFavorite,
   updateNote,
   writeProgress,
}
