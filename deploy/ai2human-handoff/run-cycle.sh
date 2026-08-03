#!/usr/bin/env bash
# One full handoff cycle: dispatch queued intents, then poll open tasks.
# Designed to run from cron every 15 minutes. Idempotent — safe to run on
# every cycle; no-op when there is nothing to dispatch or poll.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

mkdir -p logs

echo "== $(date -u +%Y-%m-%dT%H:%M:%SZ) =="
node scripts/ai2human-handoff-create.mjs
node scripts/ai2human-handoff-poll.mjs
