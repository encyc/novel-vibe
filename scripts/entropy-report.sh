#!/usr/bin/env bash
# 逆熵报告：生成代码熵况快照（churn / 体积 / LOC / 死代码）
# 用法: ./scripts/entropy-report.sh [--months N] [--top N] [--knip] [--stdout]
# 默认写入 docs/entropy/YYYY-MM.md；--stdout 时仅打印不落盘

set -euo pipefail

MONTHS=6
TOP=15
RUN_KNIP=0
STDOUT=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --months) MONTHS="$2"; shift 2 ;;
    --top) TOP="$2"; shift 2 ;;
    --knip) RUN_KNIP=1; shift ;;
    --stdout) STDOUT=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

DATE="${ENTROPY_REPORT_DATE:-$(date +%Y-%m)}"
SINCE="${ENTROPY_REPORT_SINCE:-$(date -v-${MONTHS}m +%Y-%m-%d 2>/dev/null || date -d "$MONTHS months ago" +%Y-%m-%d)}"
PREVIOUS_DATE=$(
  date -j -v-1m -f '%Y-%m-%d' "$DATE-01" +%Y-%m 2>/dev/null \
    || date -d "$DATE-01 -1 month" +%Y-%m
)
PREVIOUS_REPORT="docs/entropy/$PREVIOUS_DATE.md"

report() { printf '%s\n' "$*"; }

# ---------- 1. Git churn：近 N 月变动最频繁的文件 ----------
# 只保留自定义应用包 + 根目录脚本/配置下的源码文件
# awk 凑满 Top N 后提前 exit 会让上游 git/sort 收到 SIGPIPE；在
# pipefail 下这会以 141 杀死整条管道，故整段容错（输出不受影响）。
churn_rows=$(
  { git log --since="$SINCE" --name-only --pretty=format: \
    | awk 'NF' \
    | sort \
    | uniq -c \
    | sort -k1,1nr -k2,2 \
    | awk -v n="$TOP" '
        BEGIN { emitted = 0 }
        {
          count = $1
          sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "", $0)
          path = $0
          if (path !~ /^(packages\/novel-(agents|web|webui|desktop|mcp)\/|scripts\/|Makefile$|AGENTS\.md$)/) next
          if (path ~ /\/(dist|node_modules|coverage)\//) next
          if (path !~ /\.(ts|tsx|js|mjs|css|sh|md|rs)$/) next
          # 只统计仍存在的文件：已删除文件的历史触碰数会误导 churn 榜
          if ((getline chk < path) < 0) { close(path); next } close(path)
          printf "%s\t%s\n", count, path
          emitted++
          if (emitted >= n) exit
        }
      ' || true; }
)

# ---------- 2. 体积热点：最大的源码文件 ----------
size_hotspots=$(
  find packages -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.mjs' \) \
    -not -path '*/dist/*' -not -path '*/node_modules/*' -not -path '*/coverage/*' \
    -exec wc -l {} + \
    | grep -v ' total$' \
    | sort -rn | awk -v n="$TOP" 'NR<=n {$1=$1; print}'
)

# ---------- 3. 各包 LOC 概况 ----------
pkg_loc=$(for d in packages/*/; do
  name=$(basename "$d")
  # novel-agents 的源码在包根目录（无 src/），其余包在 src/
  root="$d/src"; [[ -d "$root" ]] || root="$d"
  loc=$(find "$root" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) \
    -not -path '*/dist/*' -not -path '*/node_modules/*' -not -path '*/coverage/*' \
    -not -name '*.test.ts' -not -name '*.test.tsx' 2>/dev/null \
    | xargs wc -l 2>/dev/null | tail -1 | awk '{print $1}')
  echo "${loc:-0} $name"
done | sort -rn)

# ---------- 4. knip 死代码扫描（可选） ----------
# 注意：knip 与 lint 工具相同，发现问题也以退出码 1 结束——
# 退出码 0/1 都算扫描成功，只有二进制不可用才跳过
knip_section="（本次未运行。运行: ./scripts/entropy-report.sh --knip）"
if [[ $RUN_KNIP -eq 1 ]]; then
  if ! npx --no-install knip --version >/dev/null 2>&1; then
    knip_section="knip 未安装（根 devDependencies: npm i -D knip），跳过。"
  else
    knip_section=""
    for ws in novel-agents novel-web novel-webui novel-desktop; do
      out=$(cd "packages/$ws" && npx --no-install knip --no-config-hints 2>&1 || true)
      knip_section="$knip_section

### $ws
\`\`\`
$out
\`\`\`"
    done
  fi
fi

# ---------- 汇总 ----------
{
  report "# 逆熵报告 $DATE"
  report ""
  report "- 统计窗口：$SINCE 至今（${MONTHS} 个月）"
  report "- 仓库 HEAD：$(git rev-parse --short HEAD)"
  report ""
  report "## 1. 变动最频繁的文件（churn Top ${TOP}）"
  report ""
  report "高 churn = 设计不稳定或职责过宽的信号。短期合理（活跃开发），长期持续高 churn 需要警惕。"
  report ""
  report "| 触碰次数 | 文件 |"
  report "|---|---|"
  while IFS=$'\t' read -r count file; do
    [[ -n "${file:-}" ]] || continue
    report "| $count | \`$file\` |"
  done <<<"$churn_rows"
  report ""
  report "## 2. 体积热点（最大源码文件 Top ${TOP}）"
  report ""
  report "| 行数 | 文件 |"
  report "|---|---|"
  echo "$size_hotspots" | while read -r lines file; do
    report "| $lines | \`$file\` |"
  done
  report ""
  report "## 3. 各包 LOC"
  report ""
  report "| 包 | src 行数 | 较上月 |"
  report "|---|---:|---:|"
  echo "$pkg_loc" | while read -r loc name; do
    delta="—"
    if [[ -f "$PREVIOUS_REPORT" ]]; then
      previous_loc=$(
        awk -F'|' -v package="$name" '
          {
            cell = $2
            gsub(/^[[:space:]]+|[[:space:]]+$/, "", cell)
            if (cell != package) next
            value = $3
            gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
            if (value ~ /^[0-9]+$/) print value
          }
        ' "$PREVIOUS_REPORT" | head -1
      )
      if [[ -z "$previous_loc" ]]; then
        delta="new"
      else
        difference=$((loc - previous_loc))
        if [[ $difference -gt 0 ]]; then
          delta="+$difference"
        else
          delta="$difference"
        fi
      fi
    fi
    report "| $name | $loc | $delta |"
  done
  report ""
  report "## 4. 死代码 / 未使用导出（knip）"
  report ""
  report "$knip_section"
  report ""
  report "## 5. 人工观察项"
  report ""
  report "- [ ] AGENTS.md 描述的机制与代码是否仍一致（文档熵）"
  report "- [ ] 包边界：业务逻辑是否渗入 novel-desktop / novel-web"
  report "- [ ] 新路由是否进 server/router.ts 路由表、新查询是否进 lib/db/ 领域模块（不再回到单体）"
  report "- [ ] webui-dist 是否与 novel-webui 构建同步"
  report "- [ ] 待精简清单（删不动的先记录，下月再看）"
} > "/tmp/entropy-$DATE.md"

if [[ $STDOUT -eq 1 ]]; then
  cat "/tmp/entropy-$DATE.md"
else
  mkdir -p docs/entropy
  cp "/tmp/entropy-$DATE.md" "docs/entropy/$DATE.md"
  echo "已写入 docs/entropy/$DATE.md"
fi
