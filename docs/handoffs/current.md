---
project: EVEREST Backend
current_milestone: M12
status: in_progress
branch: feat/m12-staff-progress
base_commit: 141ee10
updated_at: 2026-11-19
---

# Current handoff

## M12 PR 3: staff progress views (branch `feat/m12-staff-progress`, awaiting review)

- **Built:** `GET /admin/groups/:groupId/progress`, `GET /admin/courses/:courseId/progress`, `GET /admin/users/:userId/analytics`, `GET /admin/users/:userId/attempts` (`progress.read`) and `GET /admin/tests/:testId/assignments/:assignmentId/results` (`tests.results.read`); D1 scope with 404 outside it; D5 reasons. No migration. Contract: `docs/frontend-handoff.md` → "Staff progress"; decisions 2026-11-19.
- **Verified:** see `docs/progress.md` (2026-11-19, M12 PR 3).
- **Not verified:** the screens in the frontend; the server (not deployed).
- **After merge:** deploy the backend (no migration, no new env); the frontend can build the teacher screens from the handoff contract. M12 is Done once this PR is merged.

## Refresh resilience (merged in PR #62, deployed 2026-11-19)

- **Built:** 30 s grace window for a replayed refresh token (new pair in the same session, original refresh expiry, audit `auth.refresh.grace_reissued`); per-session refresh limit (`refresh.session`, 20) and separate per-IP limits for refresh (2000) and password login (1000); refresh cookies cleared only on 401. New env: `AUTH_REFRESH_REUSE_GRACE_SECONDS`, `AUTH_REFRESH_SESSION_RATE_LIMIT`, `AUTH_REFRESH_IP_RATE_LIMIT`, `AUTH_LOGIN_IP_RATE_LIMIT`. No migration. Details: `docs/progress.md`, `docs/decisions.md` (2026-11-19), `docs/api.md`.
- **Verified:** disposable-database suite 491/491 (twice); `verify-database.js` valid.
- **Not verified:** a real client on a lossy network; the server.
- **After merge (operator):** deploy the backend; the defaults apply without env changes.

## Question text repair (branch `fix/question-text-split-letters`, awaiting review)

- **Built:** `src/utils/question-text-audit.js` (pure checks and two certain repairs); the package adapter repairs a letter stranded between matching `columnHeaders` and a capital cut off a short item, and warns `CONTENT_SPLIT_WORD_REPAIRED` / `CONTENT_SPLIT_WORD_SUSPECTED`; `scripts/audit-question-text.js` (read-only report); `scripts/fix-question-text.js` (`--dry-run`, `--apply --log`, `--rollback`). No migration. Details: `docs/progress.md` (2026-11-19), decision: `docs/decisions.md` (2026-11-19).
- **Verified:** disposable-database suite 484/484; `test:sources`, `test:integrity` exit 0; `verify-database.js` valid; apply, rollback, re-apply and refusals on a disposable copy of `everest_db`.
- **Not verified:** `--apply` on local `everest_db` (not run; permission check); anything on the server.
- **After merge (operator):** deploy the backend image, `backup-db.sh predeploy`, dry run, then `--apply --log` through the compose `migrate` service (commands in the PR). 51 findings in 30 questions remain for a teacher; 1907 and 1917 need the stem rebuilt from the book.

## M12 PR 2 (merged in PR #59, not deployed)

- **Built:** `GET /me/analytics` (totals, first attempts, strong/weak topics by D4 and D6); pure formulas in `src/utils/learning-metrics.js`; contract in `docs/frontend-handoff.md` → "Student home", `docs/api.md`, OpenAPI. No migration. `scripts/verify-database.js` matches the catalog again (separate commit).
- **Verified:** disposable-database suite 475/475; `test:migrations`, `test:sources`, `test:integrity`, `test:server` exit 0; `verify-database.js` valid on a fresh database.
- **Not verified:** HTTP routes with cookies; anything on the server.

## M12 PR 1 (merged in PR #58, not deployed)

- **Built:** activity events (`watch_hour`, `lesson_completed`, `attempt_finished`) written in the action's transaction; `GET /me/home`; `GET /me/attempts`; permission `progress.read` (owner, admin, teacher; no route uses it yet); migration `20261116010000000` (two indexes, one-time backfill of completions and finished attempts). Contract for the frontend: `docs/frontend-handoff.md` → "Student home"; decisions D1–D7: `docs/decisions.md` (2026-11-16).
- **Verified:** disposable-database suite 463/463 (exit 0), `test:migrations` 41/41/40/41, `test:sources`, `test:integrity`, `test:server` exit 0, EXPLAIN on 1000 students under 4 ms.
- **Not verified:** HTTP routes with cookies; `migrate:up` on `everest_db` and the server; the real-storage test (skipped on purpose).
- **After merge (operator):** `migrate:up` on the server through the compose `migrate` service, then `deploy.sh backend`. The week view fills from this release on (watch time has no history).

## Server state (2026-11-14)

- Backend `b075da1` (PRs up to #56) and frontend `c394e67` (PR #41) are deployed on the temporary VPS; this branch is not. Details: `docs/progress.md` → "Temporary VPS deployment".
- Not verified there: a real lesson video in a browser (upload, seek, offline); an interrupted multi-GB upload resumed.

## Next concrete task

1. Review and merge the question text repair. Deploy PR 1 and PR 2 together (`migrate:up` for `20261116010000000`, then `deploy.sh backend`).
2. M12 PR 3: staff group and course summaries with the "behind" reasons (D5), visibility by D1/D2, plus the group-closing index with its queries.
3. Known gaps: `scripts/verify-database.js` counts must be updated with every migration; `tests/integration/real-storage.test.js` keeps the test process alive for hours (close the S3 client).
4. Operations, not code: stage 2c hardening, off-site backups, alerts, k6 load test, `docker builder prune` only with the owner's approval.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit applied migrations. Never merge, force-push, or push to `main`.
- Point `DB_NAME` at a disposable database for `npm test`. Never delete data in `everest_db`.
- On the server touch only the `everest` compose project and `everest-*` nginx files; reload, never restart nginx.
- Never commit `import-packages/` or `docs/deploy-plan.md`.
