import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type JsonObject = Record<string, unknown>;

const DEFAULT_TIMEOUT_MS = 180_000;
const ACTIVE_POLL_MS = 250;
const BASE_URL = process.env.CODEX_CHATGPT_WEB_LIVE_BASE_URL?.trim() || "http://127.0.0.1:17841";
const CODEX_BIN = resolve(
  process.env.CODEX_CHATGPT_WEB_LIVE_CODEX_BIN?.trim()
    || join(homedir(), ".codex-chatgpt-web", "bin", "codex-webgpt-proxy.exe"),
);
const CWD = resolve(process.env.CODEX_CHATGPT_WEB_LIVE_CWD?.trim() || process.cwd());
const MODEL = process.env.CODEX_CHATGPT_WEB_LIVE_MODEL?.trim() || "webgpt/chatgpt-web-high";
const INTERRUPT_ONLY = process.env.CODEX_CHATGPT_WEB_LIVE_INTERRUPT_ONLY === "1";
const STEERING_ONLY = process.env.CODEX_CHATGPT_WEB_LIVE_STEERING_ONLY === "1";
const EXPECT_STEER_REJECTION = process.env.CODEX_CHATGPT_WEB_LIVE_EXPECT_STEER_REJECTION === "1";
const launcherLog = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Codex Web GPT", "logs", "launcher.jsonl");
const launcherLogOffset = existsSync(launcherLog) ? readFileSync(launcherLog, "utf8").length : 0;
function launcherEvents(): JsonObject[] {
  return readFileSync(launcherLog, "utf8").slice(launcherLogOffset).split(/\r?\n/)
    .filter(Boolean).map(line => asObject(JSON.parse(line)));
}

if (!existsSync(CODEX_BIN)) throw new Error(`Codex executable is missing: ${CODEX_BIN}`);

const child = Bun.spawn([CODEX_BIN, "app-server", "--stdio"], {
  cwd: CWD,
  env: process.env,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

let nextRequestId = 1;
const pending = new Map<number, {
  resolve: (value: JsonObject) => void;
  reject: (error: Error) => void;
}>();
const notifications: JsonObject[] = [];
const notificationWaiters = new Set<() => void>();
let stderr = "";

function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as JsonObject;
}

function stringField(value: JsonObject, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) throw new Error(`Missing string field ${key}`);
  return field;
}

function write(message: JsonObject): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

async function request(method: string, params: JsonObject, timeoutMs = 30_000): Promise<JsonObject> {
  const id = nextRequestId++;
  const result = new Promise<JsonObject>((resolveRequest, reject) => {
    pending.set(id, { resolve: resolveRequest, reject });
  });
  write({ id, method, params });
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`${method} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([result, timeout]).finally(() => pending.delete(id));
}

async function waitForNotification(
  predicate: (notification: JsonObject) => boolean,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<JsonObject> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = notifications.find(predicate);
    if (found) return found;
    await new Promise<void>((resolveWait, reject) => {
      const timeout = setTimeout(() => {
        notificationWaiters.delete(resolveWait);
        reject(new Error("notification wait timed out"));
      }, Math.min(1_000, Math.max(1, deadline - Date.now())));
      notificationWaiters.add(() => {
        clearTimeout(timeout);
        notificationWaiters.delete(resolveWait);
        resolveWait();
      });
    }).catch(error => {
      if (Date.now() >= deadline) throw error;
    });
  }
  throw new Error(`Notification did not arrive within ${timeoutMs}ms`);
}

async function health(): Promise<JsonObject> {
  const response = await fetch(`${BASE_URL}/healthz`);
  if (!response.ok) throw new Error(`healthz returned HTTP ${response.status}`);
  return asObject(await response.json());
}

async function waitForActiveTurn(): Promise<JsonObject> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    let current: JsonObject | undefined;
    try {
      current = await health();
    } catch {
      await Bun.sleep(ACTIVE_POLL_MS);
      continue;
    }
    if (Number(current.active_http_turns) > 0 && Number(current.active_browser_turns) > 0) return current;
    await Bun.sleep(ACTIVE_POLL_MS);
  }
  throw new Error("WebGPT never exposed an active HTTP + browser turn");
}

function textInput(text: string): JsonObject[] {
  return [{ type: "text", text, text_elements: [] }];
}

function notificationTurn(notification: JsonObject): JsonObject {
  return asObject(asObject(notification.params).turn);
}

function responseTurn(response: JsonObject): JsonObject {
  return asObject(asObject(response.result).turn);
}

function finalText(threadId: string, turnId: string): string {
  return notifications
    .filter(notification => notification.method === "item/agentMessage/delta")
    .map(notification => asObject(notification.params))
    .filter(params => params.threadId === threadId && params.turnId === turnId)
    .map(params => typeof params.delta === "string" ? params.delta : "")
    .join("");
}

function rolloutEvidence(path: string, turnId: string): {
  commentaryItems: number;
  functionCalls: number;
  customToolCalls: number;
  toolOutputs: number;
  exactAbortEvents: number;
} {
  const evidence = {
    commentaryItems: 0,
    functionCalls: 0,
    customToolCalls: 0,
    toolOutputs: 0,
    exactAbortEvents: 0,
  };
  let activeTurnId: string | undefined;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record: JsonObject;
    try {
      record = asObject(JSON.parse(line));
    } catch {
      continue;
    }
    const payload = record.payload && typeof record.payload === "object" ? asObject(record.payload) : {};
    if (record.type === "event_msg" && payload.type === "task_started" && typeof payload.turn_id === "string") {
      activeTurnId = payload.turn_id;
    }
    if (record.type === "response_item" && activeTurnId === turnId
      && payload.type === "message" && payload.phase === "commentary") {
      evidence.commentaryItems += 1;
    }
    if (record.type === "response_item" && activeTurnId === turnId && payload.type === "function_call") {
      evidence.functionCalls += 1;
    }
    if (record.type === "response_item" && activeTurnId === turnId && payload.type === "custom_tool_call") {
      evidence.customToolCalls += 1;
    }
    if (record.type === "response_item" && activeTurnId === turnId
      && (payload.type === "function_call_output" || payload.type === "custom_tool_call_output")) {
      evidence.toolOutputs += 1;
    }
    if (record.type === "event_msg" && payload.type === "turn_aborted" && payload.turn_id === turnId) {
      evidence.exactAbortEvents += 1;
    }
    if (record.type === "event_msg"
      && (payload.type === "task_complete" || payload.type === "turn_aborted")
      && payload.turn_id === activeTurnId) {
      activeTurnId = undefined;
    }
  }
  return evidence;
}

async function waitForRolloutEvidence(
  path: string,
  turnId: string,
  predicate: (evidence: ReturnType<typeof rolloutEvidence>) => boolean,
  timeoutMs = 10_000,
): Promise<ReturnType<typeof rolloutEvidence>> {
  const deadline = Date.now() + timeoutMs;
  let evidence = rolloutEvidence(path, turnId);
  while (!predicate(evidence) && Date.now() < deadline) {
    await Bun.sleep(100);
    evidence = rolloutEvidence(path, turnId);
  }
  return evidence;
}

function consumeStdoutLine(line: string): void {
  if (!line.trim()) return;
  let message: JsonObject;
  try {
    message = asObject(JSON.parse(line));
  } catch {
    return;
  }
  if (typeof message.id === "number") {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message);
    return;
  }
  if (typeof message.method === "string") {
    notifications.push(message);
    for (const wake of [...notificationWaiters]) wake();
  }
}

void (async () => {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  while (true) {
    const { value, done } = await reader.read();
    buffered += decoder.decode(value, { stream: !done });
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) consumeStdoutLine(line);
    if (done) break;
  }
  if (buffered) consumeStdoutLine(buffered);
})();

void new Response(child.stderr).text().then(text => { stderr = text; });

try {
  const initialHealth = await health();
  if (Number(initialHealth.active_http_turns) || Number(initialHealth.active_browser_turns)) {
    throw new Error("Live control validation requires an idle daemon");
  }
  const initialDaemonPid = Number(initialHealth.pid);
  await request("initialize", {
    clientInfo: { name: "webgpt-live-active-turn-control", version: "1.0.0" },
    capabilities: { experimentalApi: true },
  });
  write({ method: "initialized", params: {} });

  const threadResponse = await request("thread/start", {
    cwd: CWD,
    model: MODEL,
    approvalPolicy: "never",
    sandbox: "read-only",
    ephemeral: false,
  });
  const thread = asObject(asObject(threadResponse.result).thread);
  const threadId = stringField(thread, "id");
  const rolloutPath = stringField(thread, "path");

  let realToolCalls = 0;
  let toolOutputs = 0;
  let commentaryItems = 0;
  let syntheticToolCalls = 0;
  let steeredAnswerCopies = 0;
  let interruptTurnId: string | undefined;
  if (!INTERRUPT_ONLY) {
  if (!STEERING_ONLY) {
  const toolStart = await request("turn/start", {
    threadId,
    cwd: CWD,
    model: MODEL,
    approvalPolicy: "never",
    input: textInput(
      "Use the available command execution tool exactly once to run cmd.exe /d /c echo WEBGPT_REAL_TOOL_OK. "
      + "After the real tool result arrives, reply with exactly TOOLLIVEOK.",
    ),
  });
  const toolTurnId = stringField(responseTurn(toolStart), "id");
  const toolCompleted = await waitForNotification(notification => {
    if (notification.method !== "turn/completed") return false;
    const params = asObject(notification.params);
    return params.threadId === threadId && stringField(notificationTurn(notification), "id") === toolTurnId;
  });
  const toolStatus = stringField(notificationTurn(toolCompleted), "status");
  if (toolStatus !== "completed") throw new Error(`Real-tool turn ended with ${toolStatus}`);
  if (!finalText(threadId, toolTurnId).includes("TOOLLIVEOK")) {
    throw new Error("Real-tool answer marker was not observed");
  }
  const toolRollout = await waitForRolloutEvidence(
    rolloutPath,
    toolTurnId,
    evidence => evidence.functionCalls + evidence.customToolCalls >= 1 && evidence.toolOutputs >= 1,
  );
  realToolCalls = toolRollout.functionCalls + toolRollout.customToolCalls;
  toolOutputs = toolRollout.toolOutputs;
  if (realToolCalls < 1 || toolRollout.toolOutputs < 1) {
    throw new Error(`Real tool round was not recorded: calls=${realToolCalls} outputs=${toolRollout.toolOutputs}`);
  }
  }

  const steeringStart = await request("turn/start", {
    threadId,
    cwd: CWD,
    model: MODEL,
    approvalPolicy: "never",
    input: textInput(
      process.env.CODEX_CHATGPT_WEB_LIVE_STEERING_PROMPT
      || "Do not use tools. Draft a deliberately very long answer with at least 120 numbered sections, then end with ORIGINAL_LIVE_DONE.",
    ),
  });
  const steeringTurnId = stringField(responseTurn(steeringStart), "id");
  await waitForActiveTurn();
  await Bun.sleep(Number(process.env.CODEX_CHATGPT_WEB_LIVE_STEERING_DELAY_MS || 750));
  const steerResponse = await request("turn/steer", {
    threadId,
    expectedTurnId: steeringTurnId,
    input: textInput("Replace the active instruction. Do not use tools. Reply with exactly STEER_LIVE_OK."),
  });
  const steeredTurnId = stringField(asObject(steerResponse.result), "turnId");
  if (steeredTurnId !== steeringTurnId) throw new Error("turn/steer changed the logical turn id");

  if (EXPECT_STEER_REJECTION) {
    await waitForNotification(notification => {
      if (notification.method !== "item/agentMessage/delta") return false;
      const params = asObject(notification.params);
      return params.threadId === threadId && params.turnId === steeringTurnId
        && typeof params.delta === "string" && params.delta.includes("new instruction was not submitted");
    }, 30_000);
    const active = await health();
    if (Number(active.active_browser_turns) !== 1) throw new Error("Rejected steering ended the original browser");
    const events = launcherEvents();
    const started = events.filter(event => event.event === "browser.turn_started").at(-1);
    const trace = asObject(started!.detail).traceId;
    if (events.some(event => asObject(event.detail ?? {}).traceId === trace
      && ["browser.turn_stop_requested", "browser.tab_released", "browser.turn_ended"].includes(String(event.event)))) {
      throw new Error("Rejected steering stopped or released its browser turn");
    }
    interruptTurnId = steeringTurnId;
  } else {
  const steeringCompleted = await waitForNotification(notification => {
    if (notification.method !== "turn/completed") return false;
    const params = asObject(notification.params);
    return params.threadId === threadId && stringField(notificationTurn(notification), "id") === steeringTurnId;
  });
  const steeringStatus = stringField(notificationTurn(steeringCompleted), "status");
  if (steeringStatus !== "completed") throw new Error(`Steering turn ended with ${steeringStatus}`);
  const steeringText = finalText(threadId, steeringTurnId);
  // Codex delivers the browser Markdown with its own escaping, so the marker is compared on a
  // de-escaped copy. Each occurrence is counted: a duplicated answer means two observers of the same
  // native round both delivered it to one Codex turn.
  const steeringPlain = steeringText.replace(/\\(?=[^A-Za-z0-9])/g, "");
  steeredAnswerCopies = steeringPlain.split("STEER_LIVE_OK").length - 1;
  if (!steeringPlain.includes("STEER_LIVE_OK")) {
    throw new Error(`Steered answer marker was not observed; delivered=${JSON.stringify(steeringText.slice(0, 500))}`);
  }
  if (steeredAnswerCopies !== 1) {
    throw new Error(`Steered answer was delivered ${steeredAnswerCopies} times instead of exactly once`);
  }
  if (steeringPlain.includes("ORIGINAL_LIVE_DONE")) throw new Error("Original generation completed after steering");
  const steeringRollout = await waitForRolloutEvidence(
    rolloutPath,
    steeringTurnId,
    () => true,
  );
  // Commentary is conditional on ChatGPT exposing visible progress/status text. A short steered
  // reply may legitimately have none; answer completeness and single delivery are gated above.
  commentaryItems = steeringRollout.commentaryItems;
  syntheticToolCalls = steeringRollout.functionCalls + steeringRollout.customToolCalls;
  if (syntheticToolCalls !== 0) throw new Error("Browser progress was represented by a tool call");
  }
  }

  if (!interruptTurnId) {
  const interruptStart = await request("turn/start", {
    threadId,
    cwd: CWD,
    model: MODEL,
    approvalPolicy: "never",
    input: textInput(
      "Do not use tools. Write a deliberately very long answer with at least 160 numbered sections and do not finish early.",
    ),
  });
  interruptTurnId = stringField(responseTurn(interruptStart), "id");
  await waitForActiveTurn();
  // Exercise Stop after browser submission, rather than merely after HTTP registration.
  await Bun.sleep(Number(process.env.CODEX_CHATGPT_WEB_LIVE_INTERRUPT_DELAY_MS || 12_000));
  }
  await request("turn/interrupt", { threadId, turnId: interruptTurnId });
  const interruptCompleted = await waitForNotification(notification => {
    if (notification.method !== "turn/completed") return false;
    const params = asObject(notification.params);
    return params.threadId === threadId && stringField(notificationTurn(notification), "id") === interruptTurnId;
  });
  const interruptStatus = stringField(notificationTurn(interruptCompleted), "status");
  if (interruptStatus !== "interrupted") throw new Error(`Interrupted turn ended with ${interruptStatus}`);

  const settleDeadline = Date.now() + 30_000;
  let settled = await health();
  while ((Number(settled.active_http_turns) > 0 || Number(settled.active_browser_turns) > 0) && Date.now() < settleDeadline) {
    await Bun.sleep(ACTIVE_POLL_MS);
    settled = await health();
  }
  if (Number(settled.active_http_turns) !== 0 || Number(settled.active_browser_turns) !== 0) {
    throw new Error("Interrupted WebGPT turn did not settle to idle");
  }
  if (Number(settled.pid) !== initialDaemonPid) throw new Error("WebGPT daemon restarted during active-turn validation");
  const interruptRollout = await waitForRolloutEvidence(
    rolloutPath,
    interruptTurnId,
    evidence => evidence.exactAbortEvents >= 1,
  );
  if (interruptRollout.exactAbortEvents !== 1) {
    throw new Error(`Expected one exact turn_aborted event, observed ${interruptRollout.exactAbortEvents}`);
  }

  const retentionDeadline = Date.now() + 20_000;
  let retained = false;
  while (Date.now() < retentionDeadline) {
    const events = launcherEvents();
    const started = events.filter(event => event.event === "browser.turn_started").at(-1);
    const trace = started && asObject(started.detail).traceId;
    if (trace && events.some(event => event.event === "browser.tab_released"
      && asObject(event.detail).traceId === trace)) throw new Error("Stop destroyed the Temporary Chat");
    retained = !!trace && events.some(event => event.event === "browser.tab_retained"
      && asObject(event.detail).traceId === trace && asObject(event.detail).status === "aborted");
    if (retained) break;
    await Bun.sleep(100);
  }
  if (!retained) throw new Error("No exact stopped Temporary Chat retention acknowledgement");

  process.stdout.write(`${JSON.stringify({
    live_run_pass: true,
    status: EXPECT_STEER_REJECTION ? "STEERING_REJECTION_PRESERVES_TURN_PASS"
      : INTERRUPT_ONLY ? "INTERRUPT_RETENTION_PASS" : "LIVE_PASS",
    temporaryChatRetained: retained,
    route: "production-provider-route",
    realToolCalls,
    realToolOutputs: toolOutputs,
    sameLogicalTurn: INTERRUPT_ONLY ? null : true,
    commentaryItems,
    fakeToolCalls: syntheticToolCalls,
    steeredAnswerCopies,
    exactAbortEvents: interruptRollout.exactAbortEvents,
    finalHealth: {
      pid: settled.pid,
      activeHttpTurns: settled.active_http_turns,
      activeBrowserTurns: settled.active_browser_turns,
    },
  })}\n`);
} finally {
  child.stdin.end();
  const exited = await Promise.race([child.exited, Bun.sleep(5_000).then(() => null)]);
  if (exited === null) child.kill();
  if (stderr.trim()) process.stderr.write(stderr);
}
