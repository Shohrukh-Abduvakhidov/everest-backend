import pool from '../configs/db.js'
import { normalizeInternalId } from '../utils/internal-id.js'

const administratorSql = `
   EXISTS (
      SELECT 1 FROM user_roles AS membership
      JOIN roles AS role ON role.id = membership.role_id
      WHERE membership.user_id = $1 AND role.code IN ('owner', 'admin')
   )`

const lessonColumns = `lesson.id, lesson.module_id, lesson.course_id, lesson.title,
   lesson.position, lesson.lesson_type, lesson.content, lesson.translations,
   lesson.video_asset_id, lesson.allow_offline, lesson.status, lesson.created_by,
   lesson.created_at, lesson.updated_at`

const assetColumns = `asset.id, asset.kind, asset.mime_type, asset.file_name, asset.size_bytes,
   asset.width_px, asset.height_px, asset.duration_seconds, asset.status,
   asset.processing_status, asset.storage_key`

function ids(values) {
   return values.map(normalizeInternalId)
}

// Staff scope. Owner/admin see every course; a teacher sees only assigned courses and
// manages lessons only with can_manage_lessons. Returns null when the course is missing
// or outside the actor's scope, so both cases produce the same 404.
async function findCourseScope(userId, courseId, db = pool) {
   const result = await db.query(
      `SELECT course.id, course.status,
         ${administratorSql} AS administrator,
         COALESCE(assignment.can_manage_lessons, false) AS can_manage_lessons
       FROM courses AS course
       LEFT JOIN course_teachers AS assignment
         ON assignment.course_id = course.id AND assignment.user_id = $1
       WHERE course.id = $2 AND (${administratorSql} OR assignment.id IS NOT NULL)`,
      [normalizeInternalId(userId), normalizeInternalId(courseId)],
   )
   return result.rows[0] || null
}

async function findManageableCourseForUpdate(userId, courseId, client) {
   const result = await client.query(
      `SELECT course.id, course.status
       FROM courses AS course
       LEFT JOIN course_teachers AS assignment
         ON assignment.course_id = course.id AND assignment.user_id = $1
       WHERE course.id = $2 AND (${administratorSql} OR assignment.can_manage_lessons)
       FOR UPDATE OF course`,
      [normalizeInternalId(userId), normalizeInternalId(courseId)],
   )
   return result.rows[0] || null
}

async function findModule(courseId, moduleId, db = pool) {
   const result = await db.query(
      'SELECT id, course_id, status FROM course_modules WHERE id = $1 AND course_id = $2',
      [normalizeInternalId(moduleId), normalizeInternalId(courseId)],
   )
   return result.rows[0] || null
}

async function findModuleForUpdate(courseId, moduleId, client) {
   const result = await client.query(
      `SELECT id, course_id, status FROM course_modules
       WHERE id = $1 AND course_id = $2 FOR UPDATE`,
      [normalizeInternalId(moduleId), normalizeInternalId(courseId)],
   )
   return result.rows[0] || null
}

async function listModuleLessons(moduleId, db = pool) {
   const result = await db.query(
      `SELECT ${lessonColumns} FROM lessons AS lesson
       WHERE lesson.module_id = $1 ORDER BY lesson.position, lesson.id`,
      [normalizeInternalId(moduleId)],
   )
   return result.rows
}

async function findLesson(courseId, lessonId, db = pool) {
   const result = await db.query(
      `SELECT ${lessonColumns} FROM lessons AS lesson
       WHERE lesson.id = $1 AND lesson.course_id = $2`,
      [normalizeInternalId(lessonId), normalizeInternalId(courseId)],
   )
   return result.rows[0] || null
}

async function findLessonForUpdate(courseId, lessonId, client) {
   const result = await client.query(
      `SELECT ${lessonColumns} FROM lessons AS lesson
       WHERE lesson.id = $1 AND lesson.course_id = $2 FOR UPDATE`,
      [normalizeInternalId(lessonId), normalizeInternalId(courseId)],
   )
   return result.rows[0] || null
}

async function findNextLessonPosition(moduleId, client) {
   const result = await client.query(
      'SELECT COALESCE(max(position), 0) + 1 AS position FROM lessons WHERE module_id = $1',
      [normalizeInternalId(moduleId)],
   )
   return result.rows[0].position
}

async function createLesson(lesson, client) {
   const result = await client.query(
      `INSERT INTO lessons AS lesson
         (module_id, course_id, title, position, lesson_type, content, translations,
          video_asset_id, allow_offline, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft', $10)
       RETURNING ${lessonColumns}`,
      [
         normalizeInternalId(lesson.moduleId),
         normalizeInternalId(lesson.courseId),
         lesson.title,
         lesson.position,
         lesson.lessonType,
         lesson.content,
         lesson.translations,
         lesson.videoAssetId,
         lesson.allowOffline,
         normalizeInternalId(lesson.actorId),
      ],
   )
   return result.rows[0]
}

async function updateLesson(lessonId, changes, client) {
   const result = await client.query(
      `UPDATE lessons AS lesson SET
         title = COALESCE($2, title),
         lesson_type = COALESCE($3, lesson_type),
         content = CASE WHEN $4 THEN $5 ELSE content END,
         translations = CASE WHEN $6 THEN $7 ELSE translations END,
         video_asset_id = CASE WHEN $8 THEN $9 ELSE video_asset_id END,
         allow_offline = COALESCE($10, allow_offline),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING ${lessonColumns}`,
      [
         normalizeInternalId(lessonId),
         changes.title,
         changes.lessonType,
         changes.hasContent,
         changes.content,
         changes.hasTranslations,
         changes.translations,
         changes.hasVideoAssetId,
         changes.videoAssetId,
         changes.allowOffline,
      ],
   )
   return result.rows[0]
}

async function updateLessonStatus(lessonId, status, client) {
   const result = await client.query(
      `UPDATE lessons AS lesson SET status = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING ${lessonColumns}`,
      [normalizeInternalId(lessonId), status],
   )
   return result.rows[0]
}

// A lesson is empty when nothing refers to it: no video, chapters, materials, learner
// state, offline licenses, activity or test assignments.
async function lessonIsEmpty(lessonId, client) {
   const result = await client.query(
      `SELECT lesson.video_asset_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM lesson_video_chapters WHERE lesson_id = lesson.id)
         AND NOT EXISTS (SELECT 1 FROM lesson_resources WHERE lesson_id = lesson.id)
         AND NOT EXISTS (SELECT 1 FROM lesson_progress WHERE lesson_id = lesson.id)
         AND NOT EXISTS (SELECT 1 FROM lesson_notes WHERE lesson_id = lesson.id)
         AND NOT EXISTS (SELECT 1 FROM offline_downloads WHERE lesson_id = lesson.id)
         AND NOT EXISTS (SELECT 1 FROM learning_activity_events WHERE lesson_id = lesson.id)
         AND NOT EXISTS (SELECT 1 FROM test_assignments WHERE lesson_id = lesson.id) AS empty
       FROM lessons AS lesson WHERE lesson.id = $1`,
      [normalizeInternalId(lessonId)],
   )
   return result.rows[0]?.empty === true
}

async function deleteLesson(lessonId, client) {
   await client.query('DELETE FROM lessons WHERE id = $1', [normalizeInternalId(lessonId)])
}

async function listLessonIdsForUpdate(moduleId, client) {
   const result = await client.query(
      `SELECT id FROM lessons WHERE module_id = $1 ORDER BY position, id FOR UPDATE`,
      [normalizeInternalId(moduleId)],
   )
   return result.rows.map((row) => row.id)
}

async function applyLessonOrder(moduleId, lessonIds, client) {
   const normalizedModuleId = normalizeInternalId(moduleId)
   // Two passes, as for modules: move every row clear of the target range first so the
   // row-by-row UNIQUE (module_id, position) check never collides.
   await client.query(
      `UPDATE lessons SET position = position + (
          SELECT max(position) FROM lessons WHERE module_id = $1
       )
       WHERE module_id = $1`,
      [normalizedModuleId],
   )
   await client.query(
      `UPDATE lessons AS lesson SET position = ordered.position, updated_at = CURRENT_TIMESTAMP
       FROM unnest($2::bigint[]) WITH ORDINALITY AS ordered(id, position)
       WHERE lesson.module_id = $1 AND lesson.id = ordered.id`,
      [normalizedModuleId, ids(lessonIds)],
   )
}

async function listChapters(lessonIds, db = pool) {
   const result = await db.query(
      `SELECT id, lesson_id, start_seconds, title, translations, position
       FROM lesson_video_chapters WHERE lesson_id = ANY($1::bigint[])
       ORDER BY lesson_id, position`,
      [ids(lessonIds)],
   )
   return result.rows
}

async function replaceChapters(lessonId, chapters, client) {
   const normalizedLessonId = normalizeInternalId(lessonId)
   await client.query('DELETE FROM lesson_video_chapters WHERE lesson_id = $1', [normalizedLessonId])
   if (!chapters.length) return
   await client.query(
      `INSERT INTO lesson_video_chapters (lesson_id, start_seconds, title, translations, position)
       SELECT $1, chapter.start_seconds, chapter.title, chapter.translations, chapter.position
       FROM jsonb_to_recordset($2::jsonb)
          AS chapter(start_seconds integer, title text, translations jsonb, position integer)`,
      [normalizedLessonId, JSON.stringify(chapters.map((chapter, index) => ({
         start_seconds: chapter.startSeconds,
         title: chapter.title,
         translations: chapter.translations,
         position: index + 1,
      })))],
   )
}

async function listResources(lessonIds, db = pool) {
   const result = await db.query(
      `SELECT resource.id AS resource_id, resource.lesson_id, resource.title AS resource_title,
         resource.position, ${assetColumns}
       FROM lesson_resources AS resource
       JOIN assets AS asset ON asset.id = resource.asset_id
       WHERE resource.lesson_id = ANY($1::bigint[])
       ORDER BY resource.lesson_id, resource.position, resource.id`,
      [ids(lessonIds)],
   )
   return result.rows
}

async function replaceResources(lessonId, resources, client) {
   const normalizedLessonId = normalizeInternalId(lessonId)
   await client.query('DELETE FROM lesson_resources WHERE lesson_id = $1', [normalizedLessonId])
   if (!resources.length) return
   await client.query(
      `INSERT INTO lesson_resources (lesson_id, asset_id, title, position)
       SELECT $1, resource.asset_id, resource.title, resource.position
       FROM jsonb_to_recordset($2::jsonb)
          AS resource(asset_id bigint, title text, position integer)`,
      [normalizedLessonId, JSON.stringify(resources.map((resource, index) => ({
         asset_id: resource.assetId,
         title: resource.title,
         position: index + 1,
      })))],
   )
}

// An asset belongs to a course when it was uploaded for that course, or when the given
// lesson already references it (a copied course keeps referencing the source assets).
async function findCourseAsset(assetId, courseId, lessonId, db = pool) {
   const result = await db.query(
      `SELECT ${assetColumns},
         (EXISTS (SELECT 1 FROM asset_uploads AS upload
                  WHERE upload.asset_id = asset.id AND upload.course_id = $2)
          OR EXISTS (SELECT 1 FROM lessons AS lesson
                     WHERE lesson.id = $3 AND lesson.video_asset_id = asset.id)
          OR EXISTS (SELECT 1 FROM lesson_resources AS resource
                     WHERE resource.lesson_id = $3 AND resource.asset_id = asset.id))
            AS in_course
       FROM assets AS asset WHERE asset.id = $1`,
      [
         normalizeInternalId(assetId),
         normalizeInternalId(courseId),
         lessonId === null ? null : normalizeInternalId(lessonId),
      ],
   )
   return result.rows[0] || null
}

async function findAsset(assetId, db = pool) {
   const result = await db.query(
      `SELECT ${assetColumns} FROM assets AS asset WHERE asset.id = $1`,
      [normalizeInternalId(assetId)],
   )
   return result.rows[0] || null
}

function pairs(map) {
   return [[...map.keys()].map(normalizeInternalId), [...map.values()].map(normalizeInternalId)]
}

async function copyLessons(moduleIdMap, targetCourseId, actorId, client) {
   if (!moduleIdMap.size) return []
   const [sources, targets] = pairs(moduleIdMap)
   const result = await client.query(
      `WITH module_pair AS (
         SELECT * FROM unnest($1::bigint[], $2::bigint[]) AS pair(source_id, target_id)
       ), copied AS (
         INSERT INTO lessons
            (module_id, course_id, title, position, lesson_type, content, translations,
             video_asset_id, allow_offline, status, created_by)
         SELECT module_pair.target_id, $3, lesson.title, lesson.position, lesson.lesson_type,
            lesson.content, lesson.translations, lesson.video_asset_id, lesson.allow_offline,
            'draft', $4
         FROM lessons AS lesson
         JOIN module_pair ON module_pair.source_id = lesson.module_id
         RETURNING id, module_id, position
       )
       SELECT source.id AS source_id, copied.id AS target_id
       FROM copied
       JOIN module_pair ON module_pair.target_id = copied.module_id
       JOIN lessons AS source
         ON source.module_id = module_pair.source_id AND source.position = copied.position`,
      [sources, targets, normalizeInternalId(targetCourseId), normalizeInternalId(actorId)],
   )
   return result.rows
}

async function copyChapters(lessonIdMap, client) {
   if (!lessonIdMap.size) return 0
   const [sources, targets] = pairs(lessonIdMap)
   const result = await client.query(
      `INSERT INTO lesson_video_chapters (lesson_id, start_seconds, title, translations, position)
       SELECT pair.target_id, chapter.start_seconds, chapter.title, chapter.translations,
          chapter.position
       FROM lesson_video_chapters AS chapter
       JOIN unnest($1::bigint[], $2::bigint[]) AS pair(source_id, target_id)
         ON pair.source_id = chapter.lesson_id`,
      [sources, targets],
   )
   return result.rowCount
}

async function copyResources(lessonIdMap, client) {
   if (!lessonIdMap.size) return 0
   const [sources, targets] = pairs(lessonIdMap)
   const result = await client.query(
      `INSERT INTO lesson_resources (lesson_id, asset_id, title, position)
       SELECT pair.target_id, resource.asset_id, resource.title, resource.position
       FROM lesson_resources AS resource
       JOIN unnest($1::bigint[], $2::bigint[]) AS pair(source_id, target_id)
         ON pair.source_id = resource.lesson_id`,
      [sources, targets],
   )
   return result.rowCount
}

export {
   applyLessonOrder,
   copyChapters,
   copyLessons,
   copyResources,
   createLesson,
   deleteLesson,
   findAsset,
   findCourseAsset,
   findCourseScope,
   findLesson,
   findLessonForUpdate,
   findManageableCourseForUpdate,
   findModule,
   findModuleForUpdate,
   findNextLessonPosition,
   lessonIsEmpty,
   listChapters,
   listLessonIdsForUpdate,
   listModuleLessons,
   listResources,
   replaceChapters,
   replaceResources,
   updateLesson,
   updateLessonStatus,
}
