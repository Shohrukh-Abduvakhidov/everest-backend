# EVEREST deployment

Single-host deployment with Docker Compose behind the host's nginx. Files:

| Path | Purpose |
|---|---|
| `Dockerfile`, `.dockerignore` | Backend image (API, workers, migrations, storage setup share it) |
| `deploy/docker-compose.prod.yml` | Stack: `db`, `backend`, `worker-attempts`, `worker-jobs`, `worker-imports`, `s3`, `frontend`; one-off `migrate`, `storage-configure` (profile `ops`) |
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
compose project "everest": db · backend · worker-attempts · worker-jobs · worker-imports · s3 · frontend
```

- Only loopback ports are published; the database and SeaweedFS master/volume/filer/admin are internal.
- Every command addresses the project explicitly: `docker compose -p everest -f docker-compose.prod.yml …`.
  Never run `docker system prune`, `docker image prune` or anything with `--volumes` on a shared host;
  `docker builder prune` is the only cleanup.
- Containers have memory and CPU limits (see the compose header, about 2.5 GB total) and `json-file`
  log rotation (10 MB × 3).

## Services

| Service | Command | Notes |
|---|---|---|
| `backend` | `node src/server.js` | Health `/api/v1/health`, readiness `/api/v1/ready` |
| `worker-attempts` | `npm run worker:attempts` | **Required.** Finalizes attempts whose time expired |
| `worker-jobs` | `npm run worker:jobs` | **Required for notifications.** Runs `background_jobs` (notification fan-out) and, when `TELEGRAM_CLIENT_ID` and `TELEGRAM_BOT_TOKEN` are set, the Telegram sender (20 messages/s, 1/s per chat). 192 MB limit, heap 128 MB, 0.25 CPU. **Run exactly one replica**: the Telegram rate limit lives in the process. If it is stopped, jobs and messages wait in the database and go out when it starts again. The start line logs `telegramSender: true/false` and `appUrl: set/missing` |
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
5. Install the nginx examples as separate `sites-available/everest-*` files (procedure below), then issue
   certificates. The current server uses the webroot method described in "Domains" → "Certificates".
6. Backups: copy `deploy/backup.env.example` to `/etc/everest/backup.env` (600) and add cron entries:
   `30 22 * * * /opt/everest/backend/deploy/scripts/backup-db.sh` and
   `0 23 * * 0 /opt/everest/backend/deploy/scripts/restore-check.sh`.

### Changing shared nginx safely

The host nginx also serves other sites. Only touch `everest-*` and `everestlc-*` files:

1. `sudo tar czf /var/backups/nginx-$(date +%Y%m%d-%H%M%S).tar.gz /etc/nginx`
2. Record `curl -s -o /dev/null -w '%{http_code}'` for every site on the host.
3. Edit `sites-available/everest-*` or `everestlc-*`, `sudo nginx -t`, then `sudo systemctl reload nginx` (never restart).
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
docker compose -p everest -f deploy/docker-compose.prod.yml up -d --no-deps backend worker-attempts worker-jobs worker-imports
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
| `APP_URL_MARKETING` | Frontend build time: landing URL used in links (the app URL while there is no landing) |
| `TELEGRAM_*` | Telegram login; empty keeps it disabled |
| `APP_URL` | Backend: student app root used for links in Telegram notifications (`https://app.<host>`, no trailing slash). Validated at start: an invalid value stops the backend and the workers. Without it Telegram messages are sent without a link |
| `API_PUBLIC_URL` | Backend: public origin of the API for absolute image URLs of the marketing site (`https://api.everestlc.tj`); see "Marketing site module" |
| `SITE_REVALIDATE_URL`, `SITE_REVALIDATE_SECRET` | Backend: revalidation webhook of the landing; empty = no webhook, see "Marketing site module" |
| `JOB_WORKER_INTERVAL_MS`, `JOB_LEASE_SECONDS` | `worker:jobs` idle poll (5000) and job lease (60 s, renewed while a job runs) |

`API_ORIGIN` for the frontend is fixed to `http://backend:4100` in compose and does not depend on the host.

## Notifications (M14)

`worker-jobs` runs the whole notification pipeline. The backend only queues jobs in the same transaction as the action.

| Part | Where | Notes |
|---|---|---|
| Fan-out | `background_jobs`, type `notification.fanout` | Writes in-app `notifications` and queues Telegram `notification_deliveries`. Reminders wait in the table until `available_at` (`test.closing_24h` at close − 24 h, `test.answers_available` at the close) |
| Telegram sender | `notification_deliveries` | Needs `TELEGRAM_CLIENT_ID` and `TELEGRAM_BOT_TOKEN`; sends only for connections of that bot. 20 messages/s, 1/s per chat. Plain text with the link `APP_URL + path` |
| Retention | `background_jobs`, type `notification.retention` | Once a day: deletes notifications older than 180 days and their deliveries |

- **Exactly one `worker-jobs` replica.** The Telegram rate limit is kept in the process.
- **When the worker is stopped**, nothing is lost: jobs and deliveries wait. On start, due reminders go out unless their moment passed:
   - a 24-hour reminder after the close is cancelled (`NOTIFICATION_EXPIRED`);
   - an in-app notice is still written while the assignment is open.
- **Start line:** `Job worker started { workerId, telegramSender: true|false, appUrl: 'set'|'missing' }`. With `telegramSender: false`, only in-app notifications are written.
- **Checks** (read-only SQL inside `db`):
   - queue: `SELECT job_type, status, count(*) FROM background_jobs GROUP BY 1, 2`;
   - dead letter: `SELECT id, job_type, last_error_code, attempts FROM background_jobs WHERE status = 'failed' ORDER BY id DESC LIMIT 20`;
   - Telegram: `SELECT status, last_error_code, count(*) FROM notification_deliveries GROUP BY 1, 2`.

  `unknown` means no outcome (timeout or worker stopped mid-send). It is never resent.
- **Error codes on deliveries:**
   - `BOT_BLOCKED`: the user blocked the bot; they get an in-app notice and must link Telegram again;
   - `TELEGRAM_UNLINKED`, `TELEGRAM_DISABLED`, `TELEGRAM_EVENT_DISABLED`, `ACCOUNT_NOT_ACTIVE`: cancelled by the user's state;
   - `QUIET_EXPIRED` and `NOTIFICATION_EXPIRED`: the reminder lost its meaning;
   - `TELEGRAM_RATE_LIMITED`: waiting for a 429 `retry_after`;
   - `TELEGRAM_UNAVAILABLE`: 5xx, retried up to 5 times;
   - `TELEGRAM_REJECTED`: other 4xx.
- **Logs** hold ids, counts and codes only: no token, chat id or message text.
- **Changing the bot:** a new `TELEGRAM_CLIENT_ID` stops deliveries to connections of the old bot. Users link Telegram again.
- **Not in M14:** Web Push and broadcast campaigns (after the launch).

## Domains (everestlc.tj)

Moved on 2026-11-28. The sslip.io hosts still answer in parallel during the transition.

| Host | Host nginx file | Target |
|---|---|---|
| `app.everestlc.tj` | `everestlc-app` | `/api/v1/*` → `127.0.0.1:4100`, rest → `127.0.0.1:3100` |
| `api.everestlc.tj` | `everestlc-api` | `127.0.0.1:4100` |
| `files.everestlc.tj` | `everestlc-files` | `127.0.0.1:8333` (SeaweedFS S3, `Host` passed unchanged) |
| `everestlc.tj` | `everestlc-site` | 301 → `https://app.everestlc.tj$request_uri` until the landing is deployed |
| `www.everestlc.tj` | `everestlc-site` | 301 → `https://everestlc.tj$request_uri` |
| `app.`, `api.`, `files.51-83-197-15.sslip.io` | `everest-app`, `everest-api`, `everest-files` | Unchanged, kept for the transition |

DNS: A records `@`, `www`, `app`, `api` and `files` point to `51.83.197.15`. They are managed at the registrar
(navjucloud.tj); there is no Cloudflare and no AAAA record. `deploy/nginx/everestlc-site.conf` is the example for
the apex and `www`. `everestlc-app`, `everestlc-api` and `everestlc-files` copy the sslip files, change
`server_name` and the certificate paths, and add the port 80 block shown under "Certificates".

### Environment on the domain

| Variable | Value |
|---|---|
| `CORS_ORIGINS` | `https://app.everestlc.tj,https://everestlc.tj,https://app.51-83-197-15.sslip.io` |
| `STORAGE_CORS_ORIGINS` | `https://app.everestlc.tj,https://app.51-83-197-15.sslip.io,https://api.51-83-197-15.sslip.io`, then `run --rm storage-configure` |
| `S3_PUBLIC_ENDPOINT` | `https://files.everestlc.tj`. A single value: the sslip app also gets files URLs on this host, and its origin stays in the bucket CORS |
| `STUDENT_HOSTS` | `app.everestlc.tj,app.51-83-197-15.sslip.io`. Read at runtime: recreate `frontend` |
| `APP_URL` | `https://app.everestlc.tj`. Backend runtime: recreate `backend` and the workers |
| `APP_URL_STUDENT`, `APP_URL_MARKETING` | `https://app.everestlc.tj`. Build time: `deploy.sh frontend`. `APP_URL_MARKETING` becomes `https://everestlc.tj` once the landing is live |
| `TELEGRAM_REDIRECT_URI` | `https://app.everestlc.tj/auth/telegram/callback`; set the same URL in BotFather |
| `API_ORIGIN` | No change (`http://backend:4100`): the browser calls `/api/v1` on the app host |

- Auth cookies have no `Domain` attribute (decision of 2026-11-28). A cookie belongs to the host that set it,
  so a session on `app.everestlc.tj` is separate from one on the sslip host, and users sign in again on the new host.
- Telegram login works on one host only, `app.everestlc.tj`: there is one redirect URI, and the state cookie is
  host-bound. Password login works on both hosts.
- The database stores object keys, not URLs. A check on 2026-11-28 found no `sslip.io` in `everest_prod`, so no
  data changes with the host.

### Certificates

There are four Let's Encrypt certificates: `app.everestlc.tj`, `api.everestlc.tj`, `files.everestlc.tj`, and
`everestlc.tj` with `www.everestlc.tj`. They use the webroot method, so certbot never edits nginx files. Every
`everestlc-*` site has the same port 80 block:

```nginx
server {
    listen 80;
    server_name app.everestlc.tj;
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type text/plain;
    }
    location / {
        return 301 https://$host$request_uri;
    }
}
```

- `certbot.timer` renews them. Each renewal config has `authenticator = webroot` and `renew_hook = systemctl reload nginx`.
- To check: `sudo certbot certificates` and `sudo certbot renew --dry-run --cert-name app.everestlc.tj`.
- To reissue or add a name, the port 80 block must exist and nginx must be reloaded first. Run with `--dry-run`,
  then run the same command without it:

  ```bash
  sudo certbot certonly --webroot -w /var/www/letsencrypt --cert-name app.everestlc.tj -d app.everestlc.tj \
    --deploy-hook "systemctl reload nginx" --dry-run
  ```

- If a renewal fails, read `sudo journalctl -u certbot -n 50`. Then put a test file into
  `/var/www/letsencrypt/.well-known/acme-challenge/` and check that `http://<host>/.well-known/acme-challenge/<file>`
  serves it.

### Checks after a change

```bash
curl -sI https://app.everestlc.tj/login | head -1                # 200
curl -s https://api.everestlc.tj/api/v1/ready                    # ready
curl -sI 'https://everestlc.tj/a?b=1' | grep -i location         # https://app.everestlc.tj/a?b=1
curl -sI https://www.everestlc.tj/ | grep -i location            # https://everestlc.tj/
curl -s -o /dev/null -D - -X OPTIONS -H 'Origin: https://app.everestlc.tj' \
  -H 'Access-Control-Request-Method: PUT' https://files.everestlc.tj/everest-media/x | grep -i '^access-control-allow-origin'
```

Also check the co-hosted site's status codes (see "Changing shared nginx safely").

### Rolling back to the sslip.io hosts

The sslip nginx sites and certificates are untouched, so a rollback changes only the env. Backups taken before the move:
`deploy/.env.bak-domain-20261128-161927` (env) and `/var/backups/nginx-20261128-161927.tar.gz` (nginx).

```bash
cd /opt/everest/backend/deploy
cp -p .env .env.bak-before-rollback-$(date +%Y%m%d-%H%M%S)
cp -p .env.bak-domain-20261128-161927 .env      # previous sslip values, same secrets
docker compose -p everest -f docker-compose.prod.yml up -d --no-deps backend worker-attempts worker-jobs worker-imports
docker compose -p everest -f docker-compose.prod.yml run --rm storage-configure
cd .. && deploy/scripts/deploy.sh frontend --no-pull   # APP_URL_* are build time
```

A faster frontend rollback is the previous image, which was built with the sslip values:
`docker tag everest-frontend:prev everest-frontend:current`, then
`docker compose -p everest -f deploy/docker-compose.prod.yml up -d --no-deps frontend`. After the next frontend
deploy, `:prev` holds the domain build instead, so use `deploy.sh` then.

Then set the Telegram redirect URL in BotFather back to the sslip host. To take the new hosts offline as well
(the certificates can stay):

```bash
sudo tar czf /var/backups/nginx-$(date +%Y%m%d-%H%M%S).tar.gz /etc/nginx
sudo rm /etc/nginx/sites-enabled/everestlc-app /etc/nginx/sites-enabled/everestlc-api \
  /etc/nginx/sites-enabled/everestlc-files /etc/nginx/sites-enabled/everestlc-site
sudo nginx -t && sudo systemctl reload nginx
```

### Turning the sslip.io hosts off (after the transition)

1. Remove the sslip origins from `CORS_ORIGINS`, `STORAGE_CORS_ORIGINS` and `STUDENT_HOSTS`. Recreate the backend,
   the workers and the frontend, then `run --rm storage-configure`.
2. Delete `sites-enabled/everest-app`, `everest-api` and `everest-files`, or replace them with a 301 to the new hosts.
3. Once nginx no longer references the sslip certificates, check `nginx -t`, then run
   `sudo certbot delete --cert-name app.51-83-197-15.sslip.io` (and the same for `api.` and `files.`).

### Landing on everestlc.tj (next step)

1. In `everestlc-site`, replace the apex redirect with a proxy to the frontend (`127.0.0.1:3100`, same headers as `everestlc-app`).
2. Set `APP_URL_MARKETING=https://everestlc.tj` and the landing's env: `COOKIE_DOMAIN=.everestlc.tj` (language
   cookie), `REVALIDATE_SECRET` and `SITE_IMAGE_HOSTS=api.everestlc.tj` (images are served by the API host and redirect
   to `files.everestlc.tj`). Turn the backend webhook on afterwards ("Marketing site module" → "Turning the webhook on").
3. Rebuild the frontend.

## Marketing site module (Site)

Content for the landing on `everestlc.tj`: public reads at `/api/v1/public/site/*`, admin at `/api/v1/admin/site/*`
(permission `site.manage`, owner and admin). Contract: `docs/site-api.md`. Deployed on 2026-11-28 (backend `dadc7cb`).

### Environment

| Variable | Value |
|---|---|
| `API_PUBLIC_URL` | `https://api.everestlc.tj`, no trailing slash. Host of the absolute image URLs in site responses (`/api/v1/public/site/images/{id}`). Without it the request's own host is used, which is the internal `http://backend:4100` when the landing calls the API server-side. Set |
| `SITE_REVALIDATE_URL` | `https://everestlc.tj/api/revalidate`. **Not set yet**: set it only when the apex serves the landing (see "Turning the webhook on") |
| `SITE_REVALIDATE_SECRET` | Shared secret, generated on the server; the landing reads the same value as `REVALIDATE_SECRET`. Not set yet |
| `SITE_REVALIDATE_TIMEOUT_MS`, `SITE_CACHE_MAX_AGE_SECONDS` | Optional: webhook timeout (3000) and `Cache-Control` max-age of the public reads (60) |

With the URL or the secret unset no webhook job is queued and saving content works as usual.

### Deploy

1. Back up `deploy/.env`, add the variables, then `deploy/scripts/deploy.sh backend` (pre-deploy dump, build, `migrate`,
   restart of the API and the three workers; `worker-jobs` must restart to load the `site.revalidate` handler).
2. Migrations: `20261128010000000_add-site-content` (10 `site_*` tables, permission `site.manage`) and
   `20261128020000000_seed-site-content` (idempotent seed). Both are additive: the previous code ignores the tables.
3. Seeded content: 4 courses `published` (biology, chemistry, physics, tajik; no covers); 3 vacancies and 3 events
   `draft`; no videos; settings live with empty contacts, statistics filled but `stats_enabled=false`; texts in ru, tg, en.
4. nginx: uploading a cover (JPEG or PNG up to 5 MB, raw body) needs its own location, because the app and API sites
   cap bodies at 2 MB. Put it before `location /api/v1/ {` in `everestlc-app`, `everestlc-api`, `everest-app` and
   `everest-api` (and in any new site that proxies the API):

   ```nginx
   location = /api/v1/admin/site/images {
       client_max_body_size 6m;
       proxy_read_timeout 120s;
       proxy_pass http://127.0.0.1:4100;
   }
   ```

   Then the usual procedure: backup, `nginx -t`, `reload`. Check without a session: a 4.5 MB body gets `401`, a 7 MB body
   gets `413`, any other admin path still stops at 2 MB.

### Checks

```bash
B=https://api.everestlc.tj/api/v1/public/site
curl -s "$B/courses?lang=tj"                       # { "data": [ ... ] }, a bare array
curl -s -o /dev/null -w '%{http_code}\n' "$B/courses/nope"      # 404
curl -sI "$B/courses" | grep -i -E '^(etag|cache-control)'      # weak ETag, public, max-age=60
curl -s -o /dev/null -w '%{http_code}\n' "$B/images/999999"     # 404 (a real id: 302 to files.everestlc.tj)
```

Lists contain published items only; vacancies past `validThrough` and events that are over are left out. The settings
save can be exercised without writing anything by running `updateSiteSettingsService` inside a transaction that is
rolled back (once with the webhook unset: no job in `background_jobs`; once with a URL: one job).

### Turning the webhook on

Do this after the landing is deployed and the apex proxies to the frontend (`everestlc-site`), not before: while the
apex redirects to the app every save would queue a job that fails four times.

1. `curl -s -o /dev/null -w '%{http_code}' -X POST https://everestlc.tj/api/revalidate` must answer `401` or `403`
   (the route exists and checks the secret), not `301` or `404`.
2. Generate the secret on the server, put the same value into the landing's `REVALIDATE_SECRET` and
   `SITE_REVALIDATE_SECRET`, set `SITE_REVALIDATE_URL=https://everestlc.tj/api/revalidate`.
3. Recreate the API and `worker-jobs` (the landing's side as its own deploy).
4. Save something in the admin and watch the queue:
   `SELECT status, attempts, last_error_code, count(*) FROM background_jobs WHERE job_type = 'site.revalidate' GROUP BY 1, 2, 3`.
   The job is sent by `worker-jobs` within seconds. A failed attempt is retried after 30, 60 and 120 s; after four attempts
   the job stays `failed`. A redirect in the answer counts as a failure (the secret is never passed on to another host).
   Saving never waits for the webhook.

Time passing is not an event: an event that is over disappears from the list on its own, so the landing needs a fallback
revalidation interval besides the tags.

### Rolling back the module

- **Code only** (the tables stay, the previous code ignores them):
  `docker tag everest-backend:prev everest-backend:current`, then
  `docker compose -p everest -f deploy/docker-compose.prod.yml up -d --no-deps backend worker-attempts worker-jobs worker-imports`.
  `deploy.sh backend` does this by itself when the health check fails. The public site routes then answer `404`.
- **Migrations.** Do not run `migrate:down` on the server for this: the first migration drops all `site_*` tables with the
  content the admins entered; the second one removes only the seeded rows. If the module must be removed anyway, restore the
  pre-deploy dump (below) or take a dump of the `site_*` tables first.
- **Restoring the dump.** The pre-deploy dump of this deploy is
  `/var/backups/everest/db/predeploy/everest_prod-20261128T170616Z.dump` (kept 14 days). Restore into a new database, never
  over the live one:

  ```bash
  cd /opt/everest/backend/deploy
  docker compose -p everest -f docker-compose.prod.yml exec -T db sh -c 'createdb -U "$POSTGRES_USER" everest_restore'
  docker compose -p everest -f docker-compose.prod.yml exec -T db sh -c \
    'pg_restore -U "$POSTGRES_USER" -d everest_restore --no-owner --role="$EVEREST_APP_DB_USER" --no-privileges' \
    < /var/backups/everest/db/predeploy/everest_prod-20261128T170616Z.dump
  ```

  Check the row counts, then switch `DB_NAME=everest_restore` in `deploy/.env`, recreate the API and the workers. Data
  written after the dump (answers, progress) is lost; weigh that against fixing forward.
- **nginx.** The four files before the change are in `/var/backups/site-images-nginx-170756/`; the whole tree is in
  `/var/backups/nginx-20261128-170743.tar.gz`. Restore a file, `sudo nginx -t`, `sudo systemctl reload nginx`, then the
  other site's status codes.
- **Env.** `deploy/.env.bak-site-20261128-170602` is the file before `API_PUBLIC_URL`.

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
