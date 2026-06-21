#!/usr/bin/env node

const endpoint =
  process.env.AI2HUMAN_CRON_ENDPOINT || "https://ai2human.work/api/cron/reward-campaigns";
const cronSecret = process.env.AI2HUMAN_CRON_SECRET || "";
const taskBaseUrl = process.env.AI2HUMAN_TASK_BASE_URL || "https://ai2human.work/tasks";
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || "";
const telegramChatId = process.env.TELEGRAM_CHAT_ID || "";
const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL || "";
const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL || "";

const startedAt = new Date().toISOString();

function fail(message, details = {}) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

function formatUpdate(update) {
  const taskId = update.taskId || update.id || "unknown-task";
  const action = update.action || "updated";
  const paid = update.paidCount ?? update.claimedCount ?? "?";
  const max = update.maxWinners ?? update.maxSlots ?? "?";
  const url = `${taskBaseUrl}/${taskId}`;
  return `- ${taskId}: ${action} (${paid}/${max} paid)\n  ${url}`;
}

function buildMessage(payload) {
  const updates = Array.isArray(payload.updates) ? payload.updates : [];
  const lines = [
    "*AI2Human reward campaign watchdog*",
    "",
    `checked: ${payload.checkedAt || startedAt}`,
    `updated: ${payload.updated ?? updates.length}`,
  ];

  if (updates.length > 0) {
    lines.push("", "State changes:");
    lines.push(...updates.map(formatUpdate));
  }

  if (payload.error) {
    lines.push("", `error: ${payload.error}`);
  }

  return lines.join("\n");
}

async function sendTelegram(message) {
  if (!telegramBotToken || !telegramChatId) return false;
  const response = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: telegramChatId,
      text: message,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }),
  });
  if (response.ok) return true;

  await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: telegramChatId,
      text: message.replaceAll("*", ""),
      disable_web_page_preview: true,
    }),
  });
  return true;
}

async function sendWebhook(url, body) {
  if (!url) return false;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.ok;
}

async function notify(message) {
  const delivered = [];
  if (await sendTelegram(message).catch(() => false)) delivered.push("telegram");
  if (await sendWebhook(discordWebhookUrl, { content: message }).catch(() => false)) {
    delivered.push("discord");
  }
  if (await sendWebhook(slackWebhookUrl, { text: message }).catch(() => false)) delivered.push("slack");
  return delivered;
}

async function callReconciler() {
  if (!cronSecret) {
    fail("AI2HUMAN_CRON_SECRET is required");
  }

  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "x-cron-secret": cronSecret,
      Authorization: `Bearer ${cronSecret}`,
    },
  });

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    fail("Reconciler returned non-JSON response", {
      status: response.status,
      body: text.slice(0, 500),
    });
  }

  if (!response.ok || payload.success === false) {
    fail("Reconciler returned failure", {
      status: response.status,
      payload,
    });
  }

  return payload;
}

async function main() {
  let payload;
  let attempt = 0;
  let lastError;

  while (attempt < 2) {
    attempt += 1;
    try {
      payload = await callReconciler();
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 8000));
      }
    }
  }

  if (!payload) {
    const message = [
      "*AI2Human reward campaign watchdog failed*",
      "",
      `checked: ${startedAt}`,
      `endpoint: ${endpoint}`,
      `error: ${lastError?.message || "unknown error"}`,
      lastError?.details ? `details: ${JSON.stringify(lastError.details).slice(0, 900)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const delivered = await notify(message);
    console.error(message);
    console.error(`notified: ${delivered.join(",") || "none"}`);
    process.exit(1);
  }

  const updates = Array.isArray(payload.updates) ? payload.updates : [];
  const updated = Number(payload.updated ?? updates.length);
  console.log(JSON.stringify(payload, null, 2));

  if (updated > 0 || updates.length > 0) {
    const message = buildMessage(payload);
    const delivered = await notify(message);
    console.log(`notified: ${delivered.join(",") || "none"}`);
  } else {
    console.log("AI2Human reward campaign watchdog: no campaign state changes.");
  }
}

main().catch(async (error) => {
  const message = [
    "*AI2Human reward campaign watchdog crashed*",
    "",
    `checked: ${startedAt}`,
    `endpoint: ${endpoint}`,
    `error: ${error.message}`,
  ].join("\n");
  await notify(message).catch(() => {});
  console.error(error);
  process.exit(1);
});
