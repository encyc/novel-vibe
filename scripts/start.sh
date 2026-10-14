#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INFRA_DIR="$ROOT_DIR/InsForge"
WEBUI_DIR="$ROOT_DIR/packages/novel-webui"

PORT_AGENT=7140
PORT_WEB=9120
PORT_MCP=7150
PORT_WEBUI=5173

LOG_DIR="${NOVEL_VIBE_LOG_DIR:-/tmp/novel-vibe-logs}"
LAUNCH_DIR="${NOVEL_VIBE_LAUNCH_DIR:-/tmp/novel-vibe-launchd}"
LAUNCH_DOMAIN="gui/$(id -u)"

LABEL_AGENT="com.novel-vibe.agent"
LABEL_WEB="com.novel-vibe.web"
LABEL_MCP="com.novel-vibe.mcp"
LABEL_WEBUI="com.novel-vibe.webui"

URL_INSFORGE="http://127.0.0.1:7130/api/health"
URL_AGENT="http://127.0.0.1:${PORT_AGENT}/api/health"
URL_WEB="http://127.0.0.1:${PORT_WEB}/health"
URL_MCP="http://127.0.0.1:${PORT_MCP}/health"
URL_WEBUI="http://127.0.0.1:${PORT_WEBUI}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log() { printf "%b[novel-vibe]%b %s\n" "$GREEN" "$NC" "$1"; }
warn() { printf "%b[novel-vibe]%b %s\n" "$YELLOW" "$NC" "$1"; }
err() { printf "%b[novel-vibe]%b %s\n" "$RED" "$NC" "$1" >&2; }

if [ "$(uname -s)" != "Darwin" ]; then
  err "scripts/start.sh drives the local macOS dev services (launchd-style logs)."
  err "On Linux, self-host with: ./scripts/local-start.sh   (see docs/self-hosting.md)"
  exit 1
fi

health_ok() {
  curl -fsS "$1" >/dev/null 2>&1
}

wait_for_url() {
  local url="$1"
  local name="$2"
  local seconds="${3:-15}"

  for _ in $(seq 1 "$seconds"); do
    if health_ok "$url"; then
      return 0
    fi
    sleep 1
  done

  err "$name did not become ready at $url"
  return 1
}

port_listening() {
  local port="$1"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

node_bin_dir() {
  local npm_bin
  npm_bin="$(command -v npm || true)"
  if [ -z "$npm_bin" ]; then
    err "npm not found in PATH"
    exit 1
  fi
  dirname "$npm_bin"
}

launch_path() {
  printf "%s:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" "$(node_bin_dir)"
}

write_launch_plist() {
  local label="$1"
  local workdir="$2"
  local command="$3"
  local log_file="$4"
  local plist_file="$5"

  mkdir -p "$LOG_DIR" "$LAUNCH_DIR"

  cat > "$plist_file" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>WorkingDirectory</key><string>$workdir</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(launch_path)</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-lc</string>
    <string>exec $command</string>
  </array>
  <key>StandardOutPath</key><string>$log_file</string>
  <key>StandardErrorPath</key><string>$log_file</string>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
EOF
}

start_launch_service() {
  local label="$1"
  local workdir="$2"
  local command="$3"
  local log_file="$4"
  local plist_file="$5"

  launchctl bootout "$LAUNCH_DOMAIN/$label" >/dev/null 2>&1 || true
  write_launch_plist "$label" "$workdir" "$command" "$log_file" "$plist_file"
  launchctl bootstrap "$LAUNCH_DOMAIN" "$plist_file"
}

start_infra() {
  log "Starting InsForge Docker services..."
  cd "$INFRA_DIR"
  docker compose up -d

  log "Waiting for InsForge API..."
  wait_for_url "$URL_INSFORGE" "InsForge API" 60
  log "InsForge ready."
}

start_agent() {
  if health_ok "$URL_AGENT"; then
    log "Agent already running on :$PORT_AGENT"
    return 0
  fi
  if port_listening "$PORT_AGENT"; then
    err "Port $PORT_AGENT is in use, but the agent health check failed."
    return 1
  fi

  log "Starting Agent Server on :$PORT_AGENT..."
  start_launch_service \
    "$LABEL_AGENT" \
    "$ROOT_DIR" \
    "$(command -v npx) tsx packages/novel-agents/server.ts" \
    "$LOG_DIR/agent.log" \
    "$LAUNCH_DIR/agent.plist"

  wait_for_url "$URL_AGENT" "Agent Server" 20 || {
    tail -n 80 "$LOG_DIR/agent.log" >&2 || true
    return 1
  }
  log "Agent ready on :$PORT_AGENT"
}

start_web() {
  if health_ok "$URL_WEB"; then
    log "Web BFF already running on :$PORT_WEB"
    return 0
  fi
  if port_listening "$PORT_WEB"; then
    err "Port $PORT_WEB is in use, but the Web BFF health check failed."
    return 1
  fi

  log "Starting Web BFF on :$PORT_WEB..."
  local web_command
  if [ -f "$ROOT_DIR/packages/novel-agents/.env" ]; then
    web_command="/bin/sh -lc 'set -a; . \"$ROOT_DIR/packages/novel-agents/.env\"; set +a; exec $(command -v npm) run web'"
  else
    web_command="$(command -v npm) run web"
  fi
  start_launch_service \
    "$LABEL_WEB" \
    "$ROOT_DIR" \
    "$web_command" \
    "$LOG_DIR/web.log" \
    "$LAUNCH_DIR/web.plist"

  wait_for_url "$URL_WEB" "Web BFF" 20 || {
    tail -n 80 "$LOG_DIR/web.log" >&2 || true
    return 1
  }
  log "Web BFF ready on :$PORT_WEB"
}

start_mcp() {
  if health_ok "$URL_MCP"; then log "MCP already running on :$PORT_MCP"; return 0; fi
  if port_listening "$PORT_MCP"; then err "Port $PORT_MCP is in use, but MCP health failed."; return 1; fi
  log "Starting MCP Server on :$PORT_MCP..."
  local command="$(command -v npm) run mcp"
  if [ -f "$ROOT_DIR/packages/novel-agents/.env" ]; then
    command="/bin/sh -lc 'set -a; . \"$ROOT_DIR/packages/novel-agents/.env\"; set +a; exec $(command -v npm) run mcp'"
  fi
  start_launch_service "$LABEL_MCP" "$ROOT_DIR" "$command" "$LOG_DIR/mcp.log" "$LAUNCH_DIR/mcp.plist"
  wait_for_url "$URL_MCP" "MCP Server" 20 || { tail -n 80 "$LOG_DIR/mcp.log" >&2 || true; return 1; }
  log "MCP ready on :$PORT_MCP"
}

start_ui() {
  if health_ok "$URL_WEBUI"; then
    log "WebUI already running on :$PORT_WEBUI"
    return 0
  fi
  if port_listening "$PORT_WEBUI"; then
    err "Port $PORT_WEBUI is in use, but the WebUI did not answer HTTP."
    return 1
  fi

  log "Starting WebUI on :$PORT_WEBUI..."
  start_launch_service \
    "$LABEL_WEBUI" \
    "$WEBUI_DIR" \
    "$(command -v npm) run dev -- --host 127.0.0.1 --port $PORT_WEBUI" \
    "$LOG_DIR/webui.log" \
    "$LAUNCH_DIR/webui.plist"

  wait_for_url "$URL_WEBUI" "WebUI" 20 || {
    tail -n 80 "$LOG_DIR/webui.log" >&2 || true
    return 1
  }
  log "WebUI ready on :$PORT_WEBUI"
}

case "${1:-all}" in
  --infra-only)
    start_infra
    ;;
  --agent-only)
    start_agent
    ;;
  --web-only)
    start_web
    ;;
  --ui-only)
    start_ui
    ;;
  --mcp-only)
    start_mcp
    ;;
  --dev-only)
    start_agent
    start_web
    start_mcp
    start_ui
    ;;
  all)
    start_infra
    start_agent
    start_web
    start_mcp
    start_ui
    echo ""
    log "All services running."
    log "  Web UI:       http://localhost:$PORT_WEBUI"
    log "  Web BFF:      http://localhost:$PORT_WEB"
    log "  MCP Server:   http://localhost:$PORT_MCP/mcp"
    log "  Agent Server: http://localhost:$PORT_AGENT"
    log "  InsForge:     http://localhost:7130 (API) http://localhost:7131 (Dashboard)"
    ;;
  *)
    err "Unknown option: $1"
    exit 2
    ;;
esac
