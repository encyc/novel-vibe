#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

MIGRATIONS_DIR="$TMP_DIR/migrations"
FAKE_BIN="$TMP_DIR/bin"
mkdir -p "$MIGRATIONS_DIR" "$FAKE_BIN"
touch "$MIGRATIONS_DIR/003.sql" "$MIGRATIONS_DIR/001.sql" "$MIGRATIONS_DIR/002.sql"

expected=$'001.sql\n002.sql\n003.sql'
actual=$(MIGRATIONS_DIR="$MIGRATIONS_DIR" "$ROOT_DIR/scripts/run-migrations.sh" --list)
if [[ "$actual" != "$expected" ]]; then
  echo "migration list was not sorted" >&2
  diff -u <(printf '%s\n' "$expected") <(printf '%s\n' "$actual")
  exit 1
fi

cat > "$FAKE_BIN/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "ps" ]]; then
  echo "fake-postgres"
  exit 0
fi

if [[ "${1:-}" == "exec" ]]; then
  input=$(cat)
  printf '%s\n' "$input" >> "$DOCKER_INPUT_LOG"
  [[ "$input" != "002" ]]
  exit
fi

echo "unexpected docker invocation: $*" >&2
exit 2
SH
chmod +x "$FAKE_BIN/docker"

printf '001' > "$MIGRATIONS_DIR/001.sql"
printf '002' > "$MIGRATIONS_DIR/002.sql"
printf '003' > "$MIGRATIONS_DIR/003.sql"

DOCKER_INPUT_LOG="$TMP_DIR/docker-input.log"
export DOCKER_INPUT_LOG
if MIGRATIONS_DIR="$MIGRATIONS_DIR" PATH="$FAKE_BIN:$PATH" \
  "$ROOT_DIR/scripts/run-migrations.sh" >/dev/null 2>&1; then
  echo "runner should stop when psql fails" >&2
  exit 1
fi

expected_inputs=$'001\n002'
actual_inputs=$(cat "$DOCKER_INPUT_LOG")
if [[ "$actual_inputs" != "$expected_inputs" ]]; then
  echo "runner did not stop at the first failed migration" >&2
  diff -u <(printf '%s\n' "$expected_inputs") <(printf '%s\n' "$actual_inputs")
  exit 1
fi

echo "run-migrations tests passed"
