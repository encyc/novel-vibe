#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
MIGRATIONS_DIR=${MIGRATIONS_DIR:-"$ROOT_DIR/scripts/migrations"}
MODE=local
NETWORK=

if [[ "${1:-}" == "--list" ]]; then
  MODE=list
  shift
elif [[ "${1:-}" == "--docker-network" ]]; then
  [[ -n "${2:-}" ]] || { echo "--docker-network requires a network name" >&2; exit 2; }
  MODE=network
  NETWORK=$2
  shift 2
fi

[[ $# -eq 0 ]] || { echo "Unexpected arguments: $*" >&2; exit 2; }
[[ -d "$MIGRATIONS_DIR" ]] || { echo "Migration directory not found: $MIGRATIONS_DIR" >&2; exit 1; }

migrations=()
while IFS= read -r migration; do
  migrations+=("$migration")
done < <(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' -print | LC_ALL=C sort)

[[ ${#migrations[@]} -gt 0 ]] || { echo "No SQL migrations found in $MIGRATIONS_DIR" >&2; exit 1; }

if [[ "$MODE" == "list" ]]; then
  for migration in "${migrations[@]}"; do
    basename "$migration"
  done
  exit 0
fi

container=
if [[ "$MODE" == "local" ]]; then
  container=$(docker ps --filter label=com.docker.compose.service=postgres --format '{{.Names}}' | head -1)
  [[ -n "$container" ]] || { echo "No running Compose postgres service found." >&2; exit 1; }
fi

for migration in "${migrations[@]}"; do
  echo "Applying $(basename "$migration")..." >&2
  if [[ "$MODE" == "network" ]]; then
    : "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required for network migration mode}"
    docker run --rm -i --network "$NETWORK" \
      -e PGPASSWORD="$POSTGRES_PASSWORD" \
      postgres:15 psql \
      -v ON_ERROR_STOP=1 \
      -h "${POSTGRES_HOST:-postgres}" \
      -U "${POSTGRES_USER:-postgres}" \
      -d "${POSTGRES_DB:-insforge}" < "$migration"
  else
    docker exec -i "$container" \
      psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-insforge}" \
      < "$migration"
  fi
done

# PostgREST caches the DB schema and only refreshes on NOTIFY (its
# db-channel) or restart. Without this, newly created RPCs / grants (e.g.
# novel.credit_activity_by_day) stay invisible to the API until a manual
# reload — the profile credit pages then 404 with PGRST202. Best-effort: a
# down PostgREST or an unset channel must not fail the deploy.
PGRST_CHANNEL=${PGRST_CHANNEL:-pgrst}
echo "Notifying PostgREST to reload schema cache (channel: $PGRST_CHANNEL)..." >&2
if [[ "$MODE" == "network" ]]; then
  docker run --rm -i --network "$NETWORK" \
    -e PGPASSWORD="${POSTGRES_PASSWORD:-}" \
    postgres:15 psql \
    -h "${POSTGRES_HOST:-postgres}" \
    -U "${POSTGRES_USER:-postgres}" \
    -d "${POSTGRES_DB:-insforge}" \
    -c "NOTIFY $PGRST_CHANNEL, 'reload schema';" >&2 2>/dev/null || true
else
  docker exec -i "$container" \
    psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-insforge}" \
    -c "NOTIFY $PGRST_CHANNEL, 'reload schema';" >&2 2>/dev/null || true
fi
