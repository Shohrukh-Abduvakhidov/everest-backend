---
project: EVEREST Backend
current_milestone: M13
status: planned
branch: main
base_commit: f4bb6f6
updated_at: 2026-11-25
---

# Current handoff

## Course/module progress fix (branch `fix/course-progress-pg-errors-subject-code`, not merged, not deployed)

- **Built:** module `progress` in `GET /courses/:id/modules` (same rule as the course); completion of test lessons missed by the 2026-11-07 rule (on lesson link, and `npm run recompute:test-lessons`, dry run by default); pg integrity errors → 400/409 with stable codes; `subject.code` / `subjectCode` for icons. No migration. Details: `docs/decisions.md` 2026-11-25, `docs/api.md`, `docs/frontend-handoff.md` → "Module and course progress".
- **Verified:** `npm test` 642/642 (disposable database); recompute dry run on local `everest_db`: 1 completion (lesson 197, user 2240).
- **After merge (operator):** deploy; run `npm run recompute:test-lessons` (dry run) on the server, review, then `--apply` after a backup. Frontend: use `module.progress` for the module bar.

## M12 is Done (PR 3 merged in PR #64, not deployed)

- **Built in PR 3:** `GET /admin/groups/:groupId/progress`, `GET /admin/courses/:courseId/progress`, `GET /admin/users/:userId/analytics`, `GET /admin/users/:userId/attempts` (`progress.read`) and `GET /admin/tests/:testId/assignments/:assignmentId/results` (`tests.results.read`); D1 scope with 404 outside it; D5 reasons. No migration. Contract: `docs/frontend-handoff.md` → "Staff progress"; decisions 2026-11-19.
- **Follow-ups of 2026-11-20 (merged):** #65 caches the `pg_timezone_names` list for `/me/home` (24 h, `src/utils/time-zone-cache.js`; Intl was rejected because it disagrees with PostgreSQL); #66 adds `GET /me/staff-capabilities` (roles, `allAccess` for owner/admin, per-course and per-group flags; 403 `ACCOUNT_NOT_ACTIVE` for an inactive account, empty lists for a student; contract and flag→screen table in `docs/frontend-handoff.md`); #67 adds safe spacing rules and a hand-listed hyphen join to `scripts/fix-question-text.js` (lists in `scripts/question-text-plan.js`; questions 1907, 1917, 1102, 904, 956, 291 are never changed automatically). No migration in any of them.
- **Verified (before merge):** disposable-database suite 513 (#65), 520 (#66), 531 (#67, after merging main); `verify-database.js` valid (41 migrations). Details in `docs/progress.md` (2026-11-19 and 2026-11-20). This handoff PR changed documentation only and ran no tests.
- **Not verified:** the screens in the frontend; anything on the server (PRs #63 to #67 are not deployed); the fix-question-text dry run was done on local `everest_db` only (42 rows in 24 questions), never `--apply`.
- **After merge (operator):** deploy the backend (no migration, no new env). Then, optionally, `backup-db.sh predeploy`, dry run and `--apply --log` of `fix-question-text.js` on the server; review the dry run first.

## Refresh resilience (merged in PR #62, deployed 2026-11-19)

- **Built:** 30 s grace window for a replayed refresh token (new pair in the same session, original refresh expiry, audit `auth.refresh.grace_reissued`); per-session refresh limit (`refresh.session`, 20) and separate per-IP limits for refresh (2000) and password login (1000); refresh cookies cleared only on 401. New env: `AUTH_REFRESH_REUSE_GRACE_SECONDS`, `AUTH_REFRESH_SESSION_RATE_LIMIT`, `AUTH_REFRESH_IP_RATE_LIMIT`, `AUTH_LOGIN_IP_RATE_LIMIT`. No migration. Details: `docs/progress.md`, `docs/decisions.md` (2026-11-19), `docs/api.md`.
- **Verified:** disposable-database suite 491/491 (twice); `verify-database.js` valid.
- **Not verified:** a real client on a lossy network; the server.
- **After merge (operator):** deploy the backend; the defaults apply without env changes.

## Question text repair (merged, applied on the server 2026-11-19: 2 rows)

- **Built:** `src/utils/question-text-audit.js` (pure checks and two certain repairs); the package adapter repairs a letter stranded between matching `columnHeaders` and a capital cut off a short item, and warns `CONTENT_SPLIT_WORD_REPAIRED` / `CONTENT_SPLIT_WORD_SUSPECTED`; `scripts/audit-question-text.js` (read-only report); `scripts/fix-question-text.js` (`--dry-run`, `--apply --log`, `--rollback`). No migration. Details: `docs/progress.md` (2026-11-19), decision: `docs/decisions.md` (2026-11-19).
- **Verified:** disposable-database suite 484/484; `test:sources`, `test:integrity` exit 0; `verify-database.js` valid; apply, rollback, re-apply and refusals on a disposable copy of `everest_db`.
- **Not verified:** `--apply` on local `everest_db` (not run).

## M12 PR 2 (merged in PR #59, deployed 2026-11-19)

- **Built:** `GET /me/analytics` (totals, first attempts, strong/weak topics by D4 and D6); pure formulas in `src/utils/learning-metrics.js`; contract in `docs/frontend-handoff.md` → "Student home", `docs/api.md`, OpenAPI. No migration. `scripts/verify-database.js` matches the catalog again (separate commit).
- **Verified:** disposable-database suite 475/475; `test:migrations`, `test:sources`, `test:integrity`, `test:server` exit 0; `verify-database.js` valid on a fresh database.
- **Not verified:** HTTP routes with cookies; anything on the server.

## M12 PR 1 (merged in PR #58, deployed 2026-11-19)

- **Built:** activity events (`watch_hour`, `lesson_completed`, `attempt_finished`) written in the action's transaction; `GET /me/home`; `GET /me/attempts`; permission `progress.read` (owner, admin, teacher; no route uses it yet); migration `20261116010000000` (two indexes, one-time backfill of completions and finished attempts). Contract for the frontend: `docs/frontend-handoff.md` → "Student home"; decisions D1–D7: `docs/decisions.md` (2026-11-16).
- **Verified:** disposable-database suite 463/463 (exit 0), `test:migrations` 41/41/40/41, `test:sources`, `test:integrity`, `test:server` exit 0, EXPLAIN on 1000 students under 4 ms.
- **Not verified:** HTTP routes with cookies; `migrate:up` on `everest_db` and the server; the real-storage test (skipped on purpose).

## Server state (2026-11-14)

- Backend `b075da1` (PRs up to #56) and frontend `c394e67` (PR #41) are deployed on the temporary VPS; this branch is not. Details: `docs/progress.md` → "Temporary VPS deployment".
- Not verified there: a real lesson video in a browser (upload, seek, offline); an interrupted multi-GB upload resumed.

## Next concrete task

1. Deploy PRs #63 to #67 (no migration). The frontend can build the teacher screens (staff progress, rights) from `docs/frontend-handoff.md`.
2. M13 group ranking needs the owner's approved formula (decision first, then code). M10 stays open until its two listed deliverables are built or dropped.
3. A teacher still has to fix 1907 and 1917 (stem rebuilt from the book) and review the remaining findings of `audit-question-text.js`.
4. Known gaps: `scripts/verify-database.js` counts must be updated with every migration; `tests/integration/real-storage.test.js` keeps the test process alive for hours (close the S3 client).
5. Operations, not code: stage 2c hardening, off-site backups, alerts, k6 load test, `docker builder prune` only with the owner's approval.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit applied migrations. Never merge, force-push, or push to `main`.
- Point `DB_NAME` at a disposable database for `npm test`. Never delete data in `everest_db`.
- On the server touch only the `everest` compose project and `everest-*` nginx files; reload, never restart nginx.
- Never commit `import-packages/` or `docs/deploy-plan.md`.
