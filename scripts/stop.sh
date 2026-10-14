#!/usr/bin/env bash
set -euo pipefail

PORT_AGENT=7140
PORT_WEB=9120
PORT_MCP=7150
PORT_WEBUI=5173

LAUNCH_DOMAIN="gui/$(id -u)"
LABEL_AGENT="com.novel-vibe.agent"
LABEL_WEB="com.novel-vibe.web"
LABEL_MCP="com.novel-vibe.mcp"
LABEL_WEBUI="com.novel-vibe.webui"

GREEN='\033[0;32m'
NC='\033[0m'

log() { printf "%b[novel-vibe]%b %s\n" "$GREEN" "$NC" "$1"; }

stop_launch_service() {
  local label="$1"
  launchctl bootout "$LAUNCH_DOMAIN/$label" >/dev/null 2>&1 || true
}

kill_port() {
  local port="$1"
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    printf "%s\n" "$pids" | xargs kill 2>/dev/null || true
  fi
}

stop_launch_service "$LABEL_AGENT"
stop_launch_service "$LABEL_WEB"
stop_launch_service "$LABEL_MCP"
stop_launch_service "$LABEL_WEBUI"

kill_port "$PORT_AGENT"
kill_port "$PORT_WEB"
kill_port "$PORT_MCP"
kill_port "$PORT_WEBUI"

rm -f /tmp/novel-vibe-agent.pid /tmp/novel-vibe-web.pid /tmp/novel-vibe-ui.pid

log "Stopped agent, web BFF, MCP, webui."
