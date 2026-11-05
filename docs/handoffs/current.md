---
project: EVEREST Backend
current_milestone: M11 attempts, timing and grading
status: awaiting_review
branch: feat/m11-attempts
base_commit: 3c2f96c
updated_at: 2026-11-05
---

# Current handoff

## State

- `feat/m11-attempts` (PR #35) has a PR open for review; the agent must not merge it.
- PR #34 is merged; this branch was rebased onto it and both progress entries are kept.
- The review decisions are applied: group-teacher result scope, `tests.results.regrade`, keys held back while attempts remain, running attempts survive revocation.

## Completed work

- Migrations `20261105030000000_add-attempt-timing.js` (`test_assignments.personal_window_minutes`, `attempts_expiring_idx`) and `20261105040000000_add-results-regrade-permission.js`.
- Learner: assignments list, start or resume, attempt, autosave, submit, results. Staff: attempts list, detail, regrade.
- Grading of all five types, result and reveal policies, `npm run worker:attempts`, lesson attempt state, seeded attempts.

## Verification (2026-11-05)

- `npm test` with `DB_NAME` on a disposable migrated database: exit 0; 316 tests, 315 passed, 0 failed, 1 skipped (real S3 storage, unconfigured).
- `npm run test:migrations` passed the up, no-op, down, up cycle on a disposable database. `verify-database.js` passed.
- `everest_db` was not touched and has no migration `20261105030000000`.

## Not verified

- A frontend or browser walk-through.
- `npm run worker:attempts` as a separate process with signals; the loop was tested in-process.
- Load, and concurrency beyond parallel starts of one student.
- Cookie-session CSRF on the new mutations; the tests use Bearer tokens.

## Decisions needed

None open. Choices made unattended are in `docs/decisions.md`, 2026-11-05 M11.

## Next concrete tasks

1. Review and merge. Then run `migrate:up` on the local database, which is on 28 of 30 migrations once this merges.
2. Start the sweep worker under PM2.
3. M12: learning progress and analytics.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit applied migrations. Never merge, force-push, or push to `main`.
- `npm test` uses the configured database for `test:integrity`; point `DB_NAME` at a disposable database. Never delete data in `everest_db`.
