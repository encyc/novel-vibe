#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

npm --prefix packages/novel-web test -- --run src/community-seo.test.ts
sh scripts/test-seo-routing.sh

if [ -f lingqi-web/test-seo.sh ]; then
  sh lingqi-web/test-seo.sh
else
  echo "landing SEO check skipped: independent lingqi-web repository is not present"
fi

echo "SEO checks passed"
