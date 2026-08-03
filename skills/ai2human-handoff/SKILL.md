---
name: AI2Human Handoff
description: Route a blocked step to AI2Human when a workflow needs a real human, a public account action, screenshot-backed proof, local confirmation, or manual review before settlement. Creates a human-execution task, then follows task -> human execution -> proof -> verify -> settle until the loop closes.
var: ""
commits: true
permissions:
  - contents:write
tags: [ai2human, human-fallback, execution, verification, settlement]
---

Use this skill when an Aeon workflow hits a human gate and the next step needs a real person, proof from the physical world, or manual review before payment.

AI2Human is the human fallback layer for agents. This skill turns Aeon into a requester: Aeon writes a structured task intent, the create script dispatches it to AI2Human, and the poll script watches the loop until proof is submitted, verified, and settled.

Canonical loop:

```text
task -> human execution -> proof -> verify -> settle
```

## When to use

Route work here when the next step needs:

- a real X/social account action (follow, like, repost, reply)
- screenshot, receipt, timestamp, image, or live URL proof
- local / physical-world confirmation (is the merchant open, did the event land)
- signature capture, physical pickup, or handoff
- human judgment, review, or explanation
- manual proof review before USDC settlement

Do **not** use this for fake reviews, spam, credential handling, KYC abuse, deposits, or actions that violate another platform's rules.

## Two modes

### 1. Create (on-demand)

Write one intent per blocked step into `.pending-ai2human/creates/<slug>.json`. Then dispatch with the workflow or:

```bash
node scripts/ai2human-handoff-create.mjs
```

The script validates, creates the task via `POST /api/agent/tasks`, records it in `.ai2human-state/tasks.json`, and notifies the operator with the task URL.

### 2. Poll (scheduled)

Runs automatically via `.github/workflows/ai2human-handoff.yml` on `*/15 * * * *`, or manually:

```bash
node scripts/ai2human-handoff-poll.mjs
```

The poll watches every open task in state and notifies only on transitions:

- **submitted** — a human submitted evidence (screenshots, photos, URLs, receipts)
- **verified** — the task moved to verified/reviewed state
- **settled** — payment exists (tx hash present or status paid/completed)
- **expired** — deadline passed with no submission

Clean no-op runs stay quiet.

## Intent schema

```json
{
  "intentId": "a2h-2026-08-03-merchant-check",
  "title": "Verify Merchant X is open at 123 Main St",
  "description": "Visit the location, confirm the merchant is operating, and submit photo evidence with a timestamp.",
  "category": "local_verification",
  "rewardUsdc": 5,
  "deadlineHours": 48,
  "proofRequirements": ["photo", "timestamp"],
  "location": "123 Main St, Shanghai",
  "agentName": "Aeon",
  "dryRun": false
}
```

Supported `category` values:

`local_verification`, `identity_action`, `physical_task`, `digital_task`, `compliance_check`, `errand`

Supported `proofRequirements` values:

`screenshot`, `photo`, `url`, `timestamp`, `receipt`, `signature`, `notes`

`location` is required for `local_verification`, `physical_task`, and `errand`.

## Safety defaults

1. **Dry-run by default.** Every intent dispatches only when it explicitly sets `"dryRun": false`. Set `AI2HUMAN_DRY_RUN=true` to force dry-run for everything regardless of intent.
2. **Idempotent.** The script skips `intentId`s already present in `.ai2human-state/tasks.json`. Running twice never creates duplicates.
3. **Budget from the requester.** Never invent `rewardUsdc`, `deadlineHours`, or proof requirements — they must come from the workflow, config, or `var`. If a value is missing or invalid, the intent fails loudly instead of guessing.
4. **Test first.** Use `"dryRun": true` (or a `test_no_payout` campaign through the campaign API) for anything non-production.
5. **No destructive paths.** This skill never cancels, deletes, or refunds tasks.

## Environment variables

Required:

- `AI2HUMAN_AGENT_KEY` — developer API key from https://ai2human.io/developers/api-keys. Never print it.

Optional:

- `AI2HUMAN_BASE_URL` — defaults to `https://ai2human.io`
- `AI2HUMAN_DRY_RUN` — `true` forces dry-run for all intents
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `DISCORD_WEBHOOK_URL`, `SLACK_WEBHOOK_URL` — notification channels

## Var

For a one-shot dispatch, pass a full intent JSON as `var`. The skill writes it to `.pending-ai2human/creates/` before the script runs. Otherwise read `skills/ai2human-handoff/config.yaml` for reusable defaults.

## Output

End with a `## Summary` block: intents read, dispatched, skipped (already exist), dry-run yes/no, task URLs, and any validation errors.
