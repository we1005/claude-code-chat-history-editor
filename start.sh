#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  printf '请先安装 Node.js 22+ 和 npm。\n' >&2
  exit 1
fi
cd "$ROOT"
if command -v pnpm >/dev/null 2>&1; then
  exec pnpm run start:editor -- "$@"
elif command -v corepack >/dev/null 2>&1; then
  exec corepack pnpm run start:editor -- "$@"
else
  exec npx --yes pnpm@9.15.9 run start:editor -- "$@"
fi
