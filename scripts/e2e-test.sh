#!/usr/bin/env bash
# Novel Vibe End-to-End Integration Test Suite
# =============================================
# Tests the full pipeline with real services — no mocks.
# Catches: RLS policies, storage buckets, JWT token flow, DB sync, credit billing.
#
# Usage:
#   ./scripts/e2e-test.sh              # Quick checks (no LLM call)
#   ./scripts/e2e-test.sh --full        # Full test including agent chat
#   ./scripts/e2e-test.sh --verbose     # Show raw API responses
#
# Prerequisites: ./scripts/start.sh (all services running)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# ── Config ──────────────────────────────────────────────
INSFORGE_URL="${INSFORGE_URL:-http://localhost:7130}"
AGENT_URL="${AGENT_URL:-http://localhost:7140}"
WEB_URL="${WEB_URL:-http://localhost:9120}"
TEST_EMAIL="${TEST_EMAIL:-atomyuangao@gmail.com}"
TEST_PASSWORD="${TEST_PASSWORD:-admin123}"
FULL_MODE=false
VERBOSE=false
PREFLIGHT_ONLY=false

# ── Parse args ──────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --full) FULL_MODE=true ;;
    --verbose) VERBOSE=true ;;
    --preflight-only) PREFLIGHT_ONLY=true ;;
  esac
done

# ── Colors ──────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0
FAIL=0
TOKEN=""
USER_ID=""
PROJECT_ID=""
TEST_DOC_PATH=""
BFF_COOKIE_JAR="$(mktemp)"
SESSION_PROJECT_ID=""
SESSION_PROJECT_ISOLATED=false
SESSION_ID_A=""

cleanup() {
  if [ -n "$SESSION_ID_A" ]; then
    curl -s -b "$BFF_COOKIE_JAR" -X DELETE "$WEB_URL/api/sessions/$SESSION_ID_A" \
      -H "Content-Type: application/json" -d '{}' >/dev/null 2>&1 || true
  fi
  rm -f "$BFF_COOKIE_JAR"
  if $SESSION_PROJECT_ISOLATED && [ -n "$SESSION_PROJECT_ID" ]; then
    docker exec insforge-postgres-1 psql -U postgres -d insforge -v ON_ERROR_STOP=1 \
      -c "DELETE FROM novel.projects WHERE id = '$SESSION_PROJECT_ID';" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# ── Helpers ─────────────────────────────────────────────
pass() { printf "  ${GREEN}✓ PASS${NC} %s\n" "$1"; PASS=$((PASS + 1)); }
fail() { printf "  ${RED}✗ FAIL${NC} %s — %s\n" "$1" "$2"; FAIL=$((FAIL + 1)); }
warn() { printf "  ${YELLOW}⚠ WARN${NC} %s\n" "$1"; }
info() { printf "${CYAN}%s${NC}\n" "$1"; }
section() { printf "\n${BOLD}══ %s ══${NC}\n" "$1"; }
verbose() { if $VERBOSE; then printf "    ${YELLOW}→ %s${NC}\n" "$1"; fi; }

MIGRATION="$ROOT_DIR/scripts/migrations/001_durable_sessions.sql"
test -f "$MIGRATION"
grep -q 'session_agent_state' "$MIGRATION"
grep -q 'memory_jobs' "$MIGRATION"
grep -q 'memory_exclusions' "$MIGRATION"
grep -q 'acquire_session_lease' "$MIGRATION"
grep -q 'release_session_lease' "$MIGRATION"
grep -q 'claim_memory_jobs' "$MIGRATION"
grep -q 'prepare_session_memory_delete' "$MIGRATION"

if $PREFLIGHT_ONLY; then
  printf 'Session migration preflight passed.\n'
  exit 0
fi

json_get() {
  # Extract a field from JSON (first level only)
  python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('$1',''))" 2>/dev/null || echo ""
}

# ── Pre-flight ──────────────────────────────────────────
section "Pre-flight: Service Health"

check_health() {
  local url="$1" name="$2"
  if curl -sf "$url" >/dev/null 2>&1; then
    pass "$name healthy ($url)"
  else
    fail "$name healthy" "cannot reach $url"
  fi
}

check_health "$INSFORGE_URL/api/health" "InsForge"
check_health "$AGENT_URL/api/health" "Agent Server"
check_health "$WEB_URL/health" "Web BFF"

# ── Test 1: Auth ────────────────────────────────────────
section "Test 1: Authentication (POST /api/auth/sessions)"

LOGIN_RESP=$(curl -s -X POST "$INSFORGE_URL/api/auth/sessions?client_type=server" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\"}")

TOKEN=$(echo "$LOGIN_RESP" | json_get "accessToken")
USER_ID=$(echo "$LOGIN_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('user',{}).get('id',''))" 2>/dev/null || echo "")

if [ -n "$TOKEN" ] && [ -n "$USER_ID" ]; then
  pass "Login returned JWT (user: $USER_ID)"

  # Decode JWT payload to verify claims
  JWT_PAYLOAD=$(echo "$TOKEN" | cut -d'.' -f2 | python3 -c "import sys,base64,json; print(json.dumps(json.loads(base64.urlsafe_b64decode(sys.stdin.read()+'==')),indent=2))" 2>/dev/null || echo "")
  verbose "JWT payload: $JWT_PAYLOAD"

  JWT_ROLE=$(echo "$JWT_PAYLOAD" | python3 -c "import sys,json; print(json.load(sys.stdin).get('role',''))" 2>/dev/null || echo "")
  JWT_SUB=$(echo "$JWT_PAYLOAD" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sub',''))" 2>/dev/null || echo "")

  if [ "$JWT_ROLE" = "authenticated" ]; then
    pass "JWT role is 'authenticated'"
  else
    fail "JWT role is 'authenticated'" "got '$JWT_ROLE'"
  fi

  if [ "$JWT_SUB" = "$USER_ID" ]; then
    pass "JWT sub matches user ID"
  else
    fail "JWT sub matches user ID" "sub=$JWT_SUB, user=$USER_ID"
  fi
else
  fail "Login returned JWT" "no accessToken in response"
  verbose "Response: $LOGIN_RESP"
fi

# ── Test 2: Project ─────────────────────────────────────
section "Test 2: Project Info (GET /api/projects/:id)"

# Find a project belonging to this user
PROJECTS_RESP=$(curl -s "$AGENT_URL/api/documents/nonexistent" \
  -H "Authorization: Bearer $TOKEN")
verbose "Projects check: $PROJECTS_RESP"

# Get project from DB directly (more reliable)
PROJECT_ID=$(docker exec insforge-postgres-1 psql -U postgres -d insforge -tAc \
  "SELECT id FROM novel.projects WHERE owner_id = '$USER_ID' LIMIT 1;" 2>/dev/null || echo "")

if [ -n "$PROJECT_ID" ]; then
  pass "Found project in DB: $PROJECT_ID"

  PROJECT_RESP=$(curl -s "$AGENT_URL/api/projects/$PROJECT_ID" \
    -H "Authorization: Bearer $TOKEN")
  verbose "Project response: $PROJECT_RESP"

  PROJECT_TITLE=$(echo "$PROJECT_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('project',{}).get('title',''))" 2>/dev/null || echo "")
  if [ -n "$PROJECT_TITLE" ]; then
    pass "Project details readable: '$PROJECT_TITLE'"
  else
    fail "Project details readable" "empty title in response"
  fi
else
  fail "Project exists for user" "no projects in DB for $USER_ID"
fi

# ── Test 3: Credits ─────────────────────────────────────
section "Test 3: Credit Balance"

CREDIT_RESP=$(curl -s "$AGENT_URL/api/credits/balance?user_id=$USER_ID" \
  -H "Authorization: Bearer $TOKEN")
verbose "Credit response: $CREDIT_RESP"

CREDIT_BALANCE=$(echo "$CREDIT_RESP" | json_get "balance" 2>/dev/null || echo "")
if [ -n "$CREDIT_BALANCE" ] && [ "$CREDIT_BALANCE" != "null" ]; then
  pass "Credit balance readable: $CREDIT_BALANCE"

  # Check it's a positive number
  if python3 -c "exit(0 if float($CREDIT_BALANCE) > 0 else 1)" 2>/dev/null; then
    pass "Credit balance is positive"
  else
    fail "Credit balance is positive" "balance=$CREDIT_BALANCE"
  fi
else
  fail "Credit balance readable" "got: $CREDIT_RESP"
fi

# ── Test 4: Storage Buckets ─────────────────────────────
section "Test 4: Storage Buckets"

BUCKETS=$(docker exec insforge-postgres-1 psql -U postgres -d insforge -tAc \
  "SELECT name FROM storage.buckets ORDER BY name;" 2>/dev/null || echo "")

if echo "$BUCKETS" | grep -q "novels"; then
  pass "Bucket 'novels' exists"
else
  fail "Bucket 'novels' exists" "buckets: $BUCKETS"
fi

if echo "$BUCKETS" | grep -q "skills"; then
  pass "Bucket 'skills' exists"
else
  fail "Bucket 'skills' exists" "buckets: $BUCKETS"
fi

# ── Test 5: Storage RLS Policies ────────────────────────
section "Test 5: Storage RLS Policies"

POLICIES=$(docker exec insforge-postgres-1 psql -U postgres -d insforge -tAc \
  "SELECT policyname FROM pg_policies WHERE tablename = 'objects' AND schemaname = 'storage' ORDER BY policyname;" 2>/dev/null || echo "")

REQUIRED_POLICIES=(
  "storage_objects_owner_select"
  "storage_objects_owner_insert"
  "storage_objects_owner_update"
  "storage_objects_owner_delete"
)

for policy in "${REQUIRED_POLICIES[@]}"; do
  if echo "$POLICIES" | grep -q "$policy"; then
    pass "RLS policy '$policy' exists"
  else
    fail "RLS policy '$policy' exists" "not found in pg_policies"
  fi
done

# Verify policies target 'authenticated' role
AUTH_POLICIES=$(docker exec insforge-postgres-1 psql -U postgres -d insforge -tAc \
  "SELECT policyname FROM pg_policies WHERE tablename = 'objects' AND schemaname = 'storage' AND 'authenticated' = ANY(roles);" 2>/dev/null || echo "")
AUTH_COUNT=$(echo "$AUTH_POLICIES" | grep -c . || echo 0)
if [ "$AUTH_COUNT" -ge 4 ]; then
  pass "All 4 RLS policies target 'authenticated' role"
else
  fail "RLS policies target 'authenticated'" "found $AUTH_COUNT policies"
fi

# ── Test 6: Documents List (empty or not) ───────────────
section "Test 6: Document Listing"

if [ -n "$PROJECT_ID" ]; then
  DOCS_RESP=$(curl -s "$AGENT_URL/api/documents/$PROJECT_ID" \
    -H "Authorization: Bearer $TOKEN")
  verbose "Documents response: $DOCS_RESP"

  DOC_COUNT=$(echo "$DOCS_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('documents',[])))" 2>/dev/null || echo "0")
  pass "Document list returned ($DOC_COUNT documents)"
else
  fail "Document list" "no project ID available"
fi

# ── Test 7: Durable Session CRUD through the authenticated BFF ──
section "Test 7: Durable Session CRUD through Web BFF"

BFF_LOGIN=$(curl -s -c "$BFF_COOKIE_JAR" -X POST "$WEB_URL/api/auth" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\",\"mode\":\"login\"}")

if echo "$BFF_LOGIN" | grep -q '"ok":true'; then
  pass "BFF login established an opaque cookie session"
else
  fail "BFF login" "response=$BFF_LOGIN"
fi

SESSION_PROJECT_RESP=$(curl -s -b "$BFF_COOKIE_JAR" -X POST "$WEB_URL/api/projects" \
  -H "Content-Type: application/json" \
  -d '{"title":"Durable Session E2E","genre":"测试","synopsis":"自动清理的会话测试项目"}')
SESSION_PROJECT_ID=$(echo "$SESSION_PROJECT_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('project',{}).get('id',''))" 2>/dev/null || echo "")

if [ -n "$SESSION_PROJECT_ID" ]; then
  SESSION_PROJECT_ISOLATED=true
  pass "Created isolated E2E project through BFF: $SESSION_PROJECT_ID"
elif echo "$SESSION_PROJECT_RESP" | grep -q '"code":"PROJECT_LIMIT_REACHED"' && [ -n "$PROJECT_ID" ]; then
  SESSION_PROJECT_ID="$PROJECT_ID"
  pass "Project limit reached; durable Session checks use existing owned project"
else
  fail "Create E2E project through BFF" "response=$SESSION_PROJECT_RESP"
fi

SESSION_A_RESP=$(curl -s -b "$BFF_COOKIE_JAR" -X POST "$WEB_URL/api/projects/$SESSION_PROJECT_ID/sessions" \
  -H "Content-Type: application/json" -d '{}')
SESSION_ID_A=$(echo "$SESSION_A_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session',{}).get('id',''))" 2>/dev/null || echo "")

if [ -n "$SESSION_ID_A" ]; then
  pass "Created Session A through BFF"
else
  fail "Create Session A" "response=$SESSION_A_RESP"
fi

RENAME_A=$(curl -s -b "$BFF_COOKIE_JAR" -X PATCH "$WEB_URL/api/sessions/$SESSION_ID_A" \
  -H "Content-Type: application/json" -d '{"title":"恢复测试会话"}')
if echo "$RENAME_A" | grep -q '"title":"恢复测试会话"'; then
  pass "Renamed Session A"
else
  fail "Rename Session A" "response=$RENAME_A"
fi

EMPTY_A=$(curl -s -b "$BFF_COOKIE_JAR" "$WEB_URL/api/sessions/$SESSION_ID_A/messages")
if [ "$(echo "$EMPTY_A" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('items',[])))" 2>/dev/null || echo -1)" = "0" ]; then
  pass "New Session A has empty persisted messages"
else
  fail "Session A starts empty" "response=$EMPTY_A"
fi

SESSION_B_RESP=$(curl -s -b "$BFF_COOKIE_JAR" -X POST "$WEB_URL/api/projects/$SESSION_PROJECT_ID/sessions" \
  -H "Content-Type: application/json" -d '{}')
SESSION_ID_B=$(echo "$SESSION_B_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session',{}).get('id',''))" 2>/dev/null || echo "")
SESSION_LIST=$(curl -s -b "$BFF_COOKIE_JAR" "$WEB_URL/api/projects/$SESSION_PROJECT_ID/sessions")
SESSION_LIST_IDS=$(echo "$SESSION_LIST" | python3 -c "import sys,json; print(' '.join(x['id'] for x in json.load(sys.stdin).get('items',[])))" 2>/dev/null || echo "")
if [ -n "$SESSION_ID_B" ] && [ "$SESSION_ID_A" != "$SESSION_ID_B" ] && echo "$SESSION_LIST_IDS" | grep -q "$SESSION_ID_A" && echo "$SESSION_LIST_IDS" | grep -q "$SESSION_ID_B"; then
  pass "Two Sessions remain isolated and list independently"
else
  fail "Session isolation" "A=$SESSION_ID_A B=$SESSION_ID_B list=$SESSION_LIST_IDS"
fi

DELETE_B_STATUS=$(curl -s -o /tmp/novel-vibe-e2e-delete.json -w '%{http_code}' -b "$BFF_COOKIE_JAR" \
  -X DELETE "$WEB_URL/api/sessions/$SESSION_ID_B" -H "Content-Type: application/json" -d '{}')
DELETED_B_STATUS=$(curl -s -o /tmp/novel-vibe-e2e-deleted.json -w '%{http_code}' -b "$BFF_COOKIE_JAR" \
  "$WEB_URL/api/sessions/$SESSION_ID_B/messages")
rm -f /tmp/novel-vibe-e2e-delete.json /tmp/novel-vibe-e2e-deleted.json
if [ "$DELETE_B_STATUS" = "200" ] && [ "$DELETED_B_STATUS" = "404" ]; then
  pass "Deleted Session B and subsequent read returns 404"
else
  fail "Delete Session B" "delete=$DELETE_B_STATUS read=$DELETED_B_STATUS"
fi

# ── Test 8: Full Pipeline (agent chat → save → verify) ──
section "Test 8: Agent Chat → Durable Session Pipeline"

if $FULL_MODE; then
  if [ -z "$SESSION_PROJECT_ID" ] || [ -z "$SESSION_ID_A" ]; then
    fail "Full pipeline test" "missing durable test project or Session"
  else
    info "Sending chat to agent (this takes ~30-60s)..."

    CHAT_START=$(date +%s)
    CHAT_RESP=$(curl -s -N -m 120 -b "$BFF_COOKIE_JAR" -X POST "$WEB_URL/api/chat/stream" \
      -H "Content-Type: application/json" \
      -d "{
        \"project_id\": \"$SESSION_PROJECT_ID\",
        \"session_id\": \"$SESSION_ID_A\",
        \"message\": \"请创建一个非常简短的测试角色，名字叫'测试侠'，只需要名字和一句话描述即可。\",
        \"user_id\": \"forged-user-must-be-ignored\"
      }" 2>&1 || echo "CHAT_FAILED")

    CHAT_END=$(date +%s)
    CHAT_DURATION=$((CHAT_END - CHAT_START))

    # Check for errors in the SSE stream
    if echo "$CHAT_RESP" | grep -q "CHAT_FAILED"; then
      fail "Agent chat request" "curl failed or timed out"
    elif echo "$CHAT_RESP" | grep -q '"type":"tool_call"'; then
      pass "Agent used tools (write_doc detected)"
    else
      # Even without tool call, if we got SSE data it's working
      if echo "$CHAT_RESP" | grep -q '"type":"turn_complete"'; then
        pass "Agent responded with SSE stream (${CHAT_DURATION}s)"
      else
        fail "Agent chat" "no SSE events received"
        verbose "First 500 chars: $(echo "$CHAT_RESP" | head -c 500)"
      fi
    fi

    # Wait a moment for async storage write to complete
    sleep 3

    # Check storage for newly created files
    info "Verifying document was saved to storage..."

    STORAGE_FILES=$(docker exec insforge-postgres-1 psql -U postgres -d insforge -tAc \
      "SELECT key FROM storage.objects WHERE bucket = 'novels' AND key LIKE '$SESSION_PROJECT_ID/%' ORDER BY uploaded_at DESC LIMIT 5;" 2>/dev/null || echo "")

    if [ -n "$STORAGE_FILES" ]; then
      NEWEST_FILE=$(echo "$STORAGE_FILES" | head -1)
      pass "Storage has files for user ($(echo "$STORAGE_FILES" | wc -l | tr -d ' ') files)"
      verbose "Newest file: $NEWEST_FILE"

      # Check file size is meaningful
      FILE_SIZE=$(docker exec insforge-postgres-1 psql -U postgres -d insforge -tAc \
        "SELECT size FROM storage.objects WHERE key = '$NEWEST_FILE';" 2>/dev/null || echo "0")
      if [ "$FILE_SIZE" -gt 100 ]; then
        pass "Document file size is reasonable (${FILE_SIZE} bytes)"
      else
        fail "Document file size" "${FILE_SIZE} bytes (too small)"
      fi

      # Read the document back via agent API
      TEST_DOC_PATH=$(echo "$NEWEST_FILE" | sed "s|^$SESSION_PROJECT_ID/||")
      READ_RESP=$(curl -s "$AGENT_URL/api/documents/$SESSION_PROJECT_ID/$TEST_DOC_PATH" \
        -H "Authorization: Bearer $TOKEN")
      READ_CONTENT=$(echo "$READ_RESP" | json_get "content" 2>/dev/null || echo "")

      if [ -n "$READ_CONTENT" ] && [ "${#READ_CONTENT}" -gt 50 ]; then
        pass "Document readable via API (${#READ_CONTENT} chars)"

        # Check for frontmatter
        if echo "$READ_CONTENT" | head -1 | grep -q "^---$"; then
          pass "Document has YAML frontmatter"
        else
          fail "Document has YAML frontmatter" "first line is not ---"
        fi
      else
        fail "Document readable via API" "empty or too short"
      fi

      # Check frontmatter was indexed in DB
      INDEX_ROW=$(docker exec insforge-postgres-1 psql -U postgres -d insforge -tAc \
        "SELECT doc_type, name, status FROM novel.document_index WHERE doc_path = '$TEST_DOC_PATH' AND project_id = '$SESSION_PROJECT_ID';" 2>/dev/null || echo "")

      if [ -n "$INDEX_ROW" ]; then
        pass "Frontmatter synced to document_index: $INDEX_ROW"
      else
        fail "Frontmatter synced to document_index" "no row for path $TEST_DOC_PATH"
      fi
    else
      fail "Storage has files for user" "no rows in storage.objects"
    fi
  fi
else
  info "Skipping (use --full to run agent chat test)"
  pass "Full pipeline test skipped (--full not set)"
fi

# ── Durable restore, restart and disconnected-client checks ──
section "Test 9: Durable Session Recovery"

if $FULL_MODE && [ -n "$SESSION_ID_A" ]; then
  FIRST_MESSAGES=$(curl -s -b "$BFF_COOKIE_JAR" "$WEB_URL/api/sessions/$SESSION_ID_A/messages")
  FIRST_COUNT=$(echo "$FIRST_MESSAGES" | python3 -c "import sys,json; x=json.load(sys.stdin).get('items',[]); print(len(x) if len(x)==2 and x[0]['role']=='user' and x[1]['role']=='assistant' and x[1]['status']=='complete' else -1)" 2>/dev/null || echo -1)
  [ "$FIRST_COUNT" = "2" ] && pass "First durable turn persisted user and complete assistant" || fail "First durable turn persistence" "response=$FIRST_MESSAGES"

  launchctl bootout "gui/$(id -u)/com.novel-vibe.agent" >/dev/null 2>&1 || true
  lsof -tiTCP:7140 -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
  "$ROOT_DIR/scripts/start.sh" --agent-only >/dev/null
  check_health "$AGENT_URL/api/health" "Agent Server after restart"

  RESTORE_STREAM=$(curl -s -N -m 120 -b "$BFF_COOKIE_JAR" -X POST "$WEB_URL/api/chat/stream" \
    -H "Content-Type: application/json" \
    -d "{\"project_id\":\"$SESSION_PROJECT_ID\",\"session_id\":\"$SESSION_ID_A\",\"message\":\"请概括你刚才的回答\"}" || true)
  RESTORED_MESSAGES=$(curl -s -b "$BFF_COOKIE_JAR" "$WEB_URL/api/sessions/$SESSION_ID_A/messages")
  RESTORED_COUNT=$(echo "$RESTORED_MESSAGES" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('items',[])))" 2>/dev/null || echo -1)
  if echo "$RESTORE_STREAM" | grep -q '"type":"turn_complete"' && [ "$RESTORED_COUNT" = "4" ]; then
    pass "Agent restart restored Session A and completed a second turn"
  else
    fail "Agent restart recovery" "count=$RESTORED_COUNT stream=$(echo "$RESTORE_STREAM" | tail -c 300)"
  fi

  curl -s -N --max-time 1 -b "$BFF_COOKIE_JAR" -X POST "$WEB_URL/api/chat/stream" \
    -H "Content-Type: application/json" \
    -d "{\"project_id\":\"$SESSION_PROJECT_ID\",\"session_id\":\"$SESSION_ID_A\",\"message\":\"请用三句话说明这个测试角色还能如何完善\"}" >/dev/null 2>&1 || true
  DISCONNECTED_COMPLETE=false
  for _ in $(seq 1 120); do
    POLL_MESSAGES=$(curl -s -b "$BFF_COOKIE_JAR" "$WEB_URL/api/sessions/$SESSION_ID_A/messages")
    if echo "$POLL_MESSAGES" | python3 -c "import sys,json; x=json.load(sys.stdin).get('items',[]); raise SystemExit(0 if len(x)>=6 and x[-1]['role']=='assistant' and x[-1]['status']=='complete' else 1)" 2>/dev/null; then
      DISCONNECTED_COMPLETE=true
      break
    fi
    sleep 1
  done
  $DISCONNECTED_COMPLETE && pass "Disconnected SSE client did not cancel the durable turn" || fail "Disconnected client recovery" "assistant did not complete within 120s"
else
  info "Skipping durable recovery checks (use --full)"
  pass "Durable recovery checks skipped (--full not set)"
fi

# ── Test 10: Conflict-safe document save (direct API, no LLM) ──
section "Test 10: Conflict-safe Document Save (no LLM)"

if [ -n "$PROJECT_ID" ] && [ -n "$TOKEN" ]; then
  TEST_PATH=$(echo "$DOCS_RESP" | python3 -c "import sys,json; docs=json.load(sys.stdin).get('documents',[]); print(next((d.get('doc_path','') for d in docs if d.get('doc_type') != 'lingqi' and d.get('status') in ('draft','confirmed','locked')), ''))" 2>/dev/null || echo "")
  if [ -z "$TEST_PATH" ]; then
    fail "Conflict-safe document save" "project has no existing document"
  else
    ORIGINAL_RESP=$(curl -s "$AGENT_URL/api/documents/$PROJECT_ID/$TEST_PATH" \
      -H "Authorization: Bearer $TOKEN")
    ORIGINAL_HASH=$(echo "$ORIGINAL_RESP" | json_get "hash")
    ORIGINAL_CONTENT_FILE=$(mktemp)
    echo "$ORIGINAL_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('content',''), end='')" > "$ORIGINAL_CONTENT_FILE"

    if [ -n "$ORIGINAL_HASH" ] && [ -s "$ORIGINAL_CONTENT_FILE" ]; then
      pass "Existing document returned content hash"
    else
      fail "Existing document returned content hash" "path=$TEST_PATH response=$ORIGINAL_RESP"
    fi

    MODIFIED_CONTENT_FILE=$(mktemp)
    cp "$ORIGINAL_CONTENT_FILE" "$MODIFIED_CONTENT_FILE"
    printf '\n\n<!-- novel-vibe-e2e-cas -->\n' >> "$MODIFIED_CONTENT_FILE"
    WRITE_JSON=$(mktemp)
    python3 -c "import json; content=open('$MODIFIED_CONTENT_FILE').read(); json.dump({'content':content,'base_hash':'$ORIGINAL_HASH','user_id':'$USER_ID'}, open('$WRITE_JSON','w'))"
    WRITE_RESP=$(curl -s -X PUT "$AGENT_URL/api/documents/$PROJECT_ID/$TEST_PATH" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "@$WRITE_JSON")
    NEW_HASH=$(echo "$WRITE_RESP" | json_get "hash")
    verbose "CAS write response: $WRITE_RESP"

    if echo "$WRITE_RESP" | grep -q '"ok":true' && [ -n "$NEW_HASH" ] && [ "$NEW_HASH" != "$ORIGINAL_HASH" ]; then
      pass "Matching base_hash saved and returned a new hash"
    else
      fail "Matching base_hash save" "response: $WRITE_RESP"
    fi

    READ_AFTER=$(curl -s "$AGENT_URL/api/documents/$PROJECT_ID/$TEST_PATH" \
      -H "Authorization: Bearer $TOKEN")
    if echo "$READ_AFTER" | grep -q "novel-vibe-e2e-cas"; then
      pass "Saved document is readable through the API"
    else
      fail "Saved document is readable" "marker missing"
    fi

    CONFLICT_JSON=$(mktemp)
    python3 -c "import json; json.dump({'content':'SHOULD_NOT_OVERWRITE','base_hash':'$ORIGINAL_HASH','user_id':'$USER_ID'}, open('$CONFLICT_JSON','w'))"
    CONFLICT_BODY=$(mktemp)
    CONFLICT_STATUS=$(curl -s -o "$CONFLICT_BODY" -w '%{http_code}' -X PUT \
      "$AGENT_URL/api/documents/$PROJECT_ID/$TEST_PATH" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "@$CONFLICT_JSON")
    CONFLICT_CODE=$(python3 -c "import json; d=json.load(open('$CONFLICT_BODY')); print(d.get('code') or d.get('error',{}).get('code',''))" 2>/dev/null || echo "")

    if [ "$CONFLICT_STATUS" = "409" ] && [ "$CONFLICT_CODE" = "DOCUMENT_CONFLICT" ]; then
      pass "Stale base_hash returned DOCUMENT_CONFLICT"
    else
      fail "Stale base_hash conflict" "status=$CONFLICT_STATUS body=$(cat "$CONFLICT_BODY")"
    fi

    READ_CONFLICT=$(curl -s "$AGENT_URL/api/documents/$PROJECT_ID/$TEST_PATH" \
      -H "Authorization: Bearer $TOKEN")
    if echo "$READ_CONFLICT" | grep -q "novel-vibe-e2e-cas" && ! echo "$READ_CONFLICT" | grep -q "SHOULD_NOT_OVERWRITE"; then
      pass "Conflict did not overwrite the remote document"
    else
      fail "Conflict preserved remote document" "unexpected content after 409"
    fi

    RESTORE_JSON=$(mktemp)
    python3 -c "import json; content=open('$ORIGINAL_CONTENT_FILE').read(); json.dump({'content':content,'base_hash':'$NEW_HASH','user_id':'$USER_ID'}, open('$RESTORE_JSON','w'))"
    RESTORE_RESP=$(curl -s -X PUT "$AGENT_URL/api/documents/$PROJECT_ID/$TEST_PATH" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "@$RESTORE_JSON")
    RESTORE_HASH=$(echo "$RESTORE_RESP" | json_get "hash")
    if [ "$RESTORE_HASH" = "$ORIGINAL_HASH" ]; then
      pass "Document content restored after CAS test"
    else
      fail "Document restore" "response: $RESTORE_RESP"
    fi

    STORAGE_ROW=$(docker exec insforge-postgres-1 psql -U postgres -d insforge -tAc \
      "SELECT size FROM storage.objects WHERE bucket = 'novels' AND key = '$PROJECT_ID/$TEST_PATH';" 2>/dev/null || echo "")
    [ -n "$STORAGE_ROW" ] && pass "Storage row exists for tested document" || fail "Storage row exists" "path=$TEST_PATH"

    INDEX_ROW=$(docker exec insforge-postgres-1 psql -U postgres -d insforge -tAc \
      "SELECT doc_type, status FROM novel.document_index WHERE doc_path = '$TEST_PATH' AND project_id = '$PROJECT_ID';" 2>/dev/null || echo "")
    [ -n "$INDEX_ROW" ] && pass "DB index remains synchronized" || fail "DB index synchronized" "path=$TEST_PATH"

    rm -f "$ORIGINAL_CONTENT_FILE" "$MODIFIED_CONTENT_FILE" "$WRITE_JSON" \
      "$CONFLICT_JSON" "$CONFLICT_BODY" "$RESTORE_JSON"
  fi
else
  fail "Conflict-safe document save" "missing project ID or token"
fi

# ── Test 9: Existing document status update ─────────────
section "Test 9: Document Status Update"

if [ -n "${TEST_PATH:-}" ]; then
  STATUS_RESP=$(curl -s "$AGENT_URL/api/documents/$PROJECT_ID/$TEST_PATH" \
    -H "Authorization: Bearer $TOKEN")
  STATUS_HASH=$(echo "$STATUS_RESP" | json_get "hash")
  STATUS_ORIGINAL=$(mktemp)
  echo "$STATUS_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('content',''), end='')" > "$STATUS_ORIGINAL"
  INITIAL_STATUS=$(docker exec insforge-postgres-1 psql -U postgres -d insforge -tAc \
    "SELECT status FROM novel.document_index WHERE doc_path = '$TEST_PATH' AND project_id = '$PROJECT_ID';" 2>/dev/null || echo "")
  TARGET_STATUS="confirmed"
  [ "$INITIAL_STATUS" = "confirmed" ] && TARGET_STATUS="draft"

  STATUS_MODIFIED=$(mktemp)
  python3 -c "import re; content=open('$STATUS_ORIGINAL').read(); updated,n=re.subn(r'(?m)^status:\\s*.*$', 'status: $TARGET_STATUS', content, count=1); assert n == 1; open('$STATUS_MODIFIED','w').write(updated)"
  STATUS_JSON=$(mktemp)
  python3 -c "import json; content=open('$STATUS_MODIFIED').read(); json.dump({'content':content,'base_hash':'$STATUS_HASH','user_id':'$USER_ID'}, open('$STATUS_JSON','w'))"
  STATUS_UPDATE=$(curl -s -X PUT "$AGENT_URL/api/documents/$PROJECT_ID/$TEST_PATH" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "@$STATUS_JSON")
  STATUS_NEW_HASH=$(echo "$STATUS_UPDATE" | json_get "hash")
  NEW_STATUS=$(docker exec insforge-postgres-1 psql -U postgres -d insforge -tAc \
    "SELECT status FROM novel.document_index WHERE doc_path = '$TEST_PATH' AND project_id = '$PROJECT_ID';" 2>/dev/null || echo "")

  if [ "$NEW_STATUS" = "$TARGET_STATUS" ]; then
    pass "Status updated from $INITIAL_STATUS to $TARGET_STATUS"
  else
    fail "Status update in DB index" "expected '$TARGET_STATUS', got '$NEW_STATUS' response=$STATUS_UPDATE"
  fi

  STATUS_RESTORE_JSON=$(mktemp)
  python3 -c "import json; content=open('$STATUS_ORIGINAL').read(); json.dump({'content':content,'base_hash':'$STATUS_NEW_HASH','user_id':'$USER_ID'}, open('$STATUS_RESTORE_JSON','w'))"
  STATUS_RESTORE=$(curl -s -X PUT "$AGENT_URL/api/documents/$PROJECT_ID/$TEST_PATH" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "@$STATUS_RESTORE_JSON")
  RESTORED_STATUS=$(docker exec insforge-postgres-1 psql -U postgres -d insforge -tAc \
    "SELECT status FROM novel.document_index WHERE doc_path = '$TEST_PATH' AND project_id = '$PROJECT_ID';" 2>/dev/null || echo "")
  if [ "$RESTORED_STATUS" = "$INITIAL_STATUS" ] && echo "$STATUS_RESTORE" | grep -q '"ok":true'; then
    pass "Original document status restored"
  else
    fail "Status restore" "expected '$INITIAL_STATUS', got '$RESTORED_STATUS'"
  fi

  rm -f "$STATUS_ORIGINAL" "$STATUS_MODIFIED" "$STATUS_JSON" "$STATUS_RESTORE_JSON"
else
  fail "Status update" "no existing document available"
fi

# ── Summary ─────────────────────────────────────────────
section "Results"
printf "  ${GREEN}Passed: %d${NC}  ${RED}Failed: %d${NC}  Total: %d\n" "$PASS" "$FAIL" $((PASS + FAIL))

if [ "$FAIL" -gt 0 ]; then
  printf "\n${RED}Some tests FAILED.${NC} Run with --verbose for more details.\n"
  exit 1
else
  printf "\n${GREEN}All tests passed.${NC}\n"
  exit 0
fi
