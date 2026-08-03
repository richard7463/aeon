#!/usr/bin/env node

// ai2human-handoff-create.mjs
// Dispatches queued AI2Human human-execution tasks from .pending-ai2human/creates/*.json.
// Follows the Aeon postprocess pattern: the skill writes intents, this script
// performs the credentialed API calls, then records state and notifies.

import { readdir, readFile, writeFile, mkdir, appendFile, rename } from "node:fs/promises";
import path from "node:path";

// --direct '<json>' mode: dispatch a single inline intent without the
// .pending-ai2human/creates/ directory flow. Used by skill-pack installs.
const directArgIndex = process.argv.findIndex((arg) => arg === "--direct");
const directJson = directArgIndex >= 0 ? process.argv[directArgIndex + 1] : null;

const baseUrl = (process.env.AI2HUMAN_BASE_URL || "https://ai2human.io").replace(/\/+$/, "");
const apiKey = process.env.AI2HUMAN_AGENT_KEY || process.env.AI2HUMAN_API_KEY || "";
const forceDryRun = String(process.env.AI2HUMAN_DRY_RUN || "").toLowerCase() === "true";
const createDir = ".pending-ai2human/creates";
const doneDir = ".pending-ai2human/done";
const dryDir = ".pending-ai2human/dryrun";
const statePath = ".ai2human-state/tasks.json";
const logDir = "memory/logs";

const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || "";
const telegramChatId = process.env.TELEGRAM_CHAT_ID || "";
const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL || "";
const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL || "";

const CATEGORIES = new Set([
  "local_verification",
  "identity_action",
  "physical_task",
  "digital_task",
  "compliance_check",
  "errand"
]);
const PROOF_TYPES = new Set([
  "screenshot",
  "photo",
  "url",
  "timestamp",
  "receipt",
  "signature",
  "notes"
]);
const LOCATION_CATEGORIES = new Set(["local_verification", "physical_task", "errand"]);

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

function validateIntent(intent) {
  const errors = {};
  if (!String(intent.intentId || "").trim()) errors.intentId = "intentId is required";
  if (!String(intent.title || "").trim()) errors.title = "title is required";
  if (!String(intent.description || "").trim()) errors.description = "description is required";
  if (!CATEGORIES.has(intent.category)) errors.category = `unsupported category: ${intent.category}`;
  if (!(Number(intent.rewardUsdc) > 0)) errors.rewardUsdc = "rewardUsdc must be greater than zero";
  if (!(Number(intent.deadlineHours) > 0)) errors.deadlineHours = "deadlineHours must be greater than zero";
  const proofs = Array.isArray(intent.proofRequirements) ? intent.proofRequirements : [];
  if (!proofs.length) errors.proofRequirements = "at least one proof type is required";
  if (proofs.some((item) => !PROOF_TYPES.has(item))) errors.proofRequirements = "one or more proof types are unsupported";
  if (LOCATION_CATEGORIES.has(intent.category) && !String(intent.location || "").trim()) {
    errors.location = "location is required for physical or local work";
  }
  return errors;
}

function buildPayload(intent) {
  const payload = {
    title: String(intent.title).trim(),
    description: String(intent.description).trim(),
    category: intent.category,
    reward_usdc: Number(intent.rewardUsdc),
    deadline_hours: Number(intent.deadlineHours),
    proof_requirements: [...new Set(intent.proofRequirements)]
  };
  if (String(intent.location || "").trim()) payload.location = String(intent.location).trim();
  if (String(intent.agentName || intent.requesterName || "").trim()) {
    payload.agent_name = String(intent.agentName || intent.requesterName).trim();
  }
  return payload;
}

async function createTask(intent) {
  if (!apiKey) fail("AI2HUMAN_AGENT_KEY is required to dispatch tasks");
  const response = await fetch(`${baseUrl}/api/agent/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-agent-api-key": apiKey
    },
    body: JSON.stringify(buildPayload(intent))
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    fail("Task creation returned non-JSON response", {
      status: response.status,
      body: text.slice(0, 500)
    });
  }
  if (!response.ok) {
    fail("Task creation failed", { status: response.status, payload });
  }
  return payload;
}

async function listIntentFiles() {
  try {
    const files = await readdir(createDir);
    return files.filter((file) => file.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

async function main() {
  const startedAt = new Date().toISOString();
  const state = await loadState();
  const existing = new Set(state.tasks.map((task) => task.intentId));

  const intents = [];
  if (directJson) {
    let parsed;
    try {
      parsed = JSON.parse(directJson);
    } catch (error) {
      fail("--direct payload is not valid JSON", { error: error.message });
    }
    intents.push({ file: "direct", intent: parsed });
  } else {
    const files = await listIntentFiles();
    if (files.length === 0) {
      console.log("AI2HUMAN_HANDOFF_NO_INTENTS");
      return;
    }
    for (const file of files) {
      intents.push({ file, intent: await readJson(path.join(createDir, file), {}) });
    }
  }

  const dispatched = [];
  const skipped = [];
  const dryRun = [];
  const invalid = [];

  for (const { file, intent } of intents) {
    const errors = validateIntent(intent);

    if (Object.keys(errors).length > 0) {
      invalid.push({ file, errors });
      continue;
    }

    if (existing.has(intent.intentId)) {
      skipped.push({ intentId: intent.intentId, file });
      continue;
    }

    const isDryRun = forceDryRun || intent.dryRun !== false;
    if (isDryRun) {
      await mkdir(dryDir, { recursive: true });
      await writeFile(
        path.join(dryDir, file === "direct" ? "direct.json" : file),
        JSON.stringify({ ...intent, dryRun: true, createdAt: startedAt, payload: buildPayload(intent) }, null, 2)
      );
      dryRun.push({ intentId: intent.intentId, file });
      continue;
    }

    const payload = await createTask(intent).catch((error) => {
      invalid.push({ file, errors: { api: error.message, details: error.details || {} } });
      return null;
    });
    if (!payload) continue;

    state.tasks.push({
      intentId: intent.intentId,
      taskId: payload.task_id,
      title: intent.title,
      category: intent.category,
      taskUrl: payload.task_url || `${baseUrl}/tasks/${payload.task_id}`,
      status: payload.status || "live",
      evidenceCount: 0,
      paymentSeen: false,
      createdAt: startedAt,
      lastPolledAt: null,
      notified: { created: true, submitted: false, verified: false, settled: false, expired: false }
    });
    dispatched.push({ intentId: intent.intentId, taskId: payload.task_id, taskUrl: payload.task_url });

    if (file !== "direct") {
      const intentPath = path.join(createDir, file);
      await mkdir(doneDir, { recursive: true });
      await rename(intentPath, path.join(doneDir, file)).catch(() => {});
    }
  }

  await saveState(state);

  const lines = [
    `checked: ${startedAt}`,
    `dispatched: ${dispatched.length}`,
    `dry-run: ${dryRun.length}`,
    `skipped (already exist): ${skipped.length}`,
    `invalid: ${invalid.length}`
  ];
  for (const item of dispatched) {
    lines.push(`- ${item.intentId}: ${item.taskUrl}`);
  }
  for (const item of invalid) {
    lines.push(`- ${item.file}: ${JSON.stringify(item.errors).slice(0, 500)}`);
  }
  const summary = lines.join("\n");
  console.log(`AI2HUMAN_HANDOFF_CREATE ${JSON.stringify({ dispatched, dryRun, skipped, invalid })}`);

  if (dispatched.length > 0 || dryRun.length > 0) {
    const title = forceDryRun ? "*AI2Human handoff — DRY RUN*" : "*AI2Human handoff — tasks dispatched*";
    const message = [
      title,
      "",
      `dispatched: ${dispatched.length}`,
      `dry-run: ${dryRun.length}`,
      `skipped: ${skipped.length}`,
      "",
      ...dispatched.map((item) => `- ${item.intentId}: ${item.taskUrl}`),
      ...(dryRun.length ? ["", "_dry-run intents were written to .pending-ai2human/dryrun/, no API calls made_"] : [])
    ].join("\n");
    await notify(message);
  }

  if (dispatched.length > 0 || invalid.length > 0) {
    await appendLog("AI2Human Handoff — Create", lines);
  }
}

main().catch((error) => {
  const message = [
    "*AI2Human handoff create failed*",
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
