---
project: EVEREST Backend
current_milestone: Production deployment (stage 2a, code and documents)
status: awaiting_review
branch: chore/deploy-to-main (PR), fix/trust-proxy (PR #50)
base_commit: d43228a
updated_at: 2026-11-11
---

# Current handoff

## Done

- `fix/trust-proxy` (PR #50): `TRUST_PROXY` env for Express `trust proxy` (hop count or list of names/IPs/CIDRs; `true` rejected; production warning when unset). Tests: unit `trust-proxy.test.js`, integration login limit per real client. `npm test`: 422 tests, 421 pass, 0 fail, 1 skipped.
- `chore/deploy-to-main`: `Dockerfile` and `.dockerignore` from `deploy/temp-vps`; `deploy/docker-compose.prod.yml` (db, backend, worker-attempts, worker-imports, SeaweedFS 4.51, frontend; ops profile `migrate`, `storage-configure`; loopback-only ports, memory/CPU limits, log rotation, capped Node heaps); `deploy/env.example`, `deploy/backup.env.example`, `deploy/seaweedfs/s3.example.json`; nginx examples `deploy/nginx/everest-app.conf` (`/api/v1/` straight to the backend, `X-Forwarded-For $remote_addr`) and `everest-files.conf`; scripts `deploy.sh` (memory check, one build at a time, pre-deploy dump, migrate, health checks, rollback to `:prev`), `backup-db.sh` (7 daily + 4 weekly, age + rclone off-site prepared, Telegram alert), `restore-check.sh`; `docs/deploy.md`.

## Verification

- Shell scripts: `bash -n` only. No shellcheck and no Docker on the development machine, so the compose file was not validated with `docker compose config`, and nothing was run on the server.
- The server was only inspected read-only.

## Not verified

- SeaweedFS `server -s3` flags, the `/cluster/healthz` healthcheck and bucket CORS support of 4.51 on the server.
- `backup-db.sh` and `restore-check.sh` end to end.

## Next concrete task

1. Review and merge PR #50 and the deploy PR; merge the frontend deploy changes (`Dockerfile`, `output: "standalone"`, `STUDENT_HOSTS`, `NEXT_PUBLIC_APP_URL_STUDENT`) into frontend `main`.
2. Add `TRUST_PROXY=` with a comment to the root `.env.example` (not edited in these PRs).
3. Stage 2b on the server after the owner's approval: data migration, SeaweedFS, nginx `everest-app`/`everest-files`, backups.

## Constraints

- Preserve route → middleware → controller → service → repository → PostgreSQL.
- Do not edit applied migrations. Never merge, force-push, or push to `main`.
- Point `DB_NAME` at a disposable database for `npm test`. Never delete data in `everest_db`.
- Never commit `import-packages/`.
- On the server never touch the other project on the host (containers, nginx sites, database, cron, users); use only `docker compose -p everest` and `docker builder prune`.
