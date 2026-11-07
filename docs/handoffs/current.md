---
project: EVEREST Backend
current_milestone: M11 extra attempts per student
status: awaiting_review
branch: feat/m11-extra-attempts
base_commit: cce7ef6
updated_at: 2026-11-07
---

# Current handoff

## Findings before editing (from the code)

- The limit is `tests.max_attempts`, selected as `assignment.max_attempts`. Attempts are unique by (`assignment_id`, `user_id`, `attempt_number`) and are counted per assignment by `attemptsUsed` and `remainingAttempts` (cancelled attempts excluded).
- `createNewAttempt` refuses with `ATTEMPTS_EXHAUSTED` under the per-student advisory lock `lockAttemptSlot`.
- `policy_snapshot.maxAttempts` (the test's limit at start) drives `remainingAttempts` in `readResult`, and so the `after_submission` reveal. Live `max_attempts` drives the learner list, the lesson summary and the assignment result.
- Regrade: permission migration `20261105040000000` (owner, admin), route `POST /admin/tests/:testId/attempts/:attemptId/regrade` with CSRF and the admin rate limit, `idempotency_key UNIQUE`, audit `test.attempt_regraded`.

## State

Implemented on `feat/m11-extra-attempts`: two migrations, the grant and read endpoints, and the effective limit everywhere. The owner's rules and the choices made here are in `docs/decisions.md`, 2026-11-07, "Extra attempts".

## Verification (2026-11-07)

- `npm test` with `DB_NAME` on a fresh migrated disposable database: exit 0; 339 tests, 338 passed, 0 failed, 1 skipped (real S3).
- `npm run test:migrations`: 32 / 32 / 31 / 32.
- `verify-database.js`: valid, after its stale permission counts were corrected.
- `everest_db` was not touched; it needs `migrate:up` for the two new migrations.

## Not verified

- Frontend screens for granting.
- Teachers holding `tests.attempts.grant` in a real role setup. Scope was tested by giving teachers the permission for the length of one subtest.
- Cookie-session CSRF on the new `POST`; the tests use Bearer tokens.
- Parallel grant and start under load beyond five concurrent requests.

## Decisions needed

- Should teachers hold `tests.attempts.grant`? The request said both "same roles as regrade" (owner, admin) and "group teachers for their group". Today only owner and admin hold it; the group scope is already enforced if teachers are given it.
- Accept that a grant hides already revealed `after_submission` keys again until the extra attempts are used?

## Next concrete task

1. Review and merge `feat/m11-extra-attempts`. Then run `npm run migrate:up` on the local `everest_db`.
2. Answer the teacher-permission question. If yes, add a migration that grants `tests.attempts.grant` to `teacher`.
3. Then start M12, after the metric definitions are confirmed.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit applied migrations. Never merge, force-push, or push to `main`.
- Point `DB_NAME` at a disposable database for `npm test`. Never delete data in `everest_db`.
