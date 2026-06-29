#!/usr/bin/env bash
# Run Bullhorn direct CLI with plain Node (no tsx/esbuild required).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/scripts/bullhorn-direct.mjs" "$@"
