---
project: EVEREST Backend
current_milestone: M11 fixes (lesson completion guard, staff passed)
status: awaiting_review
branch: fix/lesson-completion-and-staff-passed
base_commit: f97c639
updated_at: 2026-11-08
---

# Current handoff

## Findings (from the code)

- The player could complete a lesson with `test_id`: `completed: true` on a lesson without a video, or 90% watched on a video lesson. Both bypassed the rule that only the test result completes it. Fixed with `409 LESSON_COMPLETES_BY_TEST`; watch progress still saves.
- Staff attempts had `passPercent` but no `passed`. Added, from the single `attemptPassed` in `utils/attempt-policy.js`.

## Verification (2026-11-08)

- `npm test` with `DB_NAME` on a fresh migrated disposable database: exit 0; 343 tests, 342 passed, 0 failed, 1 skipped (real S3). No migration, so `test:migrations` was not run.
- `everest_db` was not touched.

## Not verified

- A frontend that still shows a "mark as done" button for lessons with a test.
- Completions that students already got through the old bypass are kept. They were not searched for or cleaned.

## Decisions needed

- Mixed lesson (video and test): completion is by the test only (strictest). If the owner wants both 90% watched and a passed test, the rule in `completeTestLessons` must change.
- Whether to reset completions obtained through the old bypass. Nothing was reset.

## Next concrete task

1. Review and merge this branch.
2. Run `npm run migrate:up` on the local `everest_db`.
3. Start M12 after the metric definitions are confirmed.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit applied migrations. Never merge, force-push, or push to `main`.
- Point `DB_NAME` at a disposable database for `npm test`. Never delete data in `everest_db`.
