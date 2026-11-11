#!/usr/bin/env bash
# Daily PostgreSQL dump of the EVEREST database with local rotation and an optional encrypted off-site copy.
#
#   deploy/scripts/backup-db.sh             # daily run (cron); Sundays are also kept as weekly
#   deploy/scripts/backup-db.sh predeploy   # ad-hoc dump before a deploy (kept 14 days)
#
# Settings: /etc/everest/backup.env (see deploy/backup.env.example). No secrets are stored in this script.
# Local dumps stay unencrypted (mode 600 in a 700 directory) so restore-check.sh can read them; off-site
# copies are encrypted with the age public key, whose private key is kept off the server.
set -euo pipefail
umask 077

settings="${BACKUP_SETTINGS:-/etc/everest/backup.env}"
# shellcheck disable=SC1090
[[ -r "$settings" ]] && source "$settings"

kind="${1:-daily}"
backup_dir="${BACKUP_DIR:-/var/backups/everest}"
deploy_dir="${EVEREST_DEPLOY_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
compose=(docker compose -p everest -f "$deploy_dir/docker-compose.prod.yml")
keep_daily=7
keep_weekly=4
keep_predeploy=14

notify_failure() {
   local message="EVEREST backup failed on $(hostname): $1"
   echo "$message" >&2
   if [[ -n "${ALERT_TELEGRAM_BOT_TOKEN:-}" && -n "${ALERT_TELEGRAM_CHAT_ID:-}" ]]; then
      curl -fsS --max-time 10 -o /dev/null \
         --data-urlencode "chat_id=${ALERT_TELEGRAM_CHAT_ID}" \
         --data-urlencode "text=${message}" \
         "https://api.telegram.org/bot${ALERT_TELEGRAM_BOT_TOKEN}/sendMessage" || true
   fi
   [[ -n "${BACKUP_HEALTHCHECK_URL:-}" ]] && curl -fsS --max-time 10 -o /dev/null "${BACKUP_HEALTHCHECK_URL}/fail" || true
}
trap 'notify_failure "line $LINENO"' ERR

db_name="${BACKUP_DB_NAME:-}"
if [[ -z "$db_name" ]]; then
   db_name="$(grep -E '^DB_NAME=' "$deploy_dir/.env" | tail -1 | cut -d= -f2-)"
fi
[[ -n "$db_name" ]] || { notify_failure "database name unknown"; exit 1; }

mkdir -p "$backup_dir/db/daily" "$backup_dir/db/weekly" "$backup_dir/db/predeploy"
chmod 700 "$backup_dir" "$backup_dir/db"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
case "$kind" in
   daily) target_dir="$backup_dir/db/daily" ;;
   predeploy) target_dir="$backup_dir/db/predeploy" ;;
   *) echo "Usage: $0 [daily|predeploy]" >&2; exit 2 ;;
esac
file="$target_dir/${db_name}-${stamp}.dump"

# pg_dump runs inside the db container as its superuser; the dump streams to the host file.
"${compose[@]}" exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -Fc -d "$1"' sh "$db_name" > "$file.partial"
mv "$file.partial" "$file"
chmod 600 "$file"
"${compose[@]}" exec -T db pg_restore --list < "$file" > /dev/null
echo "dump ok: $file ($(du -h "$file" | cut -f1))"

if [[ "$kind" == "daily" && "$(date -u +%u)" == "7" ]]; then
   cp -p "$file" "$backup_dir/db/weekly/"
fi

prune() {
   local dir="$1" keep="$2"
   { ls -1t "$dir"/*.dump 2>/dev/null || true; } | tail -n +"$((keep + 1))" | xargs -r rm -f --
}
prune "$backup_dir/db/daily" "$keep_daily"
prune "$backup_dir/db/weekly" "$keep_weekly"
find "$backup_dir/db/predeploy" -name '*.dump' -mtime +"$keep_predeploy" -delete

# Off-site copy (Backblaze B2 or any rclone remote). Prepared, enabled by setting the variables.
if [[ -n "${BACKUP_RCLONE_REMOTE:-}" ]]; then
   [[ -n "${AGE_RECIPIENT:-}" ]] || { notify_failure "AGE_RECIPIENT is required for off-site copies"; exit 1; }
   command -v age >/dev/null && command -v rclone >/dev/null || { notify_failure "age or rclone is not installed"; exit 1; }
   encrypted="$file.age"
   age -r "$AGE_RECIPIENT" -o "$encrypted" "$file"
   rclone copyto "$encrypted" "${BACKUP_RCLONE_REMOTE}/db/${kind}/$(basename "$encrypted")"
   rm -f "$encrypted"
   echo "off-site copy uploaded to ${BACKUP_RCLONE_REMOTE}/db/${kind}/"
fi

[[ -n "${BACKUP_HEALTHCHECK_URL:-}" ]] && curl -fsS --max-time 10 -o /dev/null "$BACKUP_HEALTHCHECK_URL" || true
