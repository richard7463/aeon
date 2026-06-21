# AI2Human Reward Campaign Watchdog

This Aeon fork contains a lightweight production watchdog for AI2Human reward campaigns.

## Purpose

AI2Human lucky draw and reward campaign tasks should not rely on a human manually closing the task after final payment or deadline. The production app exposes a protected reconciler endpoint, and this Aeon fork calls it frequently.

## Runtime

Workflow:

```text
.github/workflows/ai2human-reward-campaigns.yml
```

Schedule:

```text
*/10 * * * *
```

That means GitHub Actions checks the campaign reconciler every 10 minutes.

## Reconciler call

Script:

```text
scripts/ai2human-reward-campaign-reconciler.mjs
```

Endpoint:

```text
GET https://ai2human.work/api/cron/reward-campaigns
```

Required secret:

```text
AI2HUMAN_CRON_SECRET
```

The script sends both headers:

```text
x-cron-secret: <secret>
Authorization: Bearer <secret>
```

## Behavior

The production endpoint handles the database updates:

- Mark campaigns `paid/full/completed` when all winners have been paid.
- Mark campaigns `closed` when the deadline has passed and slots remain unpaid.
- Leave open campaigns unchanged.

Aeon handles the operating loop:

- Calls the endpoint every 10 minutes.
- Retries once after transient failure.
- Sends Telegram/Discord/Slack notification only when a state change happens or the watchdog fails.
- Stays silent on normal no-op runs.

## Notification secrets

Optional:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
DISCORD_WEBHOOK_URL
SLACK_WEBHOOK_URL
```

Telegram is the recommended admin channel.

## Manual test

Run locally with env loaded:

```bash
AI2HUMAN_CRON_SECRET=... node scripts/ai2human-reward-campaign-reconciler.mjs
```

Expected no-op output:

```text
AI2Human reward campaign watchdog: no campaign state changes.
```

Expected update behavior:

- Script prints the JSON response.
- Notification is sent with each updated task id, action, paid count, max winners, and task URL.
