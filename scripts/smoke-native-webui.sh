#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:9120}"
STATIC_URL="${STATIC_URL:-http://127.0.0.1:5173}"

err() { printf "[smoke-native-webui] %s\n" "$1" >&2; }
log() { printf "[smoke-native-webui] %s\n" "$1"; }

html="$(curl -fsS "$STATIC_URL/")"
if ! printf "%s" "$html" | grep -q 'name="novel-vibe-webui" content="native"'; then
  err "$STATIC_URL/ is not the native Novel Vibe WebUI build."
  exit 1
fi

status="$(curl -sS -o /tmp/novel-vibe-smoke-me.json -w "%{http_code}" "$BASE_URL/api/me")"
if [ "$status" != "401" ]; then
  err "$BASE_URL/api/me should return 401 without a session, got $status."
  cat /tmp/novel-vibe-smoke-me.json >&2 || true
  exit 1
fi

log "native WebUI marker and unauthenticated API guard passed."
