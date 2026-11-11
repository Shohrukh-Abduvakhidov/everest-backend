#!/usr/bin/env bash
# Prove the latest dump restores: load it into a throwaway database inside the db container, check row
# counts and the latest migration, then drop the throwaway database. The live database is not touched.
#
#   deploy/scripts/restore-check.sh [path/to/file.dump]
#
# Settings: /etc/everest/backup.env (RESTORE_MIN_QUESTIONS, RESTORE_MIN_USERS, alert variables).
set -euo pipefail

settings="${BACKUP_SETTINGS:-/etc/everest/backup.env}"
# shellcheck disable=SC1090
[[ -r "$settings" ]] && source "$settings"

backup_dir="${BACKUP_DIR:-/var/backups/everest}"
deploy_dir="${EVEREST_DEPLOY_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
compose=(docker compose -p everest -f "$deploy_dir/docker-compose.prod.yml")
dump="${1:-$(ls -1t "$backup_dir"/db/daily/*.dump 2>/dev/null | head -1 || true)}"
check_db="restore_check_$(date -u +%Y%m%d%H%M%S)"

notify_failure() {
   local message="EVEREST restore check failed on $(hostname): $1"
   echo "$message" >&2
   if [[ -n "${ALERT_TELEGRAM_BOT_TOKEN:-}" && -n "${ALERT_TELEGRAM_CHAT_ID:-}" ]]; then
      curl -fsS --max-time 10 -o /dev/null \
         --data-urlencode "chat_id=${ALERT_TELEGRAM_CHAT_ID}" \
         --data-urlencode "text=${message}" \
         "https://api.telegram.org/bot${ALERT_TELEGRAM_BOT_TOKEN}/sendMessage" || true
   fi
}

psql_db() {
   "${compose[@]}" exec -T db sh -c 'psql -U "$POSTGRES_USER" -v ON_ERROR_STOP=1 -Atq -d "$1" -c "$2"' sh "$1" "$2"
}

cleanup() {
   "${compose[@]}" exec -T db sh -c 'dropdb -U "$POSTGRES_USER" --if-exists "$1"' sh "$check_db" || true
}
trap cleanup EXIT
trap 'notify_failure "line $LINENO"' ERR

[[ -n "$dump" && -r "$dump" ]] || { notify_failure "no dump found"; exit 1; }
echo "restoring $dump into $check_db"

"${compose[@]}" exec -T db sh -c 'createdb -U "$POSTGRES_USER" "$1"' sh "$check_db"
"${compose[@]}" exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" --no-owner --no-privileges --exit-on-error -d "$1"' \
   sh "$check_db" < "$dump"

questions="$(psql_db "$check_db" 'SELECT count(*) FROM questions')"
users="$(psql_db "$check_db" 'SELECT count(*) FROM users')"
migration="$(psql_db "$check_db" 'SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1')"
echo "questions=$questions users=$users last_migration=$migration"

if (( questions < ${RESTORE_MIN_QUESTIONS:-1} )) || (( users < ${RESTORE_MIN_USERS:-1} )); then
   notify_failure "counts below minimum (questions=$questions users=$users)"
   exit 1
fi
echo "restore check passed"
