#!/usr/bin/env bash
# scripts/dev.sh — local development. Tries `bun` first, falls back to `node`.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8080}" \
HOST="${HOST:-127.0.0.1}" \
APEX_PI_DATA="${APEX_PI_DATA:-./data}" \
exec bun --hot run src/cli.ts "$@"
