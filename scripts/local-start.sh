#!/usr/bin/env bash
#
# Start Novel Vibe in local-first mode.
#
# One command, one machine, one person, no author-operated service in the path:
# InsForge (PostgreSQL + storage) runs from the bundled compose file, and both the
# agent server and the Web BFF run with NOVEL_VIBE_LOCAL_MODE=true, which replaces
# the sign-in step with a locally minted identity (see lib/local-mode.ts).
#
# Local mode still needs a PostgreSQL, by decision — see ADR 0007. It does NOT need
# an InsForge account, an internet connection, or any author API key.
#
# Usage:  ./scripts/local-start.sh [--stop]
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env.local"
LOG_DIR="${NOVEL_VIBE_LOG_DIR:-/tmp/novel-vibe-logs}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { printf "%b[local]%b %s\n" "$GREEN" "$NC" "$1"; }
warn() { printf "%b[local]%b %s\n" "$YELLOW" "$NC" "$1"; }
err()  { printf "%b[local]%b %s\n" "$RED" "$NC" "$1" >&2; }

if [ "${1:-}" = "--stop" ]; then
  log "Stopping application services (PostgreSQL keeps running; use docker compose down to remove it)"
  pkill -f "tsx packages/novel-agents/server.ts" 2>/dev/null || true
  pkill -f "tsx src/server.ts" 2>/dev/null || true
  exit 0
fi

command -v docker >/dev/null 2>&1 || { err "Docker is required in local mode (see docs/adr/0007-keep-postgres-for-local-mode.md)"; exit 1; }

# ---------------------------------------------------------------------------
# Local secrets
#
# JWT_SECRET signs the locally minted identity. It is generated once and kept in
# .env.local (mode 0600, gitignored) rather than shipped or derived from anything
# public: regenerating it invalidates nothing permanent, but keeping it stable
# avoids churn in local sessions.
#
# BYOK_ENCRYPTION_KEY is deliberately NOT set here — the application provisions a
# local key file itself in local mode, and leaving it unset keeps that path honest.
# ---------------------------------------------------------------------------
SECRET_WAS_GENERATED=0
if [ ! -f "$ENV_FILE" ]; then
  log "Creating $ENV_FILE with a fresh local JWT_SECRET"
  umask 077
  printf 'JWT_SECRET=%s\n' "$(openssl rand -hex 32)" > "$ENV_FILE"
  SECRET_WAS_GENERATED=1
fi
chmod 600 "$ENV_FILE"
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

export NOVEL_VIBE_LOCAL_MODE=true
export NOVEL_VIBE_LOCAL_MODE
log "NOVEL_VIBE_LOCAL_MODE=true"

# ---------------------------------------------------------------------------
# Infrastructure
# ---------------------------------------------------------------------------
mkdir -p "$LOG_DIR"
if ! curl -fsS http://127.0.0.1:7130/api/health >/dev/null 2>&1; then
  log "Starting InsForge (PostgreSQL + storage)…"
  ( cd "$ROOT_DIR/InsForge" && docker compose up -d )
  for _ in $(seq 1 60); do
    curl -fsS http://127.0.0.1:7130/api/health >/dev/null 2>&1 && break
    sleep 1
  done
  curl -fsS http://127.0.0.1:7130/api/health >/dev/null 2>&1 \
    || { err "InsForge did not become ready on :7130"; exit 1; }
else
  log "InsForge already healthy"
fi

# ---------------------------------------------------------------------------
# Schema
#
# Migrations are not optional in local mode: `novel.projects.owner_id` references
# `auth.users(id)`, and the local owner row is created by `novel.ensure_local_user`
# (migration 040). Without that RPC the first "create project" fails on the foreign
# key. run-migrations.sh also NOTIFYs PostgREST to reload its schema cache — without
# that, a freshly created RPC stays invisible and the API answers PGRST202.
# ---------------------------------------------------------------------------
log "Applying migrations…"
( cd "$ROOT_DIR" && bash scripts/run-migrations.sh ) >/dev/null 2>&1 \
  || { err "Migrations failed — run 'cd $ROOT_DIR && bash scripts/run-migrations.sh' to see why"; exit 1; }
log "Migrations applied, PostgREST schema cache reloaded"

# The agent server signs the local identity with JWT_SECRET, and PostgREST verifies
# it with the secret its container was created with. If they differ, every database
# call fails with an opaque 401 JWSInvalidSignature.
#
# An InsForge instance may already be running with its own secret. If we generated
# the secret ourselves there is nothing to preserve, so adopt the container's and
# stay quiet about it. Only a secret the user pinned deliberately is an error —
# silently overwriting that would invalidate every existing session.
INSFORGE_CONTAINER="$(docker ps --filter label=com.docker.compose.service=insforge --format '{{.Names}}' | head -1)"
CONTAINER_SECRET="$(docker exec "$INSFORGE_CONTAINER" printenv JWT_SECRET 2>/dev/null || true)"
if [ -n "$CONTAINER_SECRET" ] && [ "$CONTAINER_SECRET" != "${JWT_SECRET:-}" ]; then
  if [ "$SECRET_WAS_GENERATED" = "1" ]; then
    warn "Adopting the running InsForge container's JWT_SECRET into $ENV_FILE"
    umask 077
    printf 'JWT_SECRET=%s\n' "$CONTAINER_SECRET" > "$ENV_FILE"
    export JWT_SECRET="$CONTAINER_SECRET"
  else
    err "$ENV_FILE has a JWT_SECRET that differs from the running InsForge container."
    err "Either recreate the container to match it:"
    err "    (cd $ROOT_DIR/InsForge && docker compose down && docker compose up -d)"
    err "or delete $ENV_FILE to adopt the container's secret (invalidates local sessions)."
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Application services
# ---------------------------------------------------------------------------
start_service() {
  local name="$1" health="$2"; shift 2
  if curl -fsS "$health" >/dev/null 2>&1; then log "$name already running"; return 0; fi
  log "Starting $name…"
  ( cd "$ROOT_DIR" && nohup "$@" > "$LOG_DIR/$name.log" 2>&1 & )
}

start_service "agent-server" "http://127.0.0.1:7140/api/health" \
  npx tsx packages/novel-agents/server.ts
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:7140/api/health >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS http://127.0.0.1:7140/api/health >/dev/null 2>&1 \
  || { err "Agent server did not become ready on :7140 — see $LOG_DIR/agent-server.log"; exit 1; }

# Record the PID so ./scripts/local-e2e.sh restarts exactly this process and never
# an unrelated checkout's agent server that happens to be listening elsewhere.
AGENT_PID_FILE="${NOVEL_VIBE_AGENT_PID_FILE:-/tmp/novel-vibe-local-agent.pid}"
if [ ! -f "$AGENT_PID_FILE" ] || ! kill -0 "$(cat "$AGENT_PID_FILE" 2>/dev/null)" 2>/dev/null; then
  pgrep -f "novel-agents/server.ts" | tail -1 > "$AGENT_PID_FILE" || true
fi
log "Agent server PID recorded at $AGENT_PID_FILE"

start_service "web-bff" "http://127.0.0.1:9120/health" \
  npm --workspace @novel-vibe/web run server

cat <<EOF

$(log "Local mode is up")
  WebUI (dev server):  npm run webui:new   →  http://localhost:5173
  Web BFF:             http://localhost:9120
  Agent API:           http://localhost:7140

  No account is needed. Add a model key in 设置 → 自带模型密钥, then create a
  project and start writing.

  Verify the whole loop:   ./scripts/local-e2e.sh
  Logs:                    $LOG_DIR
  Stop:                    ./scripts/local-start.sh --stop
EOF
