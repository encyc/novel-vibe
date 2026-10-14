#!/usr/bin/env bash
#
# Prove the local-first loop end to end, with NO cloud service and NO login.
#
# The loop under test is the milestone from the research report:
#
#   create a project → open a session → write a document → restart the agent
#   server → the history is still there
#
# Deliberately does NOT call a model. The agent's own model call needs the user's
# API key, which cannot be assumed in a check like this, and a stubbed model would
# prove nothing about the real path. Set LOCAL_E2E_CHAT=1 to additionally attempt
# one real chat turn (requires a BYOK key already saved).
#
# Nothing here sends an Authorization header: local mode must authenticate the
# request by itself.
#
# Usage:  ./scripts/local-e2e.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${NOVEL_VIBE_AGENT_URL:-http://127.0.0.1:7140}"

GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
pass() { printf "  %bok%b  %s\n" "$GREEN" "$NC" "$1"; }
fail() { printf "  %bFAIL%b %s\n" "$RED" "$NC" "$1"; exit 1; }

api() { # api METHOD PATH [BODY]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -fsS -X "$method" "$BASE$path" -H "Content-Type: application/json" -d "$body"
  else
    curl -fsS -X "$method" "$BASE$path"
  fi
}

echo "Local-first end-to-end check against $BASE"
echo

echo "1. Local mode is on and the server answers without credentials"
api GET /api/health >/dev/null || fail "/api/health unreachable — run ./scripts/local-start.sh first"
pass "agent server reachable, no Authorization header sent"

echo
echo "2. Create a project as the local user"
PROJECT_JSON="$(api POST /api/projects "{\"title\":\"Local E2E $(date +%s)\",\"genre\":\"test\",\"synopsis\":\"created by local-e2e.sh\"}")"
PROJECT_ID="$(printf '%s' "$PROJECT_JSON" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
[ -n "$PROJECT_ID" ] || fail "no project id in response: $PROJECT_JSON"
pass "project created: $PROJECT_ID"

echo
echo "3. Open a session"
SESSION_JSON="$(api POST "/api/projects/$PROJECT_ID/sessions" '{}')"
SESSION_ID="$(printf '%s' "$SESSION_JSON" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
[ -n "$SESSION_ID" ] || fail "no session id in response: $SESSION_JSON"
pass "session created: $SESSION_ID"

echo
echo "4. Write a novel document (Markdown + frontmatter is the source of truth)"
DOC_PATH="worldview/setting.md"
api PUT "/api/documents/$PROJECT_ID/$DOC_PATH" \
  '{"base_hash":"","content":"---\ntype: worldview\ncategory: rule\nname: Local Mode Worldview\nstatus: draft\nimportance: 5\nrelated:\n  characters: []\n  chapters: []\n  world_elements: []\n---\n\nWritten by local-e2e.sh to prove the local loop."}' >/dev/null
READ_BACK="$(api GET "/api/documents/$PROJECT_ID/$DOC_PATH")"
printf '%s' "$READ_BACK" | grep -q "Written by local-e2e.sh" || fail "document did not read back: $READ_BACK"
pass "document written and read back: $DOC_PATH"

echo
echo "5. It is indexed (document list is DB-backed, not filesystem-scanned)"
api GET "/api/documents/$PROJECT_ID" | grep -q "$DOC_PATH" || fail "document missing from the index"
pass "document appears in the project index"

echo
echo "6. Restart the agent server and confirm the history survived"
# Restart by PID, never by pattern: a `pkill -f` on the server path would also kill
# an unrelated checkout's agent server that happens to be running.
PID_FILE="${NOVEL_VIBE_AGENT_PID_FILE:-/tmp/novel-vibe-local-agent.pid}"
[ -f "$PID_FILE" ] || fail "no agent PID file at $PID_FILE — start with ./scripts/local-start.sh so the restart step can target the right process"
AGENT_PID="$(cat "$PID_FILE")"
kill "$AGENT_PID" 2>/dev/null || true
for _ in $(seq 1 20); do
  kill -0 "$AGENT_PID" 2>/dev/null || break
  sleep 0.5
done
# `npx tsx` runs the server in a child process, so the recorded PID can exit while
# the listener survives. The port being tested belongs to the server under test by
# construction, so freeing it is safe here.
PORT="$(printf '%s' "$BASE" | sed -n 's|.*:\([0-9]*\)$|\1|p')"
for _ in $(seq 1 20); do
  lsof -tnP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
  for pid in $(lsof -tnP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
  sleep 0.5
done
# Inherit the caller's environment so NOVEL_VIBE_LOCAL_MODE (and a non-default
# NOVEL_VIBE_PORT, used when another instance already owns 7140) carry over.
export NOVEL_VIBE_LOCAL_MODE=true
( cd "$ROOT_DIR" && nohup npx tsx packages/novel-agents/server.ts \
    > "${NOVEL_VIBE_LOG_DIR:-/tmp/novel-vibe-logs}/agent-server.log" 2>&1 & echo $! > "$PID_FILE" )
for _ in $(seq 1 40); do
  curl -fsS "$BASE/api/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "$BASE/api/health" >/dev/null 2>&1 || fail "agent server did not come back up"
pass "agent server restarted"

api GET "/api/projects/$PROJECT_ID" | grep -q "$PROJECT_ID" || fail "project did not survive the restart"
pass "project survived the restart"

api GET "/api/documents/$PROJECT_ID/$DOC_PATH" | grep -q "Written by local-e2e.sh" || fail "document did not survive the restart"
pass "document survived the restart"

api GET "/api/projects/$PROJECT_ID/sessions" | grep -q "$SESSION_ID" || fail "session did not survive the restart"
pass "session survived the restart"

if [ "${LOCAL_E2E_CHAT:-0}" = "1" ]; then
  echo
  echo "7. One real chat turn (LOCAL_E2E_CHAT=1)"
  CHAT="$(curl -fsS -N -X POST "$BASE/api/chat" -H "Content-Type: application/json" \
    -d "{\"project_id\":\"$PROJECT_ID\",\"session_id\":\"$SESSION_ID\",\"message\":\"用一句话问候我\"}" \
    --max-time 180 | head -c 4000 || true)"
  printf '%s' "$CHAT" | grep -q "turn_started" || fail "chat did not start: $CHAT"
  pass "chat turn started (needs a saved BYOK key to complete)"
else
  echo
  echo "7. Skipped the real chat turn (set LOCAL_E2E_CHAT=1 to include it; it needs a saved model key)"
fi

echo
printf "%bLocal-first loop verified: no login, no cloud service, data survived a restart.%b\n" "$GREEN" "$NC"
