#!/usr/bin/env node

// ai2human-handoff-poll.mjs
// Watches open AI2Human tasks recorded in .ai2human-state/tasks.json and
// notifies on transitions: proof submitted -> verified -> settled -> expired.
// Quiet on clean no-op runs.

import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = (process.env.AI2HUMAN_BASE_URL || "https://ai2human.io").replace(/\/+$/, "");
const apiKey = process.env.AI2HUMAN_AGENT_KEY || process.env.AI2HUMAN_API_KEY || "";
const statePath = ".ai2human-state/tasks.json";
const logDir = "memory/logs";

const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || "";
const telegramChatId = process.env.TELEGRAM_CHAT_ID || "";
const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL || "";
const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL || "";

const TERMINAL = new Set(["completed", "paid", "closed", "refunded", "cancelled", "failed"]);
const VERIFIED_STATES = new Set(["verified", "reviewed", "completed"]);

function fail(message, details = {}) {
  const error = new Error(message);
  error.details = details;
  throw error;
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
      disable_web_page_preview: true
    })
  });
  if (response.ok) return true;
  await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: telegramChatId,
      text: message.replaceAll("*", ""),
      disable_web_page_preview: true
    })
  });
  return true;
}

async function sendWebhook(url, body) {
  if (!url) return false;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return response.ok;
}

async function notify(message) {
  const delivered = [];
  if (await sendTelegram(message).catch(() => false)) delivered.push("telegram");
  if (await sendWebhook(discordWebhookUrl, { content: message }).catch(() => false)) delivered.push("discord");
  if (await sendWebhook(slackWebhookUrl, { text: message }).catch(() => false)) delivered.push("slack");
  return delivered;
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function loadState() {
  return readJson(statePath, { tasks: [] });
}

async function saveState(state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2));
}

async function appendLog(section, lines) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    await mkdir(logDir, { recursive: true });
    await appendFile(path.join(logDir, `${today}.md`), `\n## ${section}\n${lines.map((l) => `- ${l}`).join("\n")}\n`);
  } catch (error) {
    console.error(`memory log append failed: ${error.message}`);
  }
}

function userEvidence(task) {
  const evidence = Array.isArray(task?.evidence) ? task.evidence : [];
  return evidence.filter((item) => item?.by !== "system" && item?.type !== "log");
}

function isSettled(task, payment) {
  if (payment?.txHash) return true;
  if (["paid", "completed"].includes(task?.status)) return true;
  if (["paid", "settled"].includes(payment?.status)) return true;
  return false;
}

function isVerified(task) {
  return VERIFIED_STATES.has(task?.status) || VERIFIED_STATES.has(task?.taskState);
}

function isExpired(task) {
  if (!task?.deadline) return false;
  return new Date(task.deadline).getTime() < Date.now();
}

async function checkTask(taskId) {
  if (!apiKey) fail("AI2HUMAN_AGENT_KEY is required to poll tasks");
  const response = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}`, {
    method: "GET",
    headers: { Accept: "application/json", "x-agent-api-key": apiKey }
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    fail("Task check returned non-JSON response", {
      taskId,
      status: response.status,
      body: text.slice(0, 500)
    });
  }
  if (!response.ok) {
    fail("Task check failed", { taskId, status: response.status, payload });
  }
  return payload;
}

function transitionMessages(entry, task, payment, evidence) {
  const messages = [];
  const notified = entry.notified || {};
  const evidenceCount = evidence.length;

  if (!notified.submitted && evidenceCount > 0) {
    const types = [...new Set(evidence.map((item) => item.type || "evidence"))].join(", ");
    messages.push({
      key: "submitted",
      text: [
        "*AI2Human task — proof submitted*",
        "",
        `- ${entry.title}`,
        `evidence: ${evidenceCount} item(s) — ${types}`,
        entry.taskUrl
      ].join("\n")
    });
  }

  const verified = isVerified(task);
  if (!notified.verified && verified) {
    messages.push({
      key: "verified",
      text: [
        "*AI2Human task — verified*",
        "",
        `- ${entry.title}`,
        `status: ${task?.status || task?.taskState || "verified"}`,
        entry.taskUrl
      ].join("\n")
    });
  }

  const settled = isSettled(task, payment);
  if (!notified.settled && settled) {
    const tx = payment?.txHash ? `\ntx: ${payment.txHash}` : "";
    messages.push({
      key: "settled",
      text: [
        "*AI2Human task — settled*",
        "",
        `- ${entry.title}`,
        `payment: ${payment?.status || task?.status || "paid"}${tx}`,
        entry.taskUrl
      ].join("\n")
    });
  }

  if (!notified.expired && !verified && !settled && isExpired(task)) {
    messages.push({
      key: "expired",
      text: [
        "*AI2Human task — expired*",
        "",
        `- ${entry.title}`,
        `deadline passed with no verified completion`,
        entry.taskUrl
      ].join("\n")
    });
  }

  return messages;
}

async function main() {
  const startedAt = new Date().toISOString();
  const state = await loadState();
  const open = state.tasks.filter((entry) => !TERMINAL.has(entry.status || ""));

  if (open.length === 0) {
    console.log("AI2HUMAN_HANDOFF_POLL_NO_OPEN_TASKS");
    return;
  }

  const results = await Promise.allSettled(
    open.map(async (entry) => {
      const payload = await checkTask(entry.taskId);
      const task = payload?.task || {};
      const payment = payload?.payment || null;
      const evidence = userEvidence(task);
      const messages = transitionMessages(entry, task, payment, evidence);

      entry.status = task?.status || task?.taskState || entry.status;
      entry.evidenceCount = evidence.length;
      entry.paymentSeen = Boolean(payment?.txHash || ["paid", "settled"].includes(payment?.status));
      entry.lastPolledAt = startedAt;
      entry.notified = entry.notified || {};

      for (const message of messages) {
        entry.notified[message.key] = true;
        const delivered = await notify(message.text).catch(() => []);
        console.log(
          `AI2HUMAN_HANDOFF_TRANSITION ${JSON.stringify({
            taskId: entry.taskId,
            transition: message.key,
            delivered
          })}`
        );
      }

      if (TERMINAL.has(entry.status)) {
        entry.closedAt = startedAt;
      }
      return { entry, messages };
    })
  );

  await saveState(state);

  const transitions = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value.messages.map((m) => m.key) : []
  );
  const failures = results.filter((result) => result.status === "rejected");

  if (failures.length > 0) {
    const message = [
      "*AI2Human handoff poll — partial failure*",
      "",
      `checked: ${startedAt}`,
      `open tasks: ${open.length}`,
      `failed: ${failures.length}`,
      "",
      ...failures.map((failure, index) => {
        const error = failure.reason;
        return `- ${open[index]?.taskId || "?"}: ${error?.message || "unknown error"}`;
      })
    ].join("\n");
    await notify(message);
  }

  if (transitions.length > 0) {
    await appendLog("AI2Human Handoff — Poll", [
      `checked: ${startedAt}`,
      `open tasks: ${open.length}`,
      `transitions: ${transitions.join(", ")}`
    ]);
  }

  console.log(
    `AI2HUMAN_HANDOFF_POLL ${JSON.stringify({
      checkedAt: startedAt,
      open: open.length,
      transitions,
      failed: failures.length
    })}`
  );
}

main().catch((error) => {
  const message = [
    "*AI2Human handoff poll failed*",
    "",
    `error: ${error?.message || "unknown error"}`,
    error?.details ? `details: ${JSON.stringify(error.details).slice(0, 900)}` : ""
  ]
    .filter(Boolean)
    .join("\n");
  console.error(message);
  notify(message).catch(() => {});
  process.exitCode = 1;
});
