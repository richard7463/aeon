# Deploy AI2Human Create Task on a server

The handoff loop (`create` + `poll`) is plain Node.js talking to public HTTP APIs, so it runs anywhere with Node 18+ — no GitHub Actions required. This directory contains a cron-style setup and a Docker setup.

## What runs

Every 15 minutes:

1. `scripts/ai2human-handoff-create.mjs` — dispatches any intents queued in `.pending-ai2human/creates/` (dry-run unless `"dryRun": false`).
2. `scripts/ai2human-handoff-poll.mjs` — polls open tasks recorded in `.ai2human-state/tasks.json`, notifies on submitted / verified / settled / expired.

Both are idempotent and quiet on no-ops.

## Server layout

```text
/opt/ai2human-handoff/
  aeon/                    # this repo (or a sparse copy with scripts/ + deploy/)
    scripts/
    deploy/ai2human-handoff/
    .env                   # secrets, chmod 600, never committed
    .ai2human-state/       # persisted task state
    logs/
```

## Option A — cron on any Linux VPS

```bash
sudo apt-get install -y nodejs   # Node 18+ required (22 recommended)
cd /opt
git clone https://github.com/richard7463/aeon.git ai2human-handoff
cd ai2human-handoff
cp deploy/ai2human-handoff/.env.example .env
chmod 600 .env
# edit .env and set AI2HUMAN_AGENT_KEY (+ notification channels)

# dry-run smoke test (no dispatch, no API calls)
node scripts/ai2human-handoff-create.mjs

# arm the scheduler
crontab -e   # add the line from deploy/ai2human-handoff/crontab.example
```

## Option B — Docker

```bash
cd /opt/ai2human-handoff
cp deploy/ai2human-handoff/.env.example .env
chmod 600 .env
# edit .env
docker compose -f deploy/ai2human-handoff/docker-compose.yml up -d --build
docker compose -f deploy/ai2human-handoff/docker-compose.yml logs -f
```

Note: `docker-compose.yml` builds from the repo root; if you copy only `deploy/` to the server, adjust the build context so `scripts/` is present.

## Sending tasks to the server

Queue an intent and it will dispatch on the next cycle:

```bash
cat > .pending-ai2human/creates/my-task.json <<'EOF'
{
  "intentId": "my-task-001",
  "title": "...",
  "description": "...",
  "category": "digital_task",
  "rewardUsdc": 5,
  "deadlineHours": 24,
  "proofRequirements": ["screenshot"],
  "dryRun": false
}
EOF
```

Or run one cycle immediately: `./deploy/ai2human-handoff/run-cycle.sh`

## Notes

- State persists in `.ai2human-state/tasks.json` on disk — no commit-back needed (unlike GitHub Actions).
- Notifications fan out to Telegram/Discord/Slack from the `.env` values.
- Keep the same schedule as GitHub Actions (`*/15`) so both can run interchangeably; idempotency prevents duplicates.
