#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  echo "entropy report test failed: $*" >&2
  exit 1
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  grep -Fq -- "$needle" <<<"$haystack" || fail "missing: $needle"
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  if grep -Fq -- "$needle" <<<"$haystack"; then
    fail "unexpected: $needle"
  fi
}

fixture="$TMP_DIR/repo"
mkdir -p \
  "$fixture/scripts" \
  "$fixture/docs/entropy" \
  "$fixture/packages/novel-agents" \
  "$fixture/packages/novel-web/src" \
  "$fixture/packages/novel-webui/src" \
  "$fixture/packages/novel-desktop/src" \
  "$fixture/packages/novel-mcp/src" \
  "$fixture/fake-bin"
cp "$ROOT_DIR/scripts/entropy-report.sh" "$fixture/scripts/entropy-report.sh"
printf '%s\n' 'export const agent = true;' > "$fixture/packages/novel-agents/server.ts"
printf '%s\n' 'export const web = true;' > "$fixture/packages/novel-web/src/server.ts"
printf '%s\n' 'export const ui = true;' > "$fixture/packages/novel-webui/src/main.ts"
printf '%s\n' 'export const uiProject = true;' > "$fixture/packages/novel-webui/src/Project Types.ts"
printf '%s\n' 'export const desktop = true;' > "$fixture/packages/novel-desktop/src/main.ts"
printf '%s\n' 'export const mcp = true;' > "$fixture/packages/novel-mcp/src/main.ts"

cat > "$fixture/fake-bin/git" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"rev-parse --short HEAD"* ]]; then
  echo abc1234
elif [[ "$*" == *"--name-only"* ]]; then
  if [[ "${ENTROPY_FAKE_EMPTY:-0}" == "1" ]]; then
    exit 0
  fi
  printf '%s\n' \
    packages/novel-agents/server.ts \
    packages/novel-agents/server.ts \
    'packages/novel-webui/src/Project Types.ts'
elif [[ "$*" == *"--oneline"* && "$*" == *"server.ts"* ]]; then
  printf '%s\n' one
elif [[ "$*" == *"--oneline"* && "$*" == *"Project Types.ts"* ]]; then
  printf '%s\n' one two three
else
  exit 1
fi
SHIM
chmod +x "$fixture/fake-bin/git"

cat > "$fixture/fake-bin/npx" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"knip --version"* ]]; then
  echo 6.32.2
else
  seq 1 65 | sed 's/^/knip-line-/'
  echo KNIP_FINAL_MARKER
  exit 1
fi
SHIM
chmod +x "$fixture/fake-bin/npx"

cat > "$fixture/docs/entropy/2030-04.md" <<'REPORT'
# 逆熵报告 2030-04

## 3. 各包 LOC

| 包 | src 行数 | 较上月 |
|---|---:|---:|
| novel-agents | 0 | — |
| novel-web | 3 | — |
REPORT

output=$(
  cd "$fixture"
  PATH="$fixture/fake-bin:$PATH" \
    ENTROPY_REPORT_DATE=2030-05 \
    ENTROPY_REPORT_SINCE=2029-11-01 \
    ./scripts/entropy-report.sh --top 2 --knip --stdout
)

assert_contains "$output" '# 逆熵报告 2030-05'
assert_contains "$output" '统计窗口：2029-11-01 至今'
assert_contains "$output" '| 2 | `packages/novel-agents/server.ts` |'
assert_contains "$output" '| 1 | `packages/novel-webui/src/Project Types.ts` |'
assert_contains "$output" 'KNIP_FINAL_MARKER'
assert_not_contains "$output" '| 3 | `packages/novel-webui/src/Project Types.ts` |'
assert_contains "$output" '| 包 | src 行数 | 较上月 |'
assert_contains "$output" '| novel-agents | 1 | +1 |'
assert_contains "$output" '| novel-web | 1 | -2 |'
assert_contains "$output" '| novel-mcp | 1 | new |'

server_line=$(grep -nF '| 2 | `packages/novel-agents/server.ts` |' <<<"$output" | cut -d: -f1 | head -1)
types_line=$(grep -nF '| 1 | `packages/novel-webui/src/Project Types.ts` |' <<<"$output" | cut -d: -f1 | head -1)
[[ "$server_line" -lt "$types_line" ]] || fail "churn rows are not sorted by displayed count"

empty_output=$(
  cd "$fixture"
  PATH="$fixture/fake-bin:$PATH" \
    ENTROPY_FAKE_EMPTY=1 \
    ENTROPY_REPORT_DATE=2030-05 \
    ENTROPY_REPORT_SINCE=2029-11-01 \
    ./scripts/entropy-report.sh --stdout
)
assert_contains "$empty_output" '## 1. 变动最频繁的文件'
assert_contains "$empty_output" '| 触碰次数 | 文件 |'

desktop_knip=$(cd "$ROOT_DIR/packages/novel-desktop" && npx --no-install knip --no-config-hints 2>&1 || true)
for false_positive in \
  'scripts/make.mjs' \
  'scripts/check.mjs' \
  '@tauri-apps/cli' \
  'cargo' \
  'Unlisted binaries'; do
  assert_not_contains "$desktop_knip" "$false_positive"
done

# The entropy runbook (`docs/entropy/README.md`) lives in the private ops repository, so this
# documentation-drift guard only runs where that material is present. The generator itself
# (`scripts/entropy-report.sh`) is public and is exercised above.
readme_path="$ROOT_DIR/docs/entropy/README.md"
if [[ -f "$readme_path" ]]; then
  readme=$(<"$readme_path")
  assert_contains "$readme" 'npm run test:entropy'
  assert_contains "$readme" '较上月'
  assert_contains "$readme" '完整输出'
else
  echo "note: docs/entropy/README.md is not present (it lives in the private ops repository) - skipping runbook assertions"
fi

echo "entropy report contract passed"
