#!/usr/bin/env bash
#
# dev-logs.sh — unified dev log viewer for Novel Vibe (macOS local dev).
#
# Tails one or more service logs (agent / web / webui), prefixing every line
# with HH:MM:SS.mmm and a colored service tag, and filters out pure dev-noise
# (Vite HMR, dotenv banners, launchd-restart boilerplate, Node warnings).
#
# Usage:
#   scripts/dev-logs.sh [all|agent|web|webui] [--verbose]
#
# --verbose disables the noise filter so you can see everything.
#
# Log directory honors $NOVEL_VIBE_LOG_DIR (same env var as scripts/start.sh),
# defaulting to /tmp/novel-vibe-logs.

set -euo pipefail

LOG_DIR="${NOVEL_VIBE_LOG_DIR:-/tmp/novel-vibe-logs}"

# ─── ANSI colors ───────────────────────────────────────────────────────
MAGENTA=$'\033[35m'
CYAN=$'\033[36m'
GREEN=$'\033[32m'
DIM=$'\033[2m'
RESET=$'\033[0m'

# ─── Parse args ────────────────────────────────────────────────────────
SCOPE="all"
VERBOSE=0
for arg in "$@"; do
  case "$arg" in
    all|agent|web|webui) SCOPE="$arg" ;;
    --verbose|-v) VERBOSE=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# ─── Noise filter (dev-only chatter that is never useful signal) ───────
# Real errors, stack traces, [startup] lines, and ready banners pass through.
# Vite prints "[vite] (client) ..." so we match with .* between tag and verb.
NOISE_REGEX='\[vite\].*(hmr (update|invalidate)|Re-optimizing)'\
'|injected env .*(dotenvx|vestauth|encrypted \.env)'\
'|// tip:'\
'|npm error (code 143|path |workspace |location |command )'\
'|^> @'\
'|^> .*run '\
'|node:[0-9]+\)? Warning:'\
'|Use `node --trace-warnings'\
'|^[[:space:]]*$'

# ─── Prefixer: stamp + colored tag, optional noise filter ──────────────
# Reads stdin, writes prefixed lines to stdout. Unbuffered via fflush().
# Note: macOS BSD date has no %N, so we stamp seconds only (HH:MM:SS).
# App log lines already carry full ISO timestamps from the logger module.
prefix() {
  local name="$1" color="$2"
  awk -v name="$name" -v color="$color" -v dim="$DIM" -v reset="$RESET" \
      -v noise="$NOISE_REGEX" -v verbose="$VERBOSE" '
    {
      line = $0
      if (verbose == 0 && line ~ noise) next
      "date +%H:%M:%S" | getline ts
      close("date +%H:%M:%S")
      printf "%s%s %s%s%s %s\n", dim, ts, color, name, reset, line
      fflush()
    }
  '
}

# ─── Tail a single service ─────────────────────────────────────────────
tail_one() {
  local name="$1" color="$2" file="$3"
  if [ ! -f "$file" ]; then
    printf "%s[%s] no log file yet: %s%s\n" "$color" "$name" "$file" "$RESET" >&2
    printf "    (start the service first: make up / make agent / make webui)\n" >&2
    return
  fi
  # shellcheck disable=SC2016
  tail -F -n0 "$file" 2>/dev/null | prefix "$name" "$color"
}

# ─── Select files ──────────────────────────────────────────────────────
mkdir -p "$LOG_DIR"

case "$SCOPE" in
  agent) tail_one "agent" "$MAGENTA" "$LOG_DIR/agent.log" ;;
  web)   tail_one "web"   "$CYAN"    "$LOG_DIR/web.log" ;;
  webui) tail_one "webui" "$GREEN"   "$LOG_DIR/webui.log" ;;
  all)
    # Tail all three concurrently, merged into one tagged stream.
    # tail -F on multiple files prints ==> headers on rotation; we suppress
    # by running one tail per file through the prefixer in the background.
    trap 'exit 0' INT TERM
    tail_one "agent" "$MAGENTA" "$LOG_DIR/agent.log" &
    tail_one "web"   "$CYAN"    "$LOG_DIR/web.log" &
    tail_one "webui" "$GREEN"   "$LOG_DIR/webui.log" &
    wait
    ;;
esac
