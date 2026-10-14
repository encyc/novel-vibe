#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:9120}"
EMAIL="${SMOKE_EMAIL:?SMOKE_EMAIL is required}"
PASSWORD="${SMOKE_PASSWORD:?SMOKE_PASSWORD is required}"
COOKIE_JAR="$(mktemp)"
LOGIN_BODY="$(mktemp)"
ME_BODY="$(mktemp)"
trap 'rm -f "$COOKIE_JAR" "$LOGIN_BODY" "$ME_BODY"' EXIT

login_code="$(curl -sS -o "$LOGIN_BODY" -w "%{http_code}" \
  -c "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"mode\":\"login\"}" \
  "$BASE_URL/api/auth")"

if [ "$login_code" != "200" ]; then
  echo "login failed: HTTP $login_code"
  cat "$LOGIN_BODY"
  exit 1
fi

me_code="$(curl -sS -o "$ME_BODY" -w "%{http_code}" \
  -b "$COOKIE_JAR" \
  "$BASE_URL/api/me")"

if [ "$me_code" != "200" ]; then
  echo "me failed: HTTP $me_code"
  cat "$ME_BODY"
  exit 1
fi

cat "$ME_BODY"
echo
