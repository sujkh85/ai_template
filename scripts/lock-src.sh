#!/usr/bin/env bash
# 같은 사용자로 도는 CLI 에이전트가 실수로 src를 쓰지 못하게 사용자 쓰기 비트를 뺍니다.
# 개발 시 편집하려면: pnpm run unlock:src
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$ROOT/src"
if [[ ! -d "$TARGET" ]]; then
  echo "[lock-src] 없음: $TARGET"
  exit 0
fi
chmod -R u-w "$TARGET"
echo "[lock-src] 적용됨: chmod -R u-w $TARGET"
echo "[lock-src] 해제: pnpm run unlock:src"
