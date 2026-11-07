---
project: EVEREST Backend
current_milestone: M11 teacher permission for extra attempts
status: awaiting_review
branch: feat/teacher-grant-permission
base_commit: 200d9e1
updated_at: 2026-11-08
---

# Current handoff

## State

- Extra attempts (PR #38) are merged. This branch binds `tests.attempts.grant` to the `teacher` role (migration `20261108010000000`). The group scope was already in `grantScopeSql`; decisions.md, 2026-11-08, records how scope is computed.

## Verification (2026-11-08)

- `npm test` on a fresh migrated disposable database: exit 0; 339 tests, 338 passed, 0 failed, 1 skipped (real S3).
- `npm run test:migrations`: 33 / 33 / 32 / 33. `verify-database.js` valid (86 bindings, 14 for teacher).
- `everest_db` was not touched. It needs `npm run migrate:up` (now 3 behind: the two M11 extra-attempt migrations and this one).

## Not verified

- A frontend grant dialog.
- Cookie-session CSRF on the grant `POST` (tests use Bearer).
- Load and wider concurrency.

## Decisions needed

None open.

## Next concrete task

1. Review and merge this branch, then run `npm run migrate:up` on the local `everest_db`.
2. Start M12 (learning progress and analytics) after the metric definitions are confirmed.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit applied migrations. Never merge, force-push, or push to `main`.
- Point `DB_NAME` at a disposable database for `npm test`. Never delete data in `everest_db`.
