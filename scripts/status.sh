#!/usr/bin/env bash
set -euo pipefail

check() {
  local label="$1"
  local url="$2"

  printf "%-23s" "$label"
  if curl -fsS "$url" >/dev/null 2>&1; then
    echo "UP"
  else
    echo "DOWN"
  fi
}

echo "=== Service Status ==="
check "InsForge API (7130):" "http://127.0.0.1:7130/api/health"
check "Agent Server  (7140):" "http://127.0.0.1:7140/api/health"
check "Web BFF       (9120):" "http://127.0.0.1:9120/health"
check "WebUI         (5173):" "http://127.0.0.1:5173"
