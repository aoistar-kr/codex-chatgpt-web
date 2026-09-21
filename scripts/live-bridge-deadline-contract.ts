/**
 * Live check of the installed MCP bridge's transport-deadline path against the running daemon.
 *
 * The bridge is started exactly as the launcher starts it and asked for one Codex Native call whose
 * owner never answers, so the real 90s deadline expires. The gate requires the bridge to release the
 * invocation, the daemon to keep the turn token valid, the owner's late result to be absorbed, and
 * the same token to remain claimable afterwards. This is the production trigger path for the
 * abandoned-invocation fix, driven without depending on ChatGPT's tool-call compliance.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { callTurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import { defaultBrokerEndpoint } from "../src/config";

type JsonObject = Record<string, unknown>;

const ENDPOINT = process.env.CODEX_CHATGPT_WEB_LIVE_BROKER_ENDPOINT?.trim() || defaultBrokerEndpoint();
const CWD = process.cwd();
const appConfigPath = join(homedir(), ".codex-chatgpt-web", "config.json");
const launcherLog = join(
  process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
  "Codex Web GPT",
  "logs",
  "launcher.jsonl",
);
const logOffset = existsSync(launcherLog) ? readFileSync(launcherLog, "utf8").length : 0;

function logLines(): string[] {
  return readFileSync(launcherLog, "utf8").slice(logOffset).split(/\r?\n/).filter(Boolean);
}

function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as JsonObject;
}

/** The launcher's own runtime command, so the gate always exercises the installed artifacts. */
function installedRuntimeCommand(): string[] {
  const config = asObject(JSON.parse(readFileSync(appConfigPath, "utf8")));
  const command = config.runtimeCommand;
  if (!Array.isArray(command) || command.length < 2 || command.some(entry => typeof entry !== "string")) {
    throw new Error("the installed runtime command is unavailable");
  }
  return command as string[];
}

function toolResult(value: JsonObject): BrokerToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

const environment = {
  cwd: CWD,
  roots: [CWD],
  writableRoots: [CWD],
  sandboxPolicy: { type: "readOnly" },
  tools: [{
    name: "exec_command",
    description: "Run a command",
    parameters: {
      type: "object",
      properties: { cmd: { type: "string" }, workdir: { type: "string" }, yield_time_ms: { type: "number" } },
      required: ["cmd"],
    },
  }],
} as unknown as ChatGptTurnEnvironment;

const traceId = `live-bridge-deadline-${Date.now().toString(36)}`;
const checks: JsonObject = {};
let token: string | undefined;
let bridge: ReturnType<typeof Bun.spawn> | undefined;
let bridgeStdin: { write(chunk: string): unknown; end(): unknown } | undefined;
let bridgeStderrPromise: Promise<string> | undefined;
let bridgeStderr = "";

try {
  const status = await callTurnBroker<{ acceptingExternalOwners?: unknown }>(ENDPOINT, { method: "owner_status" }, 10_000);
  if (status.acceptingExternalOwners !== true) throw new Error("the running daemon is not accepting external owners");
  const registered = await callTurnBroker<{ token?: unknown }>(
    ENDPOINT,
    { method: "owner_register", environment, ttlMs: 300_000, traceId },
    10_000,
  );
  if (typeof registered.token !== "string") throw new Error("owner_register returned no token");
  token = registered.token;

  const [bunPath, cliPath] = installedRuntimeCommand();
  bridge = Bun.spawn([bunPath!, cliPath!, "mcp", "--broker-socket", ENDPOINT], {
    cwd: CWD,
    env: process.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  bridgeStdin = bridge.stdin as unknown as { write(chunk: string): unknown; end(): unknown };
  bridgeStderrPromise = new Response(bridge.stderr as ReadableStream).text();

  const replies = new Map<number, JsonObject>();
  const waiters = new Set<() => void>();
  void (async () => {
    const reader = (bridge!.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    while (true) {
      const { value, done } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = asObject(JSON.parse(line));
        if (typeof message.id === "number") {
          replies.set(message.id, message);
          for (const wake of [...waiters]) wake();
        }
      }
      if (done) break;
    }
  })();
  const awaitReply = async (id: number, timeoutMs: number): Promise<JsonObject | undefined> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = replies.get(id);
      if (found) return found;
      await Bun.sleep(100);
    }
    return undefined;
  };

  bridgeStdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "webgpt-live-bridge-deadline", version: "1.0.0" } },
  })}\n`);
  const initialized = await awaitReply(1, 30_000);
  checks.bridgeInitialized = Boolean(initialized && !initialized.error);
  if (!checks.bridgeInitialized) throw new Error("the installed MCP bridge did not initialize");
  bridgeStdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  // The owner never answers this call, so the bridge's own 90s deadline is the trigger.
  bridgeStdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "codex_exec", arguments: { turn_token: token, cmd: "cmd.exe /d /c echo LIVEBRIDGE" } },
  })}\n`);

  const queued = await callTurnBroker<{ requests?: Array<{ callId: string }> }>(
    ENDPOINT,
    { method: "owner_next", token },
    30_000,
  ).catch(() => undefined);
  const callId = queued?.requests?.[0]?.callId;
  checks.queuedCallId = callId ?? null;
  if (typeof callId !== "string") throw new Error("the bridge never queued a Codex Native call");

  const callReply = await awaitReply(2, 180_000);
  const callText = callReply ? JSON.stringify(callReply.result ?? callReply.error ?? {}) : "";
  checks.bridgeTimedOut = callText.includes("codex_tool_timeout");
  // The native tool finally answers. Its result has no consumer and must be absorbed.
  const completed = await callTurnBroker<{ completed?: unknown }>(ENDPOINT, {
    method: "owner_complete",
    token,
    callId,
    toolResult: toolResult({ output: "late result after the bridge deadline" }),
  }, 10_000);
  checks.lateCompletionAbsorbed = completed.completed === true;

  // The response that is still generating must still be able to claim with the same token.
  const reclaimed = await callTurnBroker<{ bindingId: string }>(ENDPOINT, { method: "claim", token }, 10_000);
  checks.tokenStillClaimable = typeof reclaimed.bindingId === "string" && reclaimed.bindingId.length > 0;
} catch (error) {
  checks.error = String((error as Error)?.message ?? error).slice(0, 300);
} finally {
  if (token) await callTurnBroker(ENDPOINT, { method: "owner_revoke", token }, 10_000).catch(() => {});
  if (bridge) {
    bridgeStdin?.end();
    const exited = await Promise.race([bridge.exited, Bun.sleep(5_000).then(() => null)]);
    if (exited === null) bridge.kill();
  }
  // The bridge logs its own deadline to stderr, which only closes once the process exits.
  bridgeStderr = await Promise.race([
    bridgeStderrPromise ?? Promise.resolve(""),
    Bun.sleep(5_000).then(() => ""),
  ]).catch(() => "");
}

await Bun.sleep(500);
const lines = logLines();
checks.bridgeStderrDeadline = bridgeStderr.includes("did not complete within 90000ms");
const releaseWithoutRetireLog = lines
  .filter(line => line.includes("released binding") && line.includes("without retiring the turn")).length;
const absorbedLog = lines.filter(line => line.includes("absorbed late result for released call=")).length;
const retiredTokenRejections = lines
  .filter(line => line.includes("valid=false") && line.includes("retiredTurn=") && line.includes(traceId)).length;

const verdict = {
  live_bridge_deadline_pass: checks.bridgeInitialized === true
    && typeof checks.queuedCallId === "string"
    && checks.bridgeTimedOut === true
    && checks.bridgeStderrDeadline === true
    && checks.lateCompletionAbsorbed === true
    && checks.tokenStillClaimable === true
    && releaseWithoutRetireLog >= 1
    && absorbedLog >= 1
    && retiredTokenRejections === 0
    && checks.error === undefined,
  ...checks,
  releaseWithoutRetireLog,
  absorbedLog,
  retiredTokenRejections,
};
process.stdout.write(`${JSON.stringify(verdict)}\n`);
if (!verdict.live_bridge_deadline_pass) process.exitCode = 1;
