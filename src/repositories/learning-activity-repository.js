import pool from '../configs/db.js'
import { normalizeInternalId } from '../utils/internal-id.js'

// Idempotent: the same source_event_key of one user is recorded once. Written inside the
// transaction of the action it describes.
async function recordActivityEvent(event, db = pool) {
   const result = await db.query(
      `INSERT INTO learning_activity_events
         (user_id, lesson_id, attempt_id, event_code, source_event_key, occurred_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (user_id, source_event_key) DO NOTHING
       RETURNING id`,
      [
         normalizeInternalId(event.userId),
         event.lessonId === undefined || event.lessonId === null ? null : normalizeInternalId(event.lessonId),
         event.attemptId === undefined || event.attemptId === null ? null : normalizeInternalId(event.attemptId),
         event.code,
         event.sourceEventKey,
         event.occurredAt,
         JSON.stringify(event.metadata || {}),
      ],
   )
   return result.rowCount === 1
}

// Watch time accumulates in one row per user, lesson and UTC hour (key watch:{lessonId}:{hour}).
// Hours keep day boundaries exact for whole-hour time zones. Only the growth of unique watched
// time is added, so repeated reports never count the same seconds twice.
async function addWatchSeconds({ userId, lessonId, seconds, at }, db = pool) {
   if (!(seconds > 0)) return
   const hour = new Date(at)
   hour.setUTCMinutes(0, 0, 0)
   await db.query(
      `INSERT INTO learning_activity_events
         (user_id, lesson_id, event_code, source_event_key, occurred_at, metadata)
       VALUES ($1, $2, 'watch_hour', $3, $4, jsonb_build_object('seconds', $5::integer))
       ON CONFLICT (user_id, source_event_key) DO UPDATE SET
         metadata = jsonb_build_object(
            'seconds', COALESCE((learning_activity_events.metadata ->> 'seconds')::integer, 0) + $5::integer)`,
      [
         normalizeInternalId(userId),
         normalizeInternalId(lessonId),
         `watch:${normalizeInternalId(lessonId)}:${hour.toISOString().slice(0, 13)}`,
         hour,
         Math.round(seconds),
      ],
   )
}

export { addWatchSeconds, recordActivityEvent }
