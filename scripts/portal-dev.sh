#!/usr/bin/env bash
# Local portal preview — bypasses pnpm filter (avoids ERR_PNPM_IGNORED_BUILDS on Mac).
# Usage:
#   export VITE_CLERK_PUBLISHABLE_KEY="pk_live_..."   # from Railway Variables
#   ./scripts/portal-dev.sh
#
# Then open in your BROWSER (not the terminal):
#   http://localhost:5173/portal/
#   http://localhost:5173/portal/sign-in

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-5173}"
BASE_PATH="${BASE_PATH:-/portal/}"

if [[ -z "${VITE_CLERK_PUBLISHABLE_KEY:-}" ]]; then
  echo "Set VITE_CLERK_PUBLISHABLE_KEY first (Railway → Variables → VITE_CLERK_PUBLISHABLE_KEY)." >&2
  exit 1
fi

VITE_BIN="$ROOT/artifacts/portal/node_modules/.bin/vite"
if [[ ! -x "$VITE_BIN" ]]; then
  echo "Portal deps missing. From repo root run once: pnpm install" >&2
  echo "If pnpm install fails with ERR_PNPM_IGNORED_BUILDS, run: pnpm approve-builds" >&2
  echo "  (select @clerk/shared and esbuild, then Enter)" >&2
  exit 1
fi

export PORT BASE_PATH

echo ""
echo "Portal dev server starting…"
echo "  Open in browser: http://localhost:${PORT}${BASE_PATH}"
echo "  Sign-in page:    http://localhost:${PORT}${BASE_PATH}sign-in"
echo "  Press Ctrl+C to stop."
echo ""

cd "$ROOT/artifacts/portal"
exec "$VITE_BIN" --config vite.config.ts --host 0.0.0.0
