#!/bin/sh
# Docker entrypoint: run a handoff cycle every 15 minutes forever.
set -e

while true; do
  echo "== $(date -u +%Y-%m-%dT%H:%M:%SZ) =="
  node scripts/ai2human-handoff-create.mjs || true
  node scripts/ai2human-handoff-poll.mjs || true
  sleep 900
done
