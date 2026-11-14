---
project: EVEREST Backend
current_milestone: M12
status: planned
branch: docs/roadmap-sync-deploy
base_commit: b075da1
updated_at: 2026-11-14
---

# Current handoff

## State

- Backend `main` up to PR #56 and frontend `main` up to PR #41 are merged and deployed on the temporary VPS (sslip.io hosts, database `everest_prod`). Details and checks: `docs/progress.md` → "Temporary VPS deployment".
- This branch only synchronizes `ROADMAP.md`, `docs/progress.md`, `docs/frontend-handoff.md` §6–7 and this handoff with that state. No code.

## Verified on the server (2026-11-14)

- Migrations `20261114010000000` and `20261115010000000` applied; `/health` and `/ready` 200; all containers healthy; no errors in logs.
- `worker-attempts` has storage configured (upload sweep on, PR #56); `storage:configure` applied the 3-day abort rule and CORS.
- Signed GET through nginx/SeaweedFS: `206`, `Accept-Ranges`, `Content-Range`, `Cache-Control`; preflight for GET with Range and part PUT pass for the app origin only; TLS valid on app, api, files.

## Not verified

- A real lesson video upload, playback, seeking and offline download in a browser (no video in the bucket yet).
- An interrupted and resumed multi-GB upload through the browser.
- SeaweedFS ignores `If-Range` (`206` on an ETag mismatch); harmless while object keys are immutable.

## Next concrete task

1. Merge this PR.
2. M12 PR 1 from `main`: indexes and permission `progress.read` (one migration), `learning_activity_events` writes, `GET /me/home`, `GET /me/attempts`, decisions D1–D7 in `docs/decisions.md`, contract in `docs/api.md`, OpenAPI and `docs/frontend-handoff.md`.
3. Then PR 2 (`GET /me/analytics`) and PR 3 (staff group/course summaries and student analytics).
4. Operations, not code: stage 2c hardening, off-site backups (B2), alerts and monitoring, k6 load test, `docker builder prune` only with the owner's approval.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit applied migrations. Never merge, force-push, or push to `main`.
- Point `DB_NAME` at a disposable database for `npm test`. Never delete data in `everest_db`.
- On the server touch only the `everest` compose project and `everest-*` nginx files; reload, never restart nginx.
- Never commit `import-packages/` or `docs/deploy-plan.md`.
