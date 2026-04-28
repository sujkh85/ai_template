#!/usr/bin/env bash
set -euo pipefail

# 맥(macOS): 과거 sudo npm 등으로 ~/.npm 소유권이 깨진 경우를 선제 복구 (비밀번호 프롬프트 가능)
if [[ "$(uname -s)" == "Darwin" ]] && [[ -d "${HOME}/.npm" ]]; then
  sudo chown -R "$(whoami)" "${HOME}/.npm"
fi

pnpm run make-design && pnpm run make-task && pnpm run start
