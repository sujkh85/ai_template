#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$ROOT/src"
if [[ ! -d "$TARGET" ]]; then
  echo "[unlock-src] 없음: $TARGET"
  exit 0
fi
chmod -R u+w "$TARGET"
echo "[unlock-src] 적용됨: chmod -R u+w $TARGET"
