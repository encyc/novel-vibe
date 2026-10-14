#!/usr/bin/env bash
# 本地栈 novel-bench 用户供给：创建（或复用）bench 用户 + 授予 unlimited_projects 会员。
# 仅用于本地开发栈；凭据落在 packages/novel-bench/.env（gitignored）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$ROOT/packages/novel-bench/.env"
INSFORGE="${INSFORGE_URL:-http://localhost:7130}"

if [[ ! -f "$ENV_FILE" ]]; then
  PASSWORD="$(openssl rand -hex 12)"
  cat > "$ENV_FILE" <<ENV
BENCH_EMAIL=bench@local.test
BENCH_PASSWORD=$PASSWORD
BENCH_PROVIDER=byok-deepseek
BENCH_MODEL=deepseek-flash
ENV
  echo "已生成 $ENV_FILE"
fi

# shellcheck disable=SC1090
source "$ENV_FILE"

# 1) 创建用户（已存在则复用）
CREATE_RESPONSE="$(curl -s -X POST "$INSFORGE/api/auth/users?client_type=server" \
  -H 'content-type: application/json' \
  -H 'x-api-key: test' \
  -d "{\"email\":\"$BENCH_EMAIL\",\"password\":\"$BENCH_PASSWORD\",\"name\":\"bench\"}" || true)"
USER_ID="$(echo "$CREATE_RESPONSE" | sed -n 's/.*"id":"\([0-9a-f-]\{36\}\)".*/\1/p' | head -1)"
if [[ -z "$USER_ID" ]]; then
  USER_ID="$(docker exec insforge-postgres-1 psql -U postgres -d insforge -t -A -c \
    "SELECT id FROM auth.users WHERE email='$BENCH_EMAIL' LIMIT 1;")"
fi
if [[ -z "$USER_ID" ]]; then
  echo "无法定位 bench 用户 id（响应：$CREATE_RESPONSE）" >&2
  exit 1
fi
echo "bench 用户：$BENCH_EMAIL ($USER_ID)"

# 2) 验证登录（密码正确性）
LOGIN_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$INSFORGE/api/auth/sessions?client_type=server" \
  -H 'content-type: application/json' -d "{\"email\":\"$BENCH_EMAIL\",\"password\":\"$BENCH_PASSWORD\"}")"
if [[ "$LOGIN_CODE" != "200" ]]; then
  echo "登录验证失败（HTTP $LOGIN_CODE）：若用户已存在且密码不同，请删除 packages/novel-bench/.env 后重跑，或改用已存在用户。" >&2
  exit 1
fi

# 3) 授予会员（幂等：已有生效会员则跳过）
ACTIVE="$(docker exec insforge-postgres-1 psql -U postgres -d insforge -t -A -c \
  "SELECT count(*) FROM novel.membership_purchases WHERE user_id='$USER_ID' AND payment_status='completed' AND expires_at > now();")"
if [[ "$ACTIVE" != "0" ]]; then
  echo "该用户已有生效会员，跳过授予"
else
  docker exec insforge-postgres-1 psql -U postgres -d insforge -c "
    INSERT INTO novel.membership_purchases
      (user_id, out_trade_no, plan_name_snapshot, price_cents, duration_days_snapshot,
       bonus_credits_snapshot, features_snapshot, payment_provider, payment_status,
       expires_at, completed_at, source)
    VALUES
      ('$USER_ID', 'bench-local-provision', 'bench-local', 0, 365,
       0, '[\"unlimited_projects\",\"export\",\"web_search\",\"continuity\",\"byok\"]', 'bench', 'completed',
       now() + interval '365 days', now(), 'gift');"
  echo "已授予 unlimited_projects 会员（365 天）"
fi
docker exec insforge-postgres-1 psql -U postgres -d insforge -c "INSERT INTO novel.credit_balances (user_id, balance, total_granted, level, multiplier) VALUES ('$USER_ID', 100000, 100000, 0, 1.00) ON CONFLICT (user_id) DO UPDATE SET balance = 100000, total_granted = 100000;" >/dev/null
# 4) BYOK：存一把加密的 deepseek key（计费走用户自有 key，绕开平台扣费 RPC）
set -a; source "$ROOT/packages/novel-agents/.env"; set +a
ENCRYPTED="$(npx tsx --eval "
import { encryptByokSecret } from './packages/novel-agents/lib/crypto.ts';
process.stdout.write(encryptByokSecret(process.env.DEEPSEEK_API_KEY ?? ''));
")"
KEY_LAST4="${DEEPSEEK_API_KEY: -4}"
docker exec insforge-postgres-1 psql -U postgres -d insforge -c "
  UPDATE novel.user_llm_keys SET revoked_at = now() WHERE user_id='$USER_ID' AND provider='deepseek' AND revoked_at IS NULL;
  INSERT INTO novel.user_llm_keys (user_id, provider, encrypted_key, key_last4)
  VALUES ('$USER_ID', 'deepseek', '$ENCRYPTED', '$KEY_LAST4');"
docker exec insforge-postgres-1 psql -U postgres -d insforge -c "
  UPDATE novel.membership_purchases SET features_snapshot = '[\"unlimited_projects\",\"export\",\"web_search\",\"continuity\",\"byok\"]'::jsonb
  WHERE user_id='$USER_ID' AND payment_status='completed';" >/dev/null
echo "供给完成（含本地余额与 BYOK deepseek key）。"
