#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${GH_WEBHOOK_SECRET:?set in .env}"
: "${MARS_REPO:?set in .env}"
: "${SMEE_URL:?set in .env}"

PORT="${PORT:-7878}"

cleanup() { kill 0 2>/dev/null || true; }
trap cleanup EXIT INT TERM

bun run server.ts &
npx --yes smee-client --url "$SMEE_URL" --target "http://localhost:${PORT}" &

wait
