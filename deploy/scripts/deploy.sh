#!/usr/bin/env bash
# Build and roll out EVEREST on the single host.
#
#   deploy/scripts/deploy.sh backend    # pull, build backend image, migrate, restart backend + workers
#   deploy/scripts/deploy.sh frontend   # pull, build frontend image, restart frontend
#   deploy/scripts/deploy.sh all        # backend, then frontend (one build at a time)
#   Options: --no-pull (build the checked-out code), --yes (do not pause on the low-memory warning)
#
# Only the compose project "everest" is touched. On a failed health check the previous image is restored.
# Migrations are never rolled back automatically: restore the pre-deploy dump if a migration must be undone.
set -euo pipefail

target="${1:-}"
shift || true
pull=1
assume_yes=0
for arg in "$@"; do
   case "$arg" in
      --no-pull) pull=0 ;;
      --yes) assume_yes=1 ;;
      *) echo "Unknown option: $arg" >&2; exit 2 ;;
   esac
done
case "$target" in backend|frontend|all) ;; *)
   echo "Usage: $0 backend|frontend|all [--no-pull] [--yes]" >&2; exit 2 ;;
esac

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
deploy_dir="$(cd "$script_dir/.." && pwd)"
backend_dir="$(cd "$deploy_dir/.." && pwd)"
frontend_dir="${FRONTEND_CONTEXT:-$(cd "$backend_dir/../frontend" 2>/dev/null && pwd || true)}"
compose=(docker compose -p everest -f "$deploy_dir/docker-compose.prod.yml")
min_available_kb=$((1536 * 1024))

log() { printf '[deploy %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

check_memory() {
   local available
   available="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
   if (( available < min_available_kb )); then
      log "WARNING: only $((available / 1024)) MB available; a build needs about 1.5 GB (swap will be used, other sites may slow down)."
      if (( assume_yes == 0 )); then
         read -r -p "Continue? [y/N] " answer
         [[ "$answer" == "y" || "$answer" == "Y" ]] || exit 1
      fi
   fi
}

pull_repo() {
   local dir="$1"
   (( pull == 1 )) || return 0
   log "git pull in $dir"
   git -C "$dir" pull --ff-only
}

tag_previous() {
   local image="$1"
   if docker image inspect "$image:current" >/dev/null 2>&1; then
      docker tag "$image:current" "$image:prev"
      log "saved $image:current as $image:prev"
   fi
}

restore_previous() {
   local image="$1"
   if docker image inspect "$image:prev" >/dev/null 2>&1; then
      docker tag "$image:prev" "$image:current"
      log "restored $image:prev as $image:current"
   else
      log "no previous image for $image; nothing to roll back to"
   fi
}

wait_for() {
   local url="$1" tries="${2:-30}"
   for ((i = 1; i <= tries; i++)); do
      if curl -fsS -o /dev/null --max-time 5 "$url"; then
         log "ok: $url"
         return 0
      fi
      sleep 3
   done
   log "FAILED: $url"
   return 1
}

deploy_backend() {
   pull_repo "$backend_dir"
   check_memory
   if [[ -x "$script_dir/backup-db.sh" ]] && "${compose[@]}" ps --status running db | grep -q db; then
      log "pre-deploy database dump"
      "$script_dir/backup-db.sh" predeploy
   fi
   tag_previous everest-backend
   log "building backend"
   "${compose[@]}" build backend
   log "running migrations"
   if ! "${compose[@]}" run --rm migrate; then
      log "migrations failed; keeping the running containers on the previous image"
      restore_previous everest-backend
      exit 1
   fi
   "${compose[@]}" up -d --no-deps backend worker-attempts worker-imports
   if wait_for http://127.0.0.1:4100/api/v1/health && wait_for http://127.0.0.1:4100/api/v1/ready; then
      log "backend deployed"
      return 0
   fi
   log "backend unhealthy; rolling back"
   "${compose[@]}" logs --tail=80 backend || true
   restore_previous everest-backend
   "${compose[@]}" up -d --no-deps backend worker-attempts worker-imports
   wait_for http://127.0.0.1:4100/api/v1/ready || true
   exit 1
}

deploy_frontend() {
   [[ -n "$frontend_dir" && -d "$frontend_dir" ]] || { log "frontend checkout not found (set FRONTEND_CONTEXT)"; exit 1; }
   pull_repo "$frontend_dir"
   check_memory
   tag_previous everest-frontend
   log "building frontend (NODE_OPTIONS=--max-old-space-size=1536 inside the build stage)"
   FRONTEND_CONTEXT="$frontend_dir" "${compose[@]}" build frontend
   "${compose[@]}" up -d --no-deps frontend
   if wait_for http://127.0.0.1:3100/; then
      log "frontend deployed"
      return 0
   fi
   log "frontend unhealthy; rolling back"
   "${compose[@]}" logs --tail=80 frontend || true
   restore_previous everest-frontend
   "${compose[@]}" up -d --no-deps frontend
   exit 1
}

case "$target" in
   backend) deploy_backend ;;
   frontend) deploy_frontend ;;
   all) deploy_backend; deploy_frontend ;;
esac
