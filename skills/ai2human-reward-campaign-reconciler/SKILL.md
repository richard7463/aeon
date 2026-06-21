---
name: AI2Human Reward Campaign Reconciler
description: Manually run or audit the AI2Human reward campaign watchdog that closes paid/full or expired reward campaigns.
var: ""
tags: [ai2human, rewards, ops]
---

Use this skill to inspect the AI2Human reward campaign watchdog or manually trigger the production reconciler.

## Production endpoint

Default endpoint:

```text
https://ai2human.work/api/cron/reward-campaigns
```

The endpoint requires `AI2HUMAN_CRON_SECRET`, passed as both:

```text
x-cron-secret: $AI2HUMAN_CRON_SECRET
Authorization: Bearer $AI2HUMAN_CRON_SECRET
```

Do not print the secret.

## What the reconciler does

The OmniClaw app owns the database logic. Aeon is only the watchdog.

The endpoint checks reward campaigns and updates terminal state:

- If paid claim count reaches `maxWinners`, mark the task `paid/full/completed`.
- If the deadline has passed and the campaign is not full, mark the task `closed`.
- Otherwise leave the campaign unchanged.

## Manual run

Run:

```bash
node scripts/ai2human-reward-campaign-reconciler.mjs
```

Expected behavior:

- On no-op runs, log the JSON response and do not notify.
- On state changes, send one concise notification via Telegram/Discord/Slack if configured.
- On endpoint failure, retry once, then notify the operator.

## GitHub Actions

The primary automation is:

```text
.github/workflows/ai2human-reward-campaigns.yml
```

It runs every 10 minutes and can also be triggered manually.

Required GitHub secret:

```text
AI2HUMAN_CRON_SECRET
```

Optional notification secrets:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
DISCORD_WEBHOOK_URL
SLACK_WEBHOOK_URL
```

Optional repo variables:

```text
AI2HUMAN_CRON_ENDPOINT=https://ai2human.work/api/cron/reward-campaigns
AI2HUMAN_TASK_BASE_URL=https://ai2human.work/tasks
```

## Operator notes

Stay quiet on clean no-op runs. This monitor should only interrupt the operator when it actually changed campaign state or when the watchdog failed.
