---
project: EVEREST Backend
current_milestone: M11 gaps (lesson completion, passPercent, history, testId, course progress)
status: awaiting_review
branch: feat/m11-gaps
base_commit: 3bdeed7
updated_at: 2026-11-07
---

# Current handoff

## Findings before editing (confirmed in code on 2026-11-07)

1. **Lesson completion after a test: gap.** `lesson_progress` was written only by `learner-lesson-repository.writeProgress` (the player). `finalizeAttempt` and `regradeAttemptService` did not touch it. The test → lesson link is `lessons.test_id` only. `test_assignments.lesson_id` exists in the schema, but no code writes it (`test-repository` inserts group and user audiences only).
2. **passPercent in results: gap.** `readResult` returned `percent` and `passed` without `passPercent`; staff `safeStaffAttempt` had neither.
3. **History after revocation: partial gap.** `GET /tests/attempts/:id` and `/result` already read through `findAttempt` (owner only, no assignment status). These were lost after revocation: `GET /courses/:courseId/test-assignments` (`status = 'active'`), `GET /tests/assignments/:id/result` (`404`) and the lesson's `test.attempts` summary.
4. **testId in lesson lists: gap.** `safeLearnerLessonSummary` had no `testId`. Only a per-module lesson list exists.
5. **Course progress: gap.** Course list and card had counts only.

## State

- All five items are implemented on `feat/m11-gaps`; nothing was skipped. There is no migration.
- The owner's lesson-completion rule and the choices made here are in `docs/decisions.md`, 2026-11-07.
- PR #36 is open from `feat/m11-gaps` and awaits review. The agent must not merge it.

## Verification (2026-11-07)

- `npm test` with `DB_NAME` on a freshly created and migrated disposable database: exit 0. `test:sources`, `test:integrity` and `test:server` passed. `test:auth`: 330 tests, 329 passed, 0 failed, 1 skipped (real S3, unconfigured). The database was dropped afterwards.
- New: `tests/unit/m11-gaps.test.js` (7) and `tests/integration/m11-gaps.test.js` (6 subtests). They cover owner and stranger, revoked assignment, submit and worker idempotency, `passPercent` null and set, an empty timer close, regrade up and down, no undo of completion, and key or snapshot redaction.
- `npm run test:migrations` was not run because no migration changed. `everest_db` was not touched.

## Not verified

- A frontend or browser walk-through of the new fields.
- `worker:attempts` as a separate PM2 process; the sweep loop was run in-process.
- A change of a test's `passPercent` after an attempt through the API: published tests are immutable, so the snapshot rule is covered by a unit test with doubles only.
- Concurrency of a player `PUT progress` racing a test completion on the same lesson (expected outcome: a `409` revision conflict, not tested).
- Course progress performance on large courses (`can_access_module` is evaluated per lesson row).

## Decisions needed

None blocking. Please review the unattended choices in `docs/decisions.md` (2026-11-07), especially:

- revocation does not reveal keys early;
- leaving a group counts as `revoked`;
- the empty-answer rule applies to `expired` attempts only;
- `0 / 0` progress after an enrollment expires.

## Next concrete tasks

1. Review and merge `feat/m11-gaps`.
2. Run `migrate:up` on the local database if it is still behind (no new migration in this branch).
3. M12: learning progress and analytics.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit applied migrations. Never merge, force-push, or push to `main`.
- `npm test` uses the configured database for `test:integrity`; point `DB_NAME` at a disposable database. Never delete data in `everest_db`.
