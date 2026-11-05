---
project: EVEREST Backend
current_milestone: lesson-test link and HTTP question import
status: awaiting_review
branch: feat/lesson-tests-and-import
base_commit: 2486068
updated_at: 2026-11-05
---

# Current handoff

## State

- PR #32 (demo content) is merged into `main`.
- `feat/lesson-tests-and-import` has a PR open for review; the agent must not merge it.

## Completed work

- Migrations `20261105010000000_add-lesson-test-links.js` (`lessons.test_id`, `tests.module_id`) and `20261105020000000_add-question-import-uploads.js`.
- `test` and `mixed` lessons link a same-course test and can be published; learner lessons return a safe summary; archive and delete of linked tests return `409 TEST_LINKED_TO_LESSON`; course copy reports `clearedTestLinks`; the seed publishes 4 linked test lessons.
- `POST /admin/question-imports/packages`, `GET .../:uploadId`, `POST .../:uploadId/confirm`, worker `npm run worker:imports`, `applyMatchingDefaults` (HTTP and CLI), total unpacked ZIP limit.

## Verification (2026-11-05)

- `npm run test:auth` (disposable database): 282 tests, 281 passed, 0 failed, 1 skipped (real S3 storage, unconfigured). `test:server`, `test:sources` and `test:migrations` passed.
- `test:integrity` and `verify-database.js` passed against a migrated disposable database.
- `npm test` as one command stops at `test:integrity` on this machine: that script uses the configured local database, which has no M10 column. `migrate:up` was deliberately not run on it.

## Not verified

- Real S3/MinIO for package images (a memory storage double was used).
- Large packages: the upload is buffered in memory, and no test ran near the 256 MiB limit. A real book package was not uploaded.
- `npm run worker:imports` as a process with signals; the loop function was tested in-process.
- A frontend walk-through of the new flows.

## Not done

- Cancel or delete of an upload (it expires instead), a list of uploads, presigned upload.
- Retry after a lost worker (a new `idempotencyKey` is needed).
- A bulk endpoint for matching rules on existing questions (the import option covers drafts).
- API for duplicate links (handoff gap 13) and inline rich content (gap 11).
- Any use of `tests.module_id` at attempt start (M11).

## Decisions needed

1. M11: does `tests.module_id` require a module grant at start, and what about tests without a module?
2. Should the worker run inside the API process, or stay a separate PM2 process?
3. Multi-host deployment would need packages in shared storage instead of local disk.
4. NCT rules, still refused as a mode.

## Next concrete tasks

1. Review and merge the PR, then run `migrate:up` on the local database (it needs a check of existing `tests` rows first, see M10) and start the worker.
2. M11: attempts, autosave and grading.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit applied migrations. Never merge, force-push, or push to `main`.
- `npm test` runs in a disposable database except `test:integrity`, which uses the configured database; never delete data in `everest_db`.
