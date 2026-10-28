import pool from '../configs/db.js'
import { normalizeInternalId } from '../utils/internal-id.js'

const moduleColumns = `id, course_id, title, description, position, translations,
   status, created_at`

async function listModulePreview(courseId, db = pool) {
   const result = await db.query(
      `SELECT module.id, module.title, module.description, module.position, module.status,
         (SELECT count(*)::int FROM lessons AS lesson
           WHERE lesson.module_id = module.id) AS lessons_count,
         (SELECT count(DISTINCT assignment.test_id)::int
           FROM test_assignments AS assignment
           JOIN lessons AS lesson ON lesson.id = assignment.lesson_id
           WHERE lesson.module_id = module.id) AS tests_count
       FROM course_modules AS module
       WHERE module.course_id = $1
       ORDER BY module.position, module.id`,
      [normalizeInternalId(courseId)],
   )
   return result.rows
}

async function findNextModulePosition(courseId, client) {
   const result = await client.query(
      'SELECT COALESCE(max(position), 0) + 1 AS position FROM course_modules WHERE course_id = $1',
      [normalizeInternalId(courseId)],
   )
   return result.rows[0].position
}

async function createModule(module, client) {
   const result = await client.query(
      `INSERT INTO course_modules (course_id, title, description, position, translations, status)
       VALUES ($1, $2, $3, $4, $5, 'draft')
       RETURNING ${moduleColumns}`,
      [
         normalizeInternalId(module.courseId),
         module.title,
         module.description,
         module.position,
         module.translations,
      ],
   )
   return result.rows[0]
}

async function findModuleForUpdate(courseId, moduleId, client) {
   const result = await client.query(
      `SELECT ${moduleColumns}
       FROM course_modules
       WHERE id = $1 AND course_id = $2
       FOR UPDATE`,
      [normalizeInternalId(moduleId), normalizeInternalId(courseId)],
   )
   return result.rows[0] || null
}

async function updateModule(moduleId, changes, client) {
   const result = await client.query(
      `UPDATE course_modules SET
         title = COALESCE($2, title),
         description = CASE WHEN $3 THEN $4 ELSE description END,
         translations = CASE WHEN $5 THEN $6 ELSE translations END
       WHERE id = $1
       RETURNING ${moduleColumns}`,
      [
         normalizeInternalId(moduleId),
         changes.title,
         changes.hasDescription,
         changes.description,
         changes.hasTranslations,
         changes.translations,
      ],
   )
   return result.rows[0]
}

async function updateModuleStatus(moduleId, status, client) {
   const result = await client.query(
      `UPDATE course_modules SET status = $2
       WHERE id = $1
       RETURNING ${moduleColumns}`,
      [normalizeInternalId(moduleId), status],
   )
   return result.rows[0]
}

async function moduleHasLessons(moduleId, client) {
   const result = await client.query(
      'SELECT EXISTS (SELECT 1 FROM lessons WHERE module_id = $1) AS has_lessons',
      [normalizeInternalId(moduleId)],
   )
   return result.rows[0].has_lessons
}

async function deleteModule(moduleId, client) {
   const result = await client.query(
      'DELETE FROM course_modules WHERE id = $1 RETURNING id',
      [normalizeInternalId(moduleId)],
   )
   return result.rowCount > 0
}

async function listModuleIdsForUpdate(courseId, client) {
   const result = await client.query(
      `SELECT id FROM course_modules
       WHERE course_id = $1
       ORDER BY position, id
       FOR UPDATE`,
      [normalizeInternalId(courseId)],
   )
   return result.rows.map((row) => row.id)
}

async function applyModuleOrder(courseId, moduleIds, client) {
   const normalizedCourseId = normalizeInternalId(courseId)
   // Pass one moves every row above the current maximum so pass two cannot collide
   // with UNIQUE (course_id, position), which is checked row by row.
   await client.query(
      `UPDATE course_modules
       SET position = position + (
          SELECT max(position) FROM course_modules WHERE course_id = $1
       )
       WHERE course_id = $1`,
      [normalizedCourseId],
   )
   const result = await client.query(
      `UPDATE course_modules AS module
       SET position = ordered.position
       FROM unnest($2::bigint[]) WITH ORDINALITY AS ordered(id, position)
       WHERE module.course_id = $1 AND module.id = ordered.id
       RETURNING module.id, module.position`,
      [normalizedCourseId, moduleIds.map(normalizeInternalId)],
   )
   return result.rows
}

async function listModules(courseId, client) {
   const result = await client.query(
      `SELECT ${moduleColumns}
       FROM course_modules
       WHERE course_id = $1
       ORDER BY position, id`,
      [normalizeInternalId(courseId)],
   )
   return result.rows
}

async function findCourseForShare(courseId, client) {
   const result = await client.query(
      `SELECT id, subject_id, title, description, language_code, translations,
         cover_asset_id, status, created_by, created_at, updated_at
       FROM courses WHERE id = $1 FOR SHARE`,
      [normalizeInternalId(courseId)],
   )
   return result.rows[0] || null
}

async function createCourseCopy(source, copy, client) {
   const result = await client.query(
      `INSERT INTO courses
         (subject_id, title, description, language_code, translations,
          cover_asset_id, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7)
       RETURNING id, subject_id, title, description, language_code, translations,
         cover_asset_id, status, created_by, created_at, updated_at`,
      [
         source.subject_id,
         copy.title,
         source.description,
         source.language_code,
         source.translations,
         source.cover_asset_id,
         normalizeInternalId(copy.actorId),
      ],
   )
   return result.rows[0]
}

async function copyModules(sourceCourseId, targetCourseId, client) {
   const result = await client.query(
      `WITH copied AS (
         INSERT INTO course_modules
            (course_id, title, description, position, translations, status)
         SELECT $2, title, description, position, translations, 'draft'
         FROM course_modules
         WHERE course_id = $1
         RETURNING id, position
       )
       SELECT source.id AS source_id, copied.id AS target_id
       FROM copied
       JOIN course_modules AS source
         ON source.course_id = $1 AND source.position = copied.position
       ORDER BY copied.position`,
      [normalizeInternalId(sourceCourseId), normalizeInternalId(targetCourseId)],
   )
   return result.rows
}

export {
   applyModuleOrder,
   copyModules,
   createCourseCopy,
   createModule,
   deleteModule,
   findCourseForShare,
   findModuleForUpdate,
   findNextModulePosition,
   listModuleIdsForUpdate,
   listModulePreview,
   listModules,
   moduleHasLessons,
   updateModule,
   updateModuleStatus,
}
