#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Novel Vibe — First-time local setup
# ============================================================
# Usage: make setup   (or: bash scripts/setup.sh)

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { printf "%b[setup]%b %s\n" "$GREEN" "$NC" "$1"; }
warn() { printf "%b[setup]%b %s\n" "$YELLOW" "$NC" "$1"; }
err()  { printf "%b[setup]%b %s\n" "$RED" "$NC" "$1" >&2; }

if [ "$(uname -s)" != "Darwin" ]; then
  err "scripts/setup.sh drives the local macOS development setup."
  err "On Linux, self-host with the same steps run by hand — see docs/self-hosting.md."
  err "Hosted server lifecycle lives in the private ops repository."
  exit 1
fi

# ── Prerequisites ──────────────────────────────────────────────

for cmd in node npm docker; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    err "$cmd is required but not installed."
    exit 1
  fi
done

# ── InsForge platform (public fork) ───────────────────────────
#
# InsForge is the backend this application runs on: auth, PostgreSQL, Storage
# (S3), the AI gateway and the dashboard. It is cloned from a **public** fork of
# the upstream project:
#
#   https://github.com/encyc/novel-vibe-insforge.git   (Apache-2.0)
#
# Override the URL with INSFORGE_REPO_URL when you mirror the fork, pin a
# revision, or test against a local copy:
#
#   INSFORGE_REPO_URL=https://example.com/insforge.git bash scripts/setup.sh
#
# The clone is idempotent: if InsForge/ already exists it is left untouched.
# InsForge/ is gitignored, so it lives next to this checkout without becoming
# part of it.
#
# Division of schemas:
#   • this repository ships the Novel Vibe *application* schema as
#     scripts/migrations/*.sql (applied by scripts/run-migrations.sh)
#   • the fork ships the InsForge *platform* schema (auth, storage, system,
#     realtime, deployments, pg_cron) plus the services themselves
#
# See docs/self-hosting.md for the full self-hosting walkthrough.

INSFORGE_REPO_URL="${INSFORGE_REPO_URL:-https://github.com/encyc/novel-vibe-insforge.git}"

clone_if_missing() {
  local repo_url="$1"
  local target_dir="$2"

  if [ -d "$target_dir" ]; then
    log "$target_dir/ already exists, skipping clone."
    return 0
  fi

  log "Cloning $target_dir from $repo_url..."
  git clone "$repo_url" "$target_dir"
}

clone_if_missing "$INSFORGE_REPO_URL" "InsForge"

# ── Environment files ──────────────────────────────────────────

if [ ! -f packages/novel-agents/.env ]; then
  env_template=""
  for candidate in packages/novel-agents/.env.example packages/novel-agents/.env.sample; do
    if [ -f "$candidate" ]; then
      env_template="$candidate"
      break
    fi
  done
  if [ -n "$env_template" ]; then
    cp "$env_template" packages/novel-agents/.env
    warn "Created packages/novel-agents/.env from $env_template — review and fill in API keys."
  else
    warn "No env template found for novel-agents. Create packages/novel-agents/.env before running agents."
  fi
fi

# Sync JWT_SECRET from novel-agents/.env to InsForge/.env so the services use
# the same signing key.
sync_jwt_secret() {
  local agents_env="$ROOT_DIR/packages/novel-agents/.env"
  local insforge_env="$ROOT_DIR/InsForge/.env"

  if [ ! -f "$agents_env" ]; then
    return
  fi

  local jwt_secret
  jwt_secret=$(grep '^JWT_SECRET=' "$agents_env" | head -1 | cut -d= -f2-)
  if [ -z "$jwt_secret" ]; then
    return
  fi

  if [ -f "$insforge_env" ]; then
    # Update existing value
    if grep -q '^JWT_SECRET=' "$insforge_env"; then
      local existing
      existing=$(grep '^JWT_SECRET=' "$insforge_env" | head -1 | cut -d= -f2-)
      if [ "$existing" = "$jwt_secret" ]; then
        return
      fi
      sed -i.bak "s|^JWT_SECRET=.*|JWT_SECRET=${jwt_secret}|" "$insforge_env" && rm -f "$insforge_env.bak"
      log "Updated JWT_SECRET in InsForge/.env"
    else
      echo "JWT_SECRET=${jwt_secret}" >> "$insforge_env"
      log "Added JWT_SECRET to InsForge/.env"
    fi
  else
    echo "JWT_SECRET=${jwt_secret}" > "$insforge_env"
    log "Created InsForge/.env with JWT_SECRET"
  fi
}

sync_jwt_secret

# ── Install dependencies ──────────────────────────────────────

log "Installing npm dependencies (root workspace)..."
npm install

# ── Done ───────────────────────────────────────────────────────

echo ""
log "Setup complete! Run 'make up' to start all services."
log "Novel Vibe application schema ships in this repo (scripts/migrations/*.sql)."
log "Apply it once the stack is up: 'make migrate-sessions' (runs scripts/run-migrations.sh)."
log "InsForge (services + platform schema) came from: $INSFORGE_REPO_URL"
log "Self-hosting walkthrough: docs/self-hosting.md"
