#!/usr/bin/env bash
# Run Bullhorn direct CLI without pnpm's pre-command install hook.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TSX="$ROOT/node_modules/.bin/tsx"
if [[ ! -x "$TSX" ]]; then
  TSX="$ROOT/scripts/node_modules/.bin/tsx"
fi
if [[ ! -x "$TSX" ]]; then
  echo "tsx not found. Run: cd \"$ROOT\" && pnpm install" >&2
  exit 1
fi
exec "$TSX" "$ROOT/scripts/src/bullhorn-direct.ts" "$@"
