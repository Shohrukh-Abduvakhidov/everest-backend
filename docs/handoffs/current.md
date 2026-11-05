---
project: EVEREST Backend
current_milestone: login failure diagnosis
status: awaiting_review
branch: fix/auth-login-diagnosis
base_commit: 3c2f96c
updated_at: 2026-11-05
---

# Current handoff

## State

- PR #33 is merged. `fix/auth-login-diagnosis` has a PR open for review; the agent must not merge it.

## Completed work

- Login failure traced to configuration and data: the running API used `everest_demo2`, not the `everest_db` in `.env`, so accounts and passwords from other databases failed and then hit the `login.account` block.
- `src/server.js` now rejects startup on listen errors and logs the database name.
- `scripts/check-auth-setup.js` and frontend handoff section 5.4.

## Verification (2026-11-05)

- Disposable database, migrate plus seed: owner and student `200`, wrong password `401 INVALID_CREDENTIALS`, blocked account `403 ACCOUNT_NOT_ACTIVE`, phone without `+` `400 VALIDATION_ERROR`.
- `test:server` failed without the fix and passed with it. `test:auth`: 282 tests, 281 passed, 0 failed, 1 skipped. `test:sources` passed.

## Not verified

- A browser login, and the frontend's API target and cookie handling.
- Which passwords were typed. Failures show only that verification returned false.
- `test:integrity`, which uses the configured database.

## Next concrete tasks

1. Stop the server on port 4000, set the intended `DB_NAME`, restart, and read the database name in the startup line.
2. `everest_demo` is missing the two newest migrations; run `migrate:up` there if it stays in use.
3. Handoff tasks from before remain: `migrate:up` state review on `everest_db`, then M11.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit applied migrations. Never merge, force-push, or push to `main`.
- Never delete data in `everest_db`.
