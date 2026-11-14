---
project: EVEREST Backend
current_milestone: M12
status: in_progress
branch: feat/m12-student-analytics
base_commit: 49e9c16
updated_at: 2026-11-14
---

# Current handoff

## M12 PR 2 (branch `feat/m12-student-analytics`, awaiting review)

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

1. Review and merge PR 2. Deploy PR 1 and PR 2 together (`migrate:up` for `20261116010000000`, then `deploy.sh backend`).
2. M12 PR 3: staff group and course summaries with the "behind" reasons (D5), visibility by D1/D2, plus the group-closing index with its queries.
3. Known gaps: `scripts/verify-database.js` counts must be updated with every migration; `tests/integration/real-storage.test.js` keeps the test process alive for hours (close the S3 client).
4. Operations, not code: stage 2c hardening, off-site backups, alerts, k6 load test, `docker builder prune` only with the owner's approval.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit applied migrations. Never merge, force-push, or push to `main`.
- Point `DB_NAME` at a disposable database for `npm test`. Never delete data in `everest_db`.
- On the server touch only the `everest` compose project and `everest-*` nginx files; reload, never restart nginx.
- Never commit `import-packages/` or `docs/deploy-plan.md`.
