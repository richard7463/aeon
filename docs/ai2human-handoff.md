# AI2Human Create Task Skill

## Purpose

AI2Human is the human execution layer for agents. This skill makes Aeon a requester: when a workflow hits a human gate — a real social account action, local verification, signature, pickup, or photo-backed proof — Aeon dispatches a structured task to AI2Human and follows it through `task -> human execution -> proof -> verify -> settle`.

This complements the existing `ai2human-reward-campaign-reconciler` watchdog:

- **reconciler** watches campaign terminal state (paid/full/closed).
- **handoff** dispatches new human-execution tasks and watches their full lifecycle.

## Runtime

Dispatch:

```text
.github/workflows/ai2human-handoff.yml  (workflow_dispatch)
```

The skill writes intent files to `.pending-ai2human/creates/`. The create script performs the credentialed API call:

```text
POST https://ai2human.io/api/agent/tasks
```

Poll:

```text
.github/workflows/ai2human-handoff.yml  (*/15 * * * *)
```

```text
GET https://ai2human.io/api/tasks/{task_id}
```

## Secrets and variables

Required secret:

```text
AI2HUMAN_AGENT_KEY
```

Optional notification secrets (same set as the reconciler):

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
DISCORD_WEBHOOK_URL
SLACK_WEBHOOK_URL
```

Optional repo variables:

```text
AI2HUMAN_BASE_URL=https://ai2human.io
AI2HUMAN_DRY_RUN=true
```

## Safety

- Intents dispatch only with `"dryRun": false`; everything else is dry-run.
- `AI2HUMAN_DRY_RUN=true` forces dry-run for all intents.
- Dispatch is idempotent: `intentId` is recorded in `.ai2human-state/tasks.json`, so re-runs never create duplicates.
- Budget, deadline, and proof requirements must come from the workflow or requester — the skill never invents them.
- The skill has no destructive paths: it never cancels, deletes, or refunds tasks.

## Manual test path

1. Write a dry-run intent:

```bash
mkdir -p .pending-ai2human/creates
cat > .pending-ai2human/creates/test-merchant.json <<'EOF'
{
  "intentId": "test-merchant-001",
  "title": "Verify Merchant X is open",
  "description": "Visit the location and confirm operations with photo + timestamp evidence.",
  "category": "local_verification",
  "rewardUsdc": 5,
  "deadlineHours": 48,
  "proofRequirements": ["photo", "timestamp"],
  "location": "123 Main St",
  "dryRun": true
}
EOF
node scripts/ai2human-handoff-create.mjs
```

Expected: intent written to `.pending-ai2human/dryrun/`, notification tagged `DRY RUN`, no API call.

2. Arm the intent (`"dryRun": false`) and dispatch for real only when the API key and a test task are acceptable.

3. Poll manually:

```bash
node scripts/ai2human-handoff-poll.mjs
```

Expected: quiet on no-op runs; a notification per transition (submitted / verified / settled / expired).

## State

```json
{
  "tasks": [
    {
      "intentId": "test-merchant-001",
      "taskId": "<uuid>",
      "title": "Verify Merchant X is open",
      "category": "local_verification",
      "taskUrl": "https://ai2human.io/tasks/<uuid>",
      "status": "live",
      "evidenceCount": 0,
      "paymentSeen": false,
      "createdAt": "...",
      "lastPolledAt": "...",
      "notified": { "created": true, "submitted": false, "verified": false, "settled": false, "expired": false }
    }
  ]
}
```

Terminal statuses stop polling: `completed`, `paid`, `closed`, `refunded`, `cancelled`, `failed`.

## State persistence

GitHub Actions checks out a fresh workspace on every run, so `.ai2human-state/tasks.json` is committed back to the repo after each create and each poll run (the workflow uses `contents: write` and pushes only when the state actually changed). This keeps notification dedup and idempotency across runs.

The state file contains only task IDs, URLs, and status snapshots — never API keys.
