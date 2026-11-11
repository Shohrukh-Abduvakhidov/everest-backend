# EVEREST deployment

Single-host deployment with Docker Compose behind the host's nginx. Files:

| Path | Purpose |
|---|---|
| `Dockerfile`, `.dockerignore` | Backend image (API, workers, migrations, storage setup share it) |
| `deploy/docker-compose.prod.yml` | Stack: `db`, `backend`, `worker-attempts`, `worker-imports`, `s3`, `frontend`; one-off `migrate`, `storage-configure` (profile `ops`) |
| `deploy/env.example` | Template for `deploy/.env` on the server |
| `deploy/seaweedfs/s3.example.json` | Template for `deploy/seaweedfs/s3.json` (S3 credentials) |
| `deploy/backup.env.example` | Template for `/etc/everest/backup.env` |
| `deploy/nginx/everest-app.conf`, `everest-files.conf` | Host nginx site examples |
| `deploy/scripts/deploy.sh`, `backup-db.sh`, `restore-check.sh` | Deploy with rollback, backups, restore proof |

The frontend repository (`everestlc`) must provide its own `Dockerfile` (Next.js `output: "standalone"`, port 3100)
and read `STUDENT_HOSTS` at runtime. Its checkout is expected at `../../frontend` relative to `deploy/`
(override with `FRONTEND_CONTEXT`).

## Topology

```
browser ─► host nginx :443
            ├─ <app host>   /api/v1/* ─► 127.0.0.1:4100 backend
            │               /*        ─► 127.0.0.1:3100 frontend
            └─ <files host>           ─► 127.0.0.1:8333 SeaweedFS S3 (presigned URLs)
compose project "everest": db · backend · worker-attempts · worker-imports · s3 · frontend
```

- Only loopback ports are published; the database and SeaweedFS master/volume/filer/admin are internal.
- Every command addresses the project explicitly: `docker compose -p everest -f docker-compose.prod.yml …`.
  Never run `docker system prune`, `docker image prune` or anything with `--volumes` on a shared host;
  `docker builder prune` is the only cleanup.
- Containers have memory and CPU limits (see the compose header, about 2.3 GB total) and `json-file`
  log rotation (10 MB × 3).

## Services

| Service | Command | Notes |
|---|---|---|
| `backend` | `node src/server.js` | Health `/api/v1/health`, readiness `/api/v1/ready` |
| `worker-attempts` | `npm run worker:attempts` | **Required.** Finalizes attempts whose time expired |
| `worker-imports` | `npm run worker:imports` | Processes admin-uploaded question packages (`/admin/question-imports`). Cheap when idle; stop it if web imports are not used |
| `s3` | `weed server -s3` | Pinned image tag; data in volume `everest_s3-data` |
| `migrate` (ops) | `npm run migrate:up` | Run before a new backend version starts |
| `storage-configure` (ops) | `npm run storage:configure` | Creates the bucket, lifecycle and CORS rule; run once and after changing `STORAGE_CORS_ORIGINS` |

## First installation (summary)

1. Clone backend to `/opt/everest/backend`, frontend to `/opt/everest/frontend`.
2. `cp deploy/env.example deploy/.env`, fill values, `chmod 600 deploy/.env`.
3. `cp deploy/seaweedfs/s3.example.json deploy/seaweedfs/s3.json`, put the same keys as `S3_ACCESS_KEY_ID`
   / `S3_SECRET_ACCESS_KEY`, `chmod 600`.
4. `deploy/scripts/deploy.sh all`, then
   `docker compose -p everest -f deploy/docker-compose.prod.yml up -d s3` and
   `docker compose -p everest -f deploy/docker-compose.prod.yml run --rm storage-configure`.
5. Install the nginx examples as separate `sites-available/everest-*` files (procedure below), then
   `sudo certbot --nginx -d <app host> -d <files host>`.
6. Backups: copy `deploy/backup.env.example` to `/etc/everest/backup.env` (600) and add cron entries:
   `30 22 * * * /opt/everest/backend/deploy/scripts/backup-db.sh` and
   `0 23 * * 0 /opt/everest/backend/deploy/scripts/restore-check.sh`.

### Changing shared nginx safely

The host nginx also serves other sites. Only touch `everest-*` files:

1. `sudo tar czf /var/backups/nginx-$(date +%Y%m%d-%H%M%S).tar.gz /etc/nginx`
2. Record `curl -s -o /dev/null -w '%{http_code}'` for every site on the host.
3. Edit `sites-available/everest-*`, `sudo nginx -t`, then `sudo systemctl reload nginx` (never restart).
4. Repeat the status check; the other sites must answer exactly as before.

## Deploying

```bash
cd /opt/everest/backend
deploy/scripts/deploy.sh backend     # pre-deploy dump, git pull, build, migrate, restart API + workers, health check
deploy/scripts/deploy.sh frontend    # git pull, build, restart, health check
```

- Builds run one image at a time. The script warns if less than about 1.5 GB of memory is available
  (frontend builds use `NODE_OPTIONS=--max-old-space-size=1536` in the build stage).
- The API is unavailable for a few seconds while its container is recreated. Do not deploy during exams.
- Migrations must be backward compatible with the running version (expand, deploy, contract).

### Fallback: build on another machine

When the server is short of memory, build locally and ship the image:

```bash
docker build -t everest-frontend:current --build-arg API_ORIGIN=http://backend:4100 \
  --build-arg NEXT_PUBLIC_DATA_SOURCE=api --build-arg NEXT_PUBLIC_APP_URL_STUDENT=https://<app host> .
docker save everest-frontend:current | gzip | ssh <server> 'gunzip | docker load'
ssh <server> 'cd /opt/everest/backend/deploy && docker compose -p everest -f docker-compose.prod.yml up -d --no-deps frontend'
```

Use `--platform linux/amd64` when building on an ARM machine. Tag the old image as `:prev` first if a rollback may be needed.

## Rolling back

`deploy.sh` restores the previous image automatically when the health check fails. Manually:

```bash
docker tag everest-backend:prev everest-backend:current
docker compose -p everest -f deploy/docker-compose.prod.yml up -d --no-deps backend worker-attempts worker-imports
```

Migrations are not rolled back (`migrate:down` is never run against production). If a migration must be
undone, restore the pre-deploy dump from `/var/backups/everest/db/predeploy/` into a new database and
switch `DB_NAME`.

## Environment

Backend variables are validated in `src/configs/env.js`; the full list with defaults is in
`docs/architecture.md`. Deployment-relevant ones:

| Variable | Meaning |
|---|---|
| `NODE_ENV=production` | Secure cookies, Swagger off by default |
| `DB_HOST=db`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_POOL_MAX` | Application role and pool (15 for exam peaks) |
| `POSTGRES_SUPERUSER`, `POSTGRES_SUPERUSER_PASSWORD` | Used by the db image on first initialisation only |
| `CORS_ORIGINS` | Origins allowed for CORS and the CSRF Origin check (the app host) |
| `TRUST_PROXY` | Proxies trusted for `X-Forwarded-For` (`loopback,172.16.0.0/12` here) |
| `SWAGGER_ENABLED=false` | API docs off in production |
| `JWT_ACCESS_SECRET`, `OTP_HMAC_SECRET` | Server-only secrets, generated on the server |
| `S3_PUBLIC_ENDPOINT` | Host signed into presigned URLs (the files host) |
| `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE=true` | Storage; `S3_ENDPOINT` is set to `http://s3:8333` by compose |
| `STORAGE_CORS_ORIGINS` | Origins written into the bucket CORS rule |
| `STUDENT_HOSTS` | Frontend runtime: hosts served as the student app without `/platform` |
| `APP_URL_STUDENT` | Frontend build time: absolute student URL used in links |
| `TELEGRAM_*` | Telegram login; empty keeps it disabled |

`API_ORIGIN` for the frontend is fixed to `http://backend:4100` in compose and does not depend on the host.

## Moving to the final domain

Cookies have no `Domain` attribute, so they belong to the host that set them: after a host change every
user signs in again. Presigned URLs live 15 minutes and the database stores object keys, not URLs.

| What | Change |
|---|---|
| DNS | A records for `app` and `files` → server IP |
| `CORS_ORIGINS` | `https://app.<domain>` (keep the old host too during the transition) |
| `STORAGE_CORS_ORIGINS` | `https://app.<domain>`, then `run --rm storage-configure` |
| `S3_PUBLIC_ENDPOINT` | `https://files.<domain>` |
| `TELEGRAM_REDIRECT_URI` | New callback URL; also update the domain in BotFather |
| `STUDENT_HOSTS` | `app.<domain>` (runtime; recreate `frontend`) |
| `APP_URL_STUDENT` | `https://app.<domain>` (build time; `deploy.sh frontend`) |
| `API_ORIGIN` | No change (`http://backend:4100`) |
| nginx | New `server_name` in `everest-app` and `everest-files`; optional 301 from the old hosts |
| Certificates | `sudo certbot --nginx -d app.<domain> -d files.<domain>` |

Then recreate the services: `up -d backend worker-attempts worker-imports frontend`.

## Moving to a separate server

1. On the new host: Docker, nginx, certbot; clone both repositories to `/opt/everest/`.
2. Copy `deploy/.env`, `deploy/seaweedfs/s3.json` and `/etc/everest/backup.env` over SSH (600). Keep the
   same secrets to keep sessions valid, or generate new ones and let users sign in again.
3. Database: `backup-db.sh predeploy` on the old host, copy the dump, start `db` on the new host, create the
   application role, `pg_restore --no-owner --role=<DB_USER> --no-privileges`, then run `migrate`.
4. Files: start `s3` and `storage-configure` on the new host, then `rclone sync` bucket to bucket over SSH
   tunnels to both `127.0.0.1:8333` endpoints and `rclone check`.
5. `deploy.sh all`, install nginx sites and certificates, verify `/api/v1/ready` and an image question.
6. Switch DNS (lower the TTL a day earlier), keep the old host read-only until traffic has moved.
