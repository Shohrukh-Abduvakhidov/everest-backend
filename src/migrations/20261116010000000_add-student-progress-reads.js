// M12 PR 1: read support for the student home page and the staff progress views.
// - permission progress.read for owner, admin and teacher (resource scope is applied by the services);
// - indexes for "my latest lessons" and "my finished attempts" (checked with EXPLAIN on 1000 students);
// - learning_activity_events gets its first writers, so earlier completions are backfilled once
//   (lesson_completed from lesson_progress, attempt_finished from test_attempts) under the same
//   idempotent source_event_key the application uses. Watch time has no history to backfill.
// The table had no writers before, so down removes every row of the three event codes.
export const up = pgm => {
   pgm.sql(`
INSERT INTO permissions (code, description)
VALUES ('progress.read', 'Read learning progress and results of students in scope');

INSERT INTO role_permissions (role_id, permission_id)
SELECT role.id, permission.id
FROM roles AS role
CROSS JOIN permissions AS permission
WHERE role.code IN ('owner', 'admin', 'teacher') AND permission.code = 'progress.read';

CREATE INDEX lesson_progress_user_updated_idx ON lesson_progress (user_id, updated_at DESC);
CREATE INDEX test_attempts_user_finished_idx ON test_attempts (user_id, submitted_at DESC)
    WHERE status IN ('graded', 'expired');

INSERT INTO learning_activity_events (user_id, lesson_id, event_code, source_event_key, occurred_at)
SELECT progress.user_id, progress.lesson_id, 'lesson_completed',
    'lesson_completed:' || progress.lesson_id, progress.completed_at
FROM lesson_progress AS progress
WHERE progress.completed_at IS NOT NULL
ON CONFLICT (user_id, source_event_key) DO NOTHING;

INSERT INTO learning_activity_events (user_id, attempt_id, event_code, source_event_key, occurred_at, metadata)
SELECT attempt.user_id, attempt.id, 'attempt_finished', 'attempt_finished:' || attempt.id,
    COALESCE(attempt.submitted_at, attempt.graded_at),
    jsonb_build_object('testId', attempt.test_id::text, 'status', attempt.status)
FROM test_attempts AS attempt
WHERE attempt.status IN ('graded', 'expired') AND COALESCE(attempt.submitted_at, attempt.graded_at) IS NOT NULL
ON CONFLICT (user_id, source_event_key) DO NOTHING;
   `)
}

export const down = pgm => {
   pgm.sql(`
DELETE FROM learning_activity_events
WHERE event_code IN ('lesson_completed', 'attempt_finished', 'watch_hour');

DROP INDEX test_attempts_user_finished_idx;
DROP INDEX lesson_progress_user_updated_idx;

DELETE FROM role_permissions
WHERE permission_id = (SELECT id FROM permissions WHERE code = 'progress.read');
DELETE FROM permissions WHERE code = 'progress.read';
   `)
}
