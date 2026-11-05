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

- `feat/m11-attempts` has a PR open for review; the agent must not merge it.
- PR #34 (`fix/auth-login-diagnosis`) was still open when this branch started, so this branch lacks it. Expect a conflict in this file and `docs/progress.md`.

## Completed work

- Migration `20261105030000000_add-attempt-timing.js`: `test_assignments.personal_window_minutes`, `attempts_expiring_idx`.
- Learner: assignments list, start or resume, attempt, autosave, submit, results. Staff: attempts list, detail, regrade.
- Grading of all five types, result and reveal policies, `npm run worker:attempts`, lesson attempt state, seeded attempts.

## Not verified

- A frontend or browser walk-through.
- `npm run worker:attempts` as a separate process with signals; the loop was tested in-process.
- Load, and concurrency beyond parallel starts of one student.
- Cookie-session CSRF on the new mutations; the tests use Bearer tokens.

## Decisions needed

See `docs/decisions.md`, 2026-11-05 M11, in particular matching scoring, group teacher result scope, regrade under a read permission, and `after_submission` reveal when attempts remain.

## Next concrete tasks

1. Review and merge. Then run `migrate:up` on the local database, which is on 28 of 29 migrations once this merges.
2. Start the sweep worker under PM2.
3. M12: learning progress and analytics.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit applied migrations. Never merge, force-push, or push to `main`.
- `npm test` uses the configured database for `test:integrity`; point `DB_NAME` at a disposable database. Never delete data in `everest_db`.
