---
project: EVEREST Backend
current_milestone: Video player backend
status: awaiting_review
branch: feature/video-player-backend
base_commit: 7b2929d
updated_at: 2026-11-15
---

# Current handoff

## Video player backend (PR `feature/video-player-backend`, awaiting review)

- Extends existing chapters, progress, playback and offline licenses; migration `20261115010000000_add-video-player-state` (watched ranges, report time, `offline_devices`, `offline_downloads.device_id`). Contract: docs/frontend-handoff.md "Video player"; decisions 2026-11-15.
- Verified: `npm test` exit 0 (454/454), `test:migrations` 40/94.
- After merge (operator): `migrate:up`; set `OFFLINE_KEY_SECRET` (≥ 32 random chars, never rotate casually) — without it device licenses return 503; optional new env keys from `deploy/env.example`; check on the server that a playback URL returns `Cache-Control: private, max-age=28800` and `206` for Range through nginx/SeaweedFS.
- Not done: frontend player/OPFS/Service Worker; summary pagination; server-side anti-cheat beyond unique intervals; mark-instead-of-clear for chapters.

## Resumable lesson video uploads (PR `feature/video-upload`, awaiting review)

- Built on `asset_uploads`: optional `lessonId` (attach on completion), video limits (4 GiB file, 15 GiB library, 3 open uploads per user), states `uploading`/`expired`, `missingParts`/`uploadedBytes` for resuming, upload sweep inside `worker:attempts`, 3-day abort rule, old video object deleted on replace/remove, playback URLs 2 h. Migration `20261114010000000`.
- Verified: sources, integrity, migrations cycle, server, disposable suite 446/446.
- After merge (operator): `migrate:up` (the compose `migrate` service); rebuild backend and workers; `npm run storage:configure` in the backend container (lifecycle 3 days, CORS); copy `deploy/nginx/everest-files.conf` changes (client_max_body_size 128m, Range, timeouts 900 s, `proxy_max_temp_file_size 0`) → `nginx -t` → reload; add the new env keys from `deploy/env.example` if other values are wanted.
- Not done: transcoding/HLS (recommendation in decisions), root `.env.example` (not readable in this session).

## Trainer cells questions (PR #53, merged)

- Trainer questions picked by the mock exam cells rule (active blueprint `cells` item for the subject + shared `cellsKeyFilter`) get `kind: 'cells'`, `answerFormat: 'digits'`, `maxDigits`, take `{ digits }`, weigh the blueprint points (2) and show `sheet` in the result. Old `{ value }` is accepted (whole numbers stored as digits); earlier attempts unchanged. No migration.
- Verified: `test:sources`, `test:integrity`, `test:server`, disposable suite 433/433 pass (exit 0, ~82 s).
- Next: review/merge; frontend uses one digit-box component for trainer and mock exam (docs/frontend-handoff.md → "Trainer cells questions").

## Production deployment, stage 2a (PR `chore/deploy-to-main`)

- Added: `Dockerfile`, `deploy/docker-compose.prod.yml` (db, backend, worker-attempts, worker-imports, SeaweedFS 4.51, frontend), env/backup/S3 templates, nginx examples, `deploy/scripts/` (deploy with rollback, backup, restore check) and `docs/deploy.md`. `TRUST_PROXY` is merged (PR #50).
- Verified: `bash -n` on the scripts only. Not verified: `docker compose config` (no Docker locally), SeaweedFS 4.51 flags and healthcheck, the backup scripts end to end, anything on the server.
- Next: merge the frontend deploy changes (`Dockerfile`, `output: "standalone"`, `STUDENT_HOSTS`, `NEXT_PUBLIC_APP_URL_STUDENT`) into frontend `main`; add `TRUST_PROXY=` to the root `.env.example`; stage 2b on the server after the owner approves.
- On the server never touch the other project on the host; use only `docker compose -p everest` and `docker builder prune`.

## Done

- NCT mock exam, separate from the trainer: `GET /trainer/exams/blueprints`, `POST /trainer/exams`, `GET /trainer/exams`, `GET /trainer/exams/:attemptId`, `PUT .../answers/:attemptQuestionId`, `PUT .../questions/:attemptQuestionId/flag`, `POST .../submit`, `GET .../result`. Access: active account plus `trainer.use`.
- Migration `20261113010000000_add-nct-mock-exam`: origin `mock_exam` (no course), tables `exam_blueprints`, `exam_blueprint_sections`, `exam_blueprint_items`, `mock_exam_items`, seed `nct-a5` (105 questions, 220 minutes, 40 per subject, 160 in total).
- Engine (additive): account-only access for `mock_exam`; cells questions get `answerFormat: 'digits'` in the grading snapshot (`{ digits }` of 1–4 digits, 2/0 points, leading zeros ignored).
- Docs: frontend-handoff "NCT mock exam", api, decisions, architecture, progress, ROADMAP.

## Verification (2026-11-13)

- `npm run test:auth` on a disposable database (including the live S3 round trip): exit 0; 416 tests, 416 passed, 0 failed (6 870 s, see below).
- The same suite skipping only the live S3 round trip: exit 0; 415 passed, 0 failed, about 85 s.
- `test:migrations` (38/38/37/38), `test:sources`, `test:integrity`, `test:server`: exit 0.
- `everest_db`: only read-only counts. `test:integrity` runs inside `BEGIN … ROLLBACK` there, as `npm test` always does.

## Not verified

- HTTP routes with cookies and CSRF (services were called directly).
- Assembly time on `everest_db` volumes.

## Known issue (environment, not this branch)

- S3 storage is configured and reachable here, so `real-storage.test.js` runs. It passes, but the test process then stays idle for about 1.5–2 hours before it exits, so plain `npm run test:auth` looks hung after its last result. No disposable databases are left over.

## Next concrete task

1. Review the PR for `feat/nct-mock-exam`; after the merge run `npm run migrate:up` on `everest_db`.
2. Owner decisions: per-position difficulty distribution for `nct-a5` (now easy to hard within each range, no bounds); leading zeros in cells (now ignored).
3. Make the live S3 test close its client so `npm test` exits promptly.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit applied migrations. Never merge, force-push, or push to `main`.
- Point `DB_NAME` at a disposable database for `npm test`. Never delete data in `everest_db`.
- Never commit `import-packages/`.
